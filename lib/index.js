/**
 * WSL bash executor for the `ctx.shell` capability seam.
 *
 * Every command runs as `wsl.exe -d <distro> -e bash -c <command>` in a
 * provider-managed range spawned through `ctx.subprocess`. The executor
 * implements the `@deepseek-ai/dsh-shell` seam contract itself (a plain service
 * object provided as `shell`) because this profile cannot resolve
 * `@deepseek-ai/dsh-shell`: a second copy of cordis would own a second,
 * incompatible `Service` identity. The observable contract therefore mirrors
 * `@deepseek-ai/dsh-bash-local` 0.2.0 exactly: request resolution with explicit
 * defaults and caps, `execute(spec)` publishing a handle after preparation,
 * deadline fusion with the `BASH_TIMEOUT` code, first-cause
 * `timedOut`/`aborted` classification, bounded collect output with spill
 * files, incremental `readOutput()` deltas, and `result()` that rejects only
 * for infrastructure failures.
 *
 * No sandboxing: `sandboxMode` is `undefined` and `ctx.sandbox` is never
 * touched. WSL cannot start inside a Windows ACL restricted token.
 *
 * @module dsh-wsl-shell
 */

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** Plugin name inside the cordis loader tree. */
export const name = 'wsl-shell';

/** Services this executor needs before it can be applied. */
export const inject = ['subprocess'];

/** Model-friendly environment for the Windows-side `wsl.exe` process. */
const ENV_OVERRIDES = {
	NO_COLOR: '1',
	TERM: 'dumb',
	PAGER: 'cat',
	GIT_PAGER: 'cat'
};

/** The capability-owned timeout code the shell seam classifies with. */
const TIMEOUT_CODE = 'BASH_TIMEOUT';

/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config). */
const DEFAULT_GRACE_MS = 3000;

/** Default cap on concurrently running `wsl.exe` processes (the `maxConcurrency` config). */
const DEFAULT_MAX_CONCURRENCY = 4;

/** Default destructive-command gate (the `guard` config): `'strict'` or `'off'`. */
const DEFAULT_GUARD = 'strict';

/** Default per-stream in-memory cap (the `maxOutputBytes` config). */
const DEFAULT_MAX_OUTPUT_BYTES = 64000;

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;

/** Default request timeout (the `timeoutMs` config). */
const DEFAULT_TIMEOUT_MS = 120000;

/** Default hard cap a caller's `timeoutMs` is clamped to (the `maxTimeoutMs` config). */
const DEFAULT_MAX_TIMEOUT_MS = 600000;

/** The Windows WSL launcher every command goes through. */
const DEFAULT_WSL_PATH = 'C:\\Windows\\System32\\wsl.exe';

/** Default WSL distribution. */
const DEFAULT_DISTRO = 'Ubuntu';

/** Default Linux-side PATH prefix prepended to the inherited PATH. */
const DEFAULT_PATH_PREFIX = '$HOME/.local/bin:/usr/local/bin';

// ---------------------------------------------------------------------------
// timeout vocabulary (mirrors @deepseek-ai/dsh-timeout, no import available)
// ---------------------------------------------------------------------------

/** Abort reason carrying a capability-owned code and the elapsed deadline. */
class TimeoutReason extends Error {
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
		this.name = 'TimeoutReason';
	}
}

/** Validate a caller's optional timeout hint, apply the default, then cap it. */
function clampTimeout(requested, fallback, max, label) {
	if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
		throw new Error(`${label} must be a positive finite number`);
	}
	return Math.min(requested ?? fallback, max);
}

/**
 * Fuse upstream cancellation with an identifiable timeout.
 * `timeoutMs <= 0` arms no timer.
 * @returns the fused signal plus a disposer that clears the armed timer.
 */
function deadline(upstream, timeoutMs, code) {
	if (timeoutMs <= 0) {
		return {
			signal: upstream ?? new AbortController().signal,
			[Symbol.dispose]() {}
		};
	}
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
		throw new Error(`deadline timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	}
	const timer = new AbortController();
	const id = setTimeout(() => {
		timer.abort(new TimeoutReason(code, timeoutMs));
	}, timeoutMs);
	return {
		signal: upstream !== undefined ? AbortSignal.any([upstream, timer.signal]) : timer.signal,
		[Symbol.dispose]() {
			clearTimeout(id);
		}
	};
}

/** Recover this deadline's timeout reason, if the signal fired one. */
function timeoutOf(carrier, code) {
	const reason = carrier?.reason;
	if (!(reason instanceof TimeoutReason)) return undefined;
	return code === undefined || reason.code === code ? reason : undefined;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader) {
	const read = reader.readFrom(0);
	return {
		text: read.text,
		truncated: read.lossy,
		...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {})
	};
}

function assertPositiveFinite(field, value) {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`wsl-shell: ${field} must be a positive finite number`);
	}
}

/** Single-quote one value for the `bash -c` string domain. */
function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Whether a path is an absolute Windows path (drive or UNC). */
function isWindowsAbsolute(target) {
	return /^[A-Za-z]:[\\/]/.test(target) || /^\\\\/.test(target);
}

/** Whether a path is an absolute POSIX path. */
function isPosixAbsolute(target) {
	return target.startsWith('/');
}

function isDirectory(target) {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Map a WSL-visible `/mnt/<letter>/…` path back to its Windows form.
 * Only drive-mounted paths round-trip; distribution-internal paths (`/home/…`)
 * have no stable Windows path, so they stay Linux-side.
 */
function mountToWindows(target) {
	const matched = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/.exec(target);
	if (matched === null) return undefined;
	const rest = matched[2] === undefined || matched[2] === '' ? '\\' : `\\${matched[2].replace(/\//g, '\\')}`;
	return `${matched[1].toUpperCase()}:${rest}`;
}

// ---------------------------------------------------------------------------
// destructive-command gate
// ---------------------------------------------------------------------------

/**
 * The destructive commands this gate refuses. Everything else — including a
 * project-scoped `rm -rf node_modules` — is left to the caller: this list only
 * covers operations that damage the machine or the distribution itself, which
 * is exactly the set nothing else on this path would stop (there is no sandbox
 * below WSL).
 * @param command - the raw command line.
 * @returns a short reason, or `null` when the command is not on the list.
 */
function dangerousReason(command) {
	const line = String(command);
	for (const raw of line.split(/(?:\|\||&&|;|\|)/)) {
		const sub = raw.trim().replace(/^sudo\s+/, '');
		if (/^rm\b/.test(sub)) {
			const tokens = sub.split(/\s+/);
			const flags = tokens.filter((token) => token.startsWith('-')).join(' ');
			const recursive = /(?:^|\s)-[a-zA-Z]*[rR][a-zA-Z]*/.test(` ${flags}`) || flags.includes('--recursive');
			if (!recursive) continue;
			for (const token of tokens.slice(1)) {
				if (token.startsWith('-')) continue;
				const target = token.replace(/^['"]+|['"]+$/g, '');
				if (/^(?:\/|\/\*|~|~\/|\$HOME|\$\{HOME\})(?:\/)?$/.test(target)) {
					return `recursive delete of ${target}`;
				}
			}
		}
		if (/^mkfs(?:\.[a-z0-9]+)?(?:\s|$)/.test(sub)) return 'format a filesystem';
		if (/^dd\b/.test(sub) && /\bof=\/dev\//.test(sub)) return 'write a block device';
		if (/^(?:shutdown|reboot|poweroff|halt)(?:\s|$)/.test(sub)) return 'power off or reboot';
		if (/^chmod\s+(?:-R\s+)?777\s+\/(?:\s|$)/.test(sub)) return 'make / world-writable';
		if (/^chown\s+-R\s+\S+\s+\/(?:\s|$)/.test(sub)) return 'recursive chown of /';
	}
	if (/:\s*\(\s*\)\s*\{[^}]*\}\s*;?\s*:/.test(line)) return 'fork bomb';
	if (/>\s*\/dev\/(?:sd|nvme|hd)/.test(line)) return 'redirect into a block device';
	return null;
}

/** Attach an actionable hint when WSL itself reported a distribution problem. */
function withWslHint(stderr, distro) {
	if (/There is no distribution|WSL_E_DISTRO_NOT_FOUND|distribution with the supplied name/i.test(stderr.text)) {
		stderr.text += `\n[hint] distribution "${distro}" not found: run \`wsl -l -v\` and set the plugin's distro config to one of the listed names.`;
	}
	return stderr;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Read a config value that may be a plain value or a schemastery accessor. */
function readConfigValue(config, key, fallback) {
	const raw = config?.[key];
	if (raw === undefined) return fallback;
	if (typeof raw === 'function' && typeof raw.get === 'function') {
		const value = raw.get();
		return value === undefined ? fallback : value;
	}
	return raw;
}

/**
 * Normalize the raw loader config into the plain values this executor uses.
 * The plugin declares no `Config` schema (importing `@deepseek-ai/schemastery`
 * would drag a second cordis in), so this is the only validation boundary and
 * it fails loudly on an unusable value.
 * @returns the resolved service config.
 */
function readConfig(config = {}) {
	const resolved = {
		distro: readConfigValue(config, 'distro', DEFAULT_DISTRO),
		wslPath: readConfigValue(config, 'wslPath', DEFAULT_WSL_PATH),
		bashPath: readConfigValue(config, 'bashPath', 'bash'),
		loginShell: readConfigValue(config, 'loginShell', false),
		pathPrefix: readConfigValue(config, 'pathPrefix', DEFAULT_PATH_PREFIX),
		user: readConfigValue(config, 'user', undefined),
		cwd: readConfigValue(config, 'cwd', undefined),
		extraEnv: readConfigValue(config, 'extraEnv', {}),
		timeoutMs: readConfigValue(config, 'timeoutMs', DEFAULT_TIMEOUT_MS),
		maxTimeoutMs: readConfigValue(config, 'maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS),
		maxOutputBytes: readConfigValue(config, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES),
		maxSpillBytes: readConfigValue(config, 'maxSpillBytes', DEFAULT_MAX_SPILL_BYTES),
		graceMs: readConfigValue(config, 'graceMs', DEFAULT_GRACE_MS),
		guard: readConfigValue(config, 'guard', DEFAULT_GUARD),
		guardAllow: readConfigValue(config, 'guardAllow', []),
		maxConcurrency: readConfigValue(config, 'maxConcurrency', DEFAULT_MAX_CONCURRENCY)
	};
	if (typeof resolved.distro !== 'string' || resolved.distro.length === 0) {
		throw new Error('wsl-shell: distro must be a non-empty string');
	}
	for (const field of ['wslPath', 'bashPath']) {
		if (typeof resolved[field] !== 'string' || resolved[field].length === 0) {
			throw new Error(`wsl-shell: ${field} must be a non-empty string`);
		}
	}
	if (typeof resolved.pathPrefix !== 'string') throw new Error('wsl-shell: pathPrefix must be a string');
	if (resolved.user !== undefined && (typeof resolved.user !== 'string' || resolved.user.length === 0)) {
		throw new Error('wsl-shell: user must be a non-empty string when set');
	}
	if (resolved.cwd !== undefined && (typeof resolved.cwd !== 'string' || resolved.cwd.length === 0)) {
		throw new Error('wsl-shell: cwd must be a non-empty string when set');
	}
	if (resolved.extraEnv === null || typeof resolved.extraEnv !== 'object' || Array.isArray(resolved.extraEnv)) {
		throw new Error('wsl-shell: extraEnv must be an object of NAME: value pairs');
	}
	for (const [key, value] of Object.entries(resolved.extraEnv)) {
		if (typeof value !== 'string') throw new Error(`wsl-shell: extraEnv.${key} must be a string`);
	}
	assertPositiveFinite('timeoutMs', resolved.timeoutMs);
	assertPositiveFinite('maxTimeoutMs', resolved.maxTimeoutMs);
	assertPositiveFinite('maxOutputBytes', resolved.maxOutputBytes);
	assertPositiveFinite('maxSpillBytes', resolved.maxSpillBytes);
	assertPositiveFinite('graceMs', resolved.graceMs);
	if (resolved.graceMs > MAX_TIMER_DELAY_MS) {
		throw new Error(`wsl-shell: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`);
	}
	if (resolved.guard !== 'strict' && resolved.guard !== 'off') {
		throw new Error("wsl-shell: guard must be 'strict' or 'off'");
	}
	if (!Array.isArray(resolved.guardAllow)) {
		throw new Error('wsl-shell: guardAllow must be an array of regular-expression strings');
	}
	resolved.guardAllow = resolved.guardAllow.map((pattern) => {
		if (typeof pattern !== 'string' || pattern.length === 0) {
			throw new Error('wsl-shell: guardAllow entries must be non-empty regular-expression strings');
		}
		try {
			return new RegExp(pattern);
		} catch {
			throw new Error(`wsl-shell: guardAllow entry is not a valid regular expression: ${pattern}`);
		}
	});
	if (!Number.isInteger(resolved.maxConcurrency) || resolved.maxConcurrency < 1) {
		throw new Error('wsl-shell: maxConcurrency must be a positive integer');
	}
	return resolved;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

/**
 * `ctx.shell` executor that runs every command inside WSL bash.
 *
 * Bounded output, spill files, and managed-range termination are
 * `ctx.subprocess`'s mechanics; this executor supplies the per-spawn budgets,
 * builds the `wsl.exe` argv, and translates a dsh workdir into a directory both
 * sides agree on.
 */
class WslShellExecutor {
	/** No sandbox: this executor never confines, so tools advertise no escalation. */
	sandboxMode = undefined;

	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.declaredWslPath = config.wslPath;
		this.resolvedWslPath = resolveWslPath(config.wslPath);
		this.defaultCwd = config.cwd ?? process.cwd();
		/** Running `wsl.exe` processes, capped by `maxConcurrency`. */
		this.active = 0;
		/** Resolvers waiting for a slot, FIFO. */
		this.waiters = [];
	}

	/** Resolve a request into a fully-specified spec (defaults applied, caps enforced). */
	resolve(request) {
		const config = this.config;
		assertPositiveFinite('timeoutMs', config.timeoutMs);
		assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs);
		assertPositiveFinite('maxOutputBytes', config.maxOutputBytes);
		assertPositiveFinite('maxSpillBytes', config.maxSpillBytes);
		assertPositiveFinite('graceMs', config.graceMs);
		const timeoutMs = clampTimeout(request.timeoutMs, config.timeoutMs, config.maxTimeoutMs, 'wsl-shell: request.timeoutMs');
		const stdoutMaxBytes = request.stdoutMaxBytes ?? config.maxOutputBytes;
		assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes);
		return {
			command: request.command,
			workdir: request.workdir ?? config.cwd ?? process.cwd(),
			timeoutMs,
			onExpiry: request.onExpiry ?? 'kill',
			stdoutMaxBytes,
			...(request.signal ? { signal: request.signal } : {}),
			...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
			...(request.env !== undefined ? { env: request.env } : {}),
			...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
			// `ShellExecSpec.sandboxPolicy` is a required key that holds
			// `undefined` when the caller supplied no policy; keep it present so
			// the spec shape matches the seam exactly.
			sandboxPolicy: request.sandboxPolicy
		};
	}

	/** The wsl.exe path every command runs through; a changed config value is probed again. */
	get wslPath() {
		const declared = this.config.wslPath;
		if (declared !== this.declaredWslPath) {
			this.resolvedWslPath = resolveWslPath(declared);
			this.declaredWslPath = declared;
		}
		return this.resolvedWslPath;
	}

	/**
	 * Translate a dsh workdir into the pair the launch needs: the directory
	 * `wsl.exe` itself starts in (a Windows path), plus an optional Linux-side
	 * `cd` prefix for directories no Windows path can name.
	 * @param workdir - the resolved spec workdir.
	 * @returns the Windows spawn cwd and an optional `cd -- <dir> && ` prefix.
	 */
	workdirPlan(workdir) {
		if (isWindowsAbsolute(workdir)) {
			// wsl.exe maps its own cwd onto the Linux mount, so pass it through
			// untouched; a missing directory stays a loud spawn failure.
			return { cwd: workdir, prefix: '' };
		}
		if (isPosixAbsolute(workdir)) {
			const mapped = mountToWindows(workdir);
			if (mapped !== undefined && isDirectory(mapped)) return { cwd: mapped, prefix: '' };
			return { cwd: this.defaultCwd, prefix: `cd -- ${shellQuote(workdir)} && ` };
		}
		const joined = win32.resolve(this.defaultCwd, workdir);
		return { cwd: isDirectory(joined) ? joined : this.defaultCwd, prefix: '' };
	}

	/**
	 * The `wsl.exe` invocation argv for one resolved spec: the caller's plain
	 * `env`, the configured `extraEnv`, and the managed `DSH_*` facts as
	 * explicit `export` statements, then the model-friendly PATH prefix, any
	 * Linux-side `cd`, and finally the caller's command verbatim.
	 *
	 * `wsl.exe` only forwards Windows variables listed in `WSLENV`, so an
	 * environment handed to the launcher would otherwise never reach the
	 * command. The caller's `PATH`, if any, is exported before the prefix so
	 * the prefix prepends to it instead of being clobbered.
	 */
	argv(spec) {
		const config = this.config;
		const plan = this.workdirPlan(spec.workdir);
		const statements = [];
		const forwarded = { ...(spec.env ?? {}), ...config.extraEnv, ...(spec.dshEnv ?? {}) };
		for (const [key, value] of Object.entries(forwarded)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
			statements.push(`export ${key}=${shellQuote(value)}`);
		}
		if (config.pathPrefix.length > 0) {
			statements.push(`export PATH=${config.pathPrefix}:$PATH`);
		}
		const prefix = statements.length > 0 ? `${statements.join('; ')}; ` : '';
		return [
			this.wslPath,
			'-d',
			config.distro,
			...(config.user === undefined ? [] : ['-u', config.user]),
			'-e',
			config.bashPath,
			config.loginShell ? '-lc' : '-c',
			`${prefix}${plan.prefix}${spec.command}`
		];
	}

	/** Map one resolved spec plus its argv onto a fully-specified subprocess spawn. */
	spawnSpec(spec, stdoutMaxBytes, signal, argv) {
		const config = this.config;
		const collect = (maxBytes) => ({
			maxBytes,
			spill: { maxBytes: config.maxSpillBytes }
		});
		return {
			argv: [...argv],
			cwd: this.workdirPlan(spec.workdir).cwd,
			stdio: {
				stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
				stdout: collect(stdoutMaxBytes),
				stderr: collect(config.maxOutputBytes)
			},
			graceMs: config.graceMs,
			signal,
			env: {
				...ENV_OVERRIDES,
				...spec.env,
				...spec.dshEnv
			}
		};
	}

	/** The collect-mode readers this executor itself requested (present by construction). */
	static collected(handle) {
		const { stdout, stderr } = handle.collected;
		if (stdout === undefined || stderr === undefined) {
			throw new Error('wsl-shell: subprocess implementation dropped a requested collect stream');
		}
		return { stdout, stderr };
	}

	/**
	 * Refuse the handful of commands that damage the machine or the
	 * distribution itself. There is no sandbox below WSL, so this is the only
	 * stop in front of `rm -rf /`. `guardAllow` patterns opt a command back in.
	 */
	guardCommand(command) {
		if (this.config.guard === 'off') return;
		for (const allow of this.config.guardAllow) if (allow.test(command)) return;
		const reason = dangerousReason(command);
		if (reason !== null) {
			throw new Error(`wsl-shell: refused a destructive command (${reason}). This executor runs below the DSH sandbox, so nothing else would stop it. Set guard: 'off' or add a guardAllow pattern if you really mean it.`);
		}
	}

	/** Wait for a concurrency slot; resolves when the caller may spawn. */
	async acquire() {
		if (this.active < this.config.maxConcurrency) {
			this.active += 1;
			return;
		}
		await new Promise((resolve) => this.waiters.push(resolve));
		this.active += 1;
	}

	/** Give a slot back and wake the next waiter. */
	release() {
		this.active -= 1;
		const next = this.waiters.shift();
		if (next !== undefined) next();
	}

	async execute(spec) {
		this.guardCommand(spec.command);
		await this.acquire();
		let proc;
		try {
			proc = await this.executeArgv(spec, this.argv(spec));
		} catch (error) {
			this.release();
			throw error;
		}
		proc.done.then(() => this.release(), () => this.release());
		return proc;
	}

	/**
	 * Execute an explicit argv with the lifecycle, environment, output,
	 * deadline, and cancellation semantics of this executor.
	 * @param spec - resolved execution settings and caller-owned command metadata.
	 * @param argvOrPrepare - exact argv, or preparation using the execution cancellation signal.
	 * @param onStarted - installs provider facts synchronously before the handle can settle.
	 * @returns the live execution handle; spawn rejection settles the handle as
	 *   killed while `result()` carries the same failure as its rejection.
	 */
	async executeArgv(spec, argvOrPrepare, onStarted) {
		let spawnSignal;
		let classify;
		let disarm = () => {};
		if (spec.onExpiry === 'kill') {
			const armed = deadline(spec.signal, spec.timeoutMs, TIMEOUT_CODE);
			spawnSignal = armed.signal;
			classify = () => {
				const timedOut = timeoutOf(armed.signal, TIMEOUT_CODE) !== undefined;
				return { timedOut, aborted: armed.signal.aborted && !timedOut };
			};
			disarm = () => {
				armed[Symbol.dispose]();
			};
		} else {
			spawnSignal = spec.signal;
			classify = () => ({ timedOut: false, aborted: spec.signal?.aborted === true });
		}
		let argv = [];
		let preparationTimedOut = false;
		if (typeof argvOrPrepare === 'function') {
			const signal = spawnSignal ?? new AbortController().signal;
			const cancelled = Promise.withResolvers();
			const abort = () => {
				cancelled.reject(signal.reason);
			};
			signal.addEventListener('abort', abort, { once: true });
			try {
				argv = await Promise.race([Promise.resolve().then(() => {
					signal.throwIfAborted();
					return argvOrPrepare(signal);
				}), cancelled.promise]);
				signal.throwIfAborted();
			} catch (error) {
				if (!classify().timedOut) {
					disarm();
					throw error;
				}
				preparationTimedOut = true;
			} finally {
				signal.removeEventListener('abort', abort);
			}
		} else {
			argv = argvOrPrepare;
		}
		let running;
		let syncSpawnError;
		try {
			if (!preparationTimedOut) running = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, spawnSignal, argv));
		} catch (error) {
			syncSpawnError = { error };
		}
		const emptyReader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) };
		const collected = running !== undefined ? WslShellExecutor.collected(running) : { stdout: emptyReader, stderr: emptyReader };
		const spawnThrow = () => syncSpawnError.error;
		const spawned = preparationTimedOut ? Promise.resolve({ exitCode: null, signal: null }) : running !== undefined ? running.done : Promise.reject(spawnThrow());
		let providerFailure;
		let providerFailureReported = false;
		const consumeProviderFailure = () => {
			if (providerFailure === undefined || providerFailureReported) return '';
			providerFailureReported = true;
			return providerFailure.note;
		};
		const observedStderr = {
			readFrom: (fromByte) => {
				if (providerFailure === undefined) return collected.stderr.readFrom(fromByte);
				const note = Buffer.from(providerFailure.note, 'utf8');
				return {
					text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'),
					nextOffset: note.length,
					lossy: false
				};
			}
		};
		let stdoutOffset = 0;
		let stderrOffset = 0;
		let resultPromise;
		const proc = {
			status: 'running',
			exitCode: null,
			signal: null,
			observed: { stdout: collected.stdout, stderr: observedStderr },
			done: spawned.then((outcome) => {
				if (proc.status === 'running') {
					proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed';
				}
				proc.exitCode = outcome.exitCode;
				proc.signal = outcome.signal;
				this.onProcessDone(proc, collected.stderr.readFrom(0).text, false);
				disarm();
			}, (error) => {
				if (running !== undefined && (proc.status === 'killed' || spawnSignal?.aborted === true)) {
					proc.status = 'killed';
					this.onProcessDone(proc, collected.stderr.readFrom(0).text, false);
					disarm();
					return;
				}
				proc.status = 'killed';
				let detail = 'unprintable provider failure';
				try {
					detail = String(error);
				} catch {}
				providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}` };
				this.onProcessDone(proc, providerFailure.note, true, error);
				disarm();
			}),
			readOutput: () => {
				const out = collected.stdout.readFrom(stdoutOffset);
				const err = collected.stderr.readFrom(stderrOffset);
				stdoutOffset = out.nextOffset;
				stderrOffset = err.nextOffset;
				const failureNote = consumeProviderFailure();
				const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : '';
				const errText = err.text + (failureNote.length > 0 ? `${failureSeparator}${failureNote}` : '');
				const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : '';
				return {
					delta: out.text + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
					lossy: out.lossy || err.lossy,
					...(out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {}),
					...(err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {})
				};
			},
			kill: () => {
				if (proc.status !== 'running') return false;
				proc.status = 'killed';
				running?.terminate();
				return true;
			},
			result: () => {
				resultPromise ??= proc.done.then(() => {
					if (providerFailure !== undefined) {
						const error = providerFailure.error;
						if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
							throw new Error(`wsl-shell: cannot launch ${this.wslPath} (ENOENT). Install WSL or point the wslPath config at wsl.exe.`);
						}
						throw error;
					}
					return {
						exitCode: proc.exitCode,
						signal: proc.signal,
						...classify(),
						timeoutMs: spec.timeoutMs,
						stdout: finalOutput(collected.stdout),
						stderr: withWslHint(finalOutput(collected.stderr), this.config.distro)
					};
				});
				return resultPromise;
			}
		};
		if (!preparationTimedOut) onStarted?.(proc);
		return proc;
	}

	/** Settlement hook for subclasses; the base implementation is intentionally empty. */
	onProcessDone(_proc, _stderr, _providerRejected, _providerError) {}
}

/**
 * Resolve the `wsl.exe` executable this executor spawns. A configured path is
 * trusted as-is: probing it here would turn a later uninstall into a silent
 * fallback, while a missing launcher must surface as a loud spawn failure.
 * The default already names the absolute System32 launcher, so the Windows
 * `PATH` search order never decides which `wsl.exe` runs.
 */
function resolveWslPath(configured) {
	return configured;
}

/**
 * Register this executor as `ctx.shell`.
 * @param ctx - the cordis context this plugin runs in.
 * @param config - raw loader config; normalized and validated here.
 */
export function apply(ctx, config = {}) {
	const resolved = readConfig(config);
	const executor = new WslShellExecutor(ctx, resolved);
	ctx.provide('shell', executor);
}
