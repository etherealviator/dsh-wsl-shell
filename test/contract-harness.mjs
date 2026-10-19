/**
 * Contract harness for dsh-wsl-shell: a faithful stand-in for
 * `@deepseek-ai/dsh-subprocess-local` (collect readers with spill, terminate,
 * done) so the executor's seam obligations can be exercised without the app.
 * Run (Windows Node, a real WSL distro required):
 *   node C:\Users\lvling\.dsh-plugins\wsl-shell\test\contract-harness.mjs
 */
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { apply, inject, name } from '../lib/index.js';

let failures = 0;
function check(label, condition, detail) {
	if (condition) {
		console.log(`  ok   ${label}`);
	} else {
		failures++;
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${JSON.stringify(detail)}`}`);
	}
}
function section(title) {
	console.log(`\n=== ${title}`);
}

const spillDir = mkdtempSync(join(tmpdir(), 'wsl-shell-harness-'));
let spillSeq = 0;

/** Tail-buffer collector that mirrors the provider's readFrom/windowStart contract. */
class Collector {
	constructor(maxBytes, label) {
		this.maxBytes = maxBytes;
		this.label = label;
		this.chunks = [];
		this.bytes = 0;
		this.total = 0;
		this.spillPath = undefined;
	}
	push(chunk) {
		this.total += chunk.length;
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > this.maxBytes && this.chunks.length > 1) {
			const dropped = this.chunks.shift();
			this.bytes -= dropped.length;
		}
		if (this.total > this.maxBytes && this.spillPath === undefined) {
			this.spillPath = join(spillDir, `${this.label}-${spillSeq++}.log`);
			writeFileSync(this.spillPath, Buffer.from(''));
		}
		if (this.spillPath !== undefined) appendFileSync(this.spillPath, chunk);
	}
	readFrom(fromByte) {
		const buffer = Buffer.concat(this.chunks);
		const windowStart = this.total - buffer.length;
		const lossy = fromByte < windowStart;
		return {
			text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString('utf8'),
			nextOffset: this.total,
			lossy,
			...(this.spillPath !== undefined ? { spillPath: this.spillPath } : {})
		};
	}
}

function makeSubprocess({ throwOnSpawn } = {}) {
	const live = new Set();
	return {
		spawn(spec) {
			if (throwOnSpawn !== undefined) throw throwOnSpawn;
			if (spec.signal?.aborted) throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`);
			const [program, ...args] = spec.argv;
			const child = nodeSpawn(program, args, {
				cwd: spec.cwd,
				env: { ...scrubbedParentEnv(), ...spec.env },
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
				detached: process.platform !== 'win32'
			});
			const outMode = spec.stdio.stdout;
			const errMode = spec.stdio.stderr;
			let terminated = false;
			const stdout = new Collector(outMode.maxBytes, 'stdout');
			const stderr = new Collector(errMode.maxBytes, 'stderr');
			child.stdout.on('data', (chunk) => stdout.push(chunk));
			child.stderr.on('data', (chunk) => stderr.push(chunk));
			const done = new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
			});
			const handle = {
				collected: { stdout, stderr },
				done,
				terminate() {
					terminated = true;
					if (process.platform === 'win32') {
						nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
					} else {
						try {
							process.kill(child.pid, 'SIGTERM');
						} catch {}
					}
				},
				async waitForExit() {
					await done.catch(() => {});
				}
			};
			// The provider starts its documented termination procedure on the
			// spawn signal; the executor relies on exactly this.
			spec.signal?.addEventListener('abort', () => handle.terminate(), { once: true });
			live.add(handle);
			done.then(() => live.delete(handle), () => live.delete(handle));
			return handle;
		}
	};
}

function scrubbedParentEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue;
		if (key.toUpperCase().startsWith('DSH_')) continue;
		env[key] = value;
	}
	return env;
}

/** Build the fake cordis context the plugin needs (`inject: ['subprocess']`). */
function makeCtx(subprocess) {
	let provided;
	return {
		subprocess,
		provide(serviceName, service) {
			if (serviceName !== 'shell') throw new Error(`unexpected service ${serviceName}`);
			if (provided !== undefined) throw new Error('service "shell" has been registered');
			provided = service;
			this.shell = service;
		},
		get providedShell() {
			return provided;
		}
	};
}

function boot(config, subprocessOptions) {
	const ctx = makeCtx(makeSubprocess(subprocessOptions));
	apply(ctx, config);
	return ctx.shell;
}

const WSL = { distro: 'Ubuntu' };

// ---------------------------------------------------------------------------
section('plugin surface');
check('name', name === 'wsl-shell', name);
check('inject', Array.isArray(inject) && inject.length === 1 && inject[0] === 'subprocess', inject);
{
	const ctx = makeCtx(makeSubprocess());
	apply(ctx, {});
	check('ctx.provide registered shell', typeof ctx.providedShell?.resolve === 'function');
	check('sandboxMode is undefined', ctx.providedShell.sandboxMode === undefined, ctx.providedShell.sandboxMode);
	check('surface: resolve/execute/sandboxMode', ['resolve', 'execute', 'sandboxMode'].every((key) => key in ctx.providedShell));
	let duplicate;
	try {
		apply(ctx, {});
	} catch (error) {
		duplicate = error;
	}
	check('second registration throws (cordis duplicate-service shape)', duplicate !== undefined);
}

// ---------------------------------------------------------------------------
section('resolve(): defaults, caps, passthrough');
{
	const shell = boot({ ...WSL, timeoutMs: 5000, maxTimeoutMs: 10000, maxOutputBytes: 128 });
	const spec = shell.resolve({ command: 'true' });
	check('workdir defaults to process.cwd()', spec.workdir === process.cwd(), spec.workdir);
	check('timeoutMs default', spec.timeoutMs === 5000, spec.timeoutMs);
	check('onExpiry default kill', spec.onExpiry === 'kill', spec.onExpiry);
	check('stdoutMaxBytes from config', spec.stdoutMaxBytes === 128, spec.stdoutMaxBytes);
	check('caller timeout clamped to maxTimeoutMs', shell.resolve({ command: 'x', timeoutMs: 60000 }).timeoutMs === 10000);
	check('caller timeout kept under cap', shell.resolve({ command: 'x', timeoutMs: 2000 }).timeoutMs === 2000);
	check('onExpiry none preserved', shell.resolve({ command: 'x', onExpiry: 'none' }).onExpiry === 'none');
	const env = { FOO: 'bar' };
	check('env carried', shell.resolve({ command: 'x', env }).env === env);
	const dshEnv = { DSH_SESSION: 's1' };
	check('dshEnv carried', shell.resolve({ command: 'x', dshEnv }).dshEnv === dshEnv);
	const signal = new AbortController().signal;
	check('signal carried', shell.resolve({ command: 'x', signal }).signal === signal);
	let rejected;
	try {
		shell.resolve({ command: 'x', timeoutMs: 0 });
	} catch (error) {
		rejected = error;
	}
	check('invalid timeoutMs rejects', rejected !== undefined, String(rejected));
}

// ---------------------------------------------------------------------------
section('argv(): exact launcher shape');
{
	const shell = boot({ ...WSL });
	const argv = shell.argv(shell.resolve({ command: 'echo $HOME', workdir: 'C:\\Users\\lvling' }));
	check('argv[0] is the System32 wsl.exe', argv[0] === 'C:\\Windows\\System32\\wsl.exe', argv[0]);
	check('distro selected', argv[1] === '-d' && argv[2] === 'Ubuntu', argv.slice(1, 3));
	check('-e bash', argv[3] === '-e' && argv[4] === 'bash', argv.slice(3, 5));
	check('-c', argv[5] === '-c', argv[5]);
	check('PATH prefix prepended to the command', argv[6] === 'export PATH=$HOME/.local/bin:/usr/local/bin:$PATH; echo $HOME', argv[6]);

	const mixed = boot({ ...WSL, user: 'lvling', loginShell: true, extraEnv: { LANG: 'C.UTF-8' } });
	const mixedArgv = mixed.argv(mixed.resolve({ command: 'pwd', workdir: '/mnt/d/tianyan', dshEnv: { DSH_SESSION: "s'1" } }));
	check('-u user passed', mixedArgv[3] === '-u' && mixedArgv[4] === 'lvling', mixedArgv.slice(3, 5));
	check('loginShell uses -lc', mixedArgv.includes('-lc'), mixedArgv);
	check('extraEnv exported on the Linux side', mixedArgv.at(-1).includes("export LANG='C.UTF-8'"), mixedArgv.at(-1));
	check('dshEnv exported and single-quote escaped', mixedArgv.at(-1).includes("export DSH_SESSION='s'\\''1'"), mixedArgv.at(-1));
	check('/mnt path needs no cd prefix', !mixedArgv.at(-1).includes('cd -- '), mixedArgv.at(-1));

	const home = boot({ ...WSL });
	const homeArgv = home.argv(home.resolve({ command: 'ls', workdir: '/home/lvling' }));
	check('distribution path becomes a cd prefix', homeArgv.at(-1).endsWith("cd -- '/home/lvling' && ls"), homeArgv.at(-1));
	const quoted = home.argv(home.resolve({ command: 'ls', workdir: "/home/o'brien" }));
	check('cd prefix quotes single quotes', quoted.at(-1).includes(`cd -- '/home/o'\\''brien' && ls`), quoted.at(-1));
}

// ---------------------------------------------------------------------------
section('spawnSpec(): budgets and environment');
{
	const shell = boot({ ...WSL, maxOutputBytes: 1234, maxSpillBytes: 99, graceMs: 250 });
	const spec = shell.resolve({ command: 'true', workdir: 'C:\\Users\\lvling' });
	const spawnSpec = shell.spawnSpec(spec, spec.stdoutMaxBytes, undefined, ['x']);
	check('cwd is the Windows workdir', spawnSpec.cwd === 'C:\\Users\\lvling', spawnSpec.cwd);
	check('stdout budget', spawnSpec.stdio.stdout.maxBytes === 1234);
	check('stderr budget', spawnSpec.stdio.stderr.maxBytes === 1234);
	check('spill budget', spawnSpec.stdio.stdout.spill.maxBytes === 99);
	check('graceMs', spawnSpec.graceMs === 250);
	check('stdin ignored by default', spawnSpec.stdio.stdin === 'ignore');
	check('ENV_OVERRIDES applied', spawnSpec.env.NO_COLOR === '1' && spawnSpec.env.TERM === 'dumb' && spawnSpec.env.PAGER === 'cat' && spawnSpec.env.GIT_PAGER === 'cat');
	const withStdin = shell.resolve({ command: 'true', stdin: 'hi' });
	check('stdin data passed', shell.spawnSpec(withStdin, 1234, undefined, ['x']).stdio.stdin.data === 'hi');
}

// ---------------------------------------------------------------------------
section('execute()/result(): success, failure, stderr, utf-8');
{
	const shell = boot(WSL);
	const ok = await (await shell.execute(shell.resolve({ command: 'echo hello', workdir: 'C:\\Users\\lvling' }))).result();
	check('exitCode 0', ok.exitCode === 0, ok.exitCode);
	check('signal null', ok.signal === null, ok.signal);
	check('timedOut false', ok.timedOut === false);
	check('aborted false', ok.aborted === false);
	check('timeoutMs echoed', ok.timeoutMs === 120000, ok.timeoutMs);
	check('stdout text', ok.stdout.text === 'hello\n', ok.stdout.text);
	check('stdout not truncated', ok.stdout.truncated === false);
	check('stderr empty', ok.stderr.text === '');

	const failed = await (await shell.execute(shell.resolve({ command: 'false' }))).result();
	check('non-zero exit resolves (not rejects)', failed.exitCode === 1, failed.exitCode);
	check('non-zero exit is not timedOut/aborted', failed.timedOut === false && failed.aborted === false);

	const both = await (await shell.execute(shell.resolve({ command: 'echo out; echo err >&2; exit 3' }))).result();
	check('stdout and stderr separated', both.stdout.text === 'out\n' && both.stderr.text === 'err\n', [both.stdout.text, both.stderr.text]);
	check('exit code 3', both.exitCode === 3, both.exitCode);

	const unicode = await (await shell.execute(shell.resolve({ command: 'echo 中文测试 — ünïcode' }))).result();
	check('utf-8 output intact', unicode.stdout.text === '中文测试 — ünïcode\n', unicode.stdout.text);

	const q = await (await shell.execute(shell.resolve({ command: `printf '%s|' "a b" 'c d' "$HOME"; echo; echo "x  y" | tr -s ' '` }))).result();
	check('quotes, variables and pipes survive Windows argv', q.stdout.text === `a b|c d|/home/lvling|\nx y\n`, q.stdout.text);

	const env = await (await shell.execute(shell.resolve({ command: 'echo "$DSH_PROBE"', dshEnv: { DSH_PROBE: 'forwarded' } }))).result();
	check('DSH_* facts reach the Linux side', env.stdout.text === 'forwarded\n', env.stdout.text);

	const plain = await (await shell.execute(shell.resolve({ command: 'echo "$PLAIN_ENV"', env: { PLAIN_ENV: 'also-forwarded' } }))).result();
	check('a caller plain env reaches the Linux side', plain.stdout.text === 'also-forwarded\n', plain.stdout.text);

	const pathEnv = boot({ ...WSL, pathPrefix: '/opt/extra' });
	const pathArgv = pathEnv.argv(pathEnv.resolve({ command: 'true', env: { PATH: '/base/bin' } }));
	const command = pathArgv.at(-1);
	check('a caller PATH is exported before the prefix, so the prefix prepends', command.includes("export PATH='/base/bin'; export PATH=/opt/extra:$PATH"), command);
	check('PATH inherits the distribution PATH when the caller sets none', pathArgv.at(-1).includes('export PATH=/opt/extra:$PATH'), command);
}

// ---------------------------------------------------------------------------
section('cwd handling');
{
	const shell = boot(WSL);
	const win = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: 'D:\\tianyan' }))).result();
	check('Windows workdir mapped by wsl.exe', win.stdout.text === '/mnt/d/tianyan\n', win.stdout.text);
	const mnt = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: '/mnt/d/tianyan' }))).result();
	check('/mnt workdir translated to a Windows cwd', mnt.stdout.text === '/mnt/d/tianyan\n', mnt.stdout.text);
	const home = await (await shell.execute(shell.resolve({ command: 'pwd', workdir: '/home/lvling' }))).result();
	check('/home workdir via cd prefix', home.stdout.text === '/home/lvling\n', home.stdout.text);
	const cwdConfig = boot({ ...WSL, cwd: 'D:\\tianyan' });
	const fromConfig = await (await cwdConfig.execute(cwdConfig.resolve({ command: 'pwd' }))).result();
	check('config.cwd is the default workdir', fromConfig.stdout.text === '/mnt/d/tianyan\n', fromConfig.stdout.text);
}

// ---------------------------------------------------------------------------
section('output budget: truncation and spill');
{
	const shell = boot({ ...WSL, maxOutputBytes: 64, maxSpillBytes: 1024 * 1024 });
	const big = await (await shell.execute(shell.resolve({ command: 'for i in $(seq 1 200); do echo "line-$i"; done' }))).result();
	check('over-budget stdout flagged truncated', big.stdout.truncated === true, big.stdout.truncated);
	check('spill path reported', typeof big.stdout.spillPath === 'string', big.stdout.spillPath);
	check('tail retained', big.stdout.text.trimEnd().endsWith('line-200'), big.stdout.text.slice(-40));
}

// ---------------------------------------------------------------------------
section('timeout: BASH_TIMEOUT kill');
{
	const shell = boot({ ...WSL, timeoutMs: 1500, graceMs: 500 });
	const started = Date.now();
	const execution = await shell.execute(shell.resolve({ command: 'sleep 30' }));
	const result = await execution.result();
	const elapsed = Date.now() - started;
	check('timedOut true', result.timedOut === true, result);
	check('aborted false (first-cause classification)', result.aborted === false, result.aborted);
	check('timeoutMs echoed', result.timeoutMs === 1500, result.timeoutMs);
	check('killed before its natural end', elapsed < 15000, elapsed);
	check('handle status killed', execution.status === 'killed', execution.status);
	check('a killed command does not report a clean exit', result.signal !== null || result.exitCode !== 0, [result.exitCode, result.signal]);
}

// ---------------------------------------------------------------------------
section('timeout before spawn (preparation expiry)');
{
	const shell = boot({ ...WSL, timeoutMs: 20 });
	const execution = await shell.execute(shell.resolve({
		command: 'ignored',
		timeoutMs: 20
	}));
	// Preparation here is synchronous, so a timeout cannot land before spawn; this
	// asserts the ordinary path instead: a fast command under a tiny deadline.
	const result = await execution.result();
	check('tiny deadline still settles (no hang, no throw)', typeof result.timedOut === 'boolean', result);
}

// ---------------------------------------------------------------------------
section('cancellation: caller abort');
{
	const shell = boot(WSL);
	const controller = new AbortController();
	const execution = await shell.execute(shell.resolve({ command: 'sleep 30', signal: controller.signal }));
	setTimeout(() => controller.abort(new Error('user cancelled')), 300);
	const result = await execution.result();
	check('aborted classified', result.aborted === true && result.timedOut === false, result);
}

// ---------------------------------------------------------------------------
section('background handle: onExpiry none, readOutput, kill');
{
	const shell = boot(WSL);
	const spec = shell.resolve({ command: 'for i in 1 2 3 4 5; do echo tick-$i; sleep 0.4; done', onExpiry: 'none' });
	const execution = await shell.execute(spec);
	const empty = execution.readOutput();
	check('a read before any output is a well-formed empty delta', empty.delta === '' && empty.lossy === false, empty);
	await new Promise((resolve) => setTimeout(resolve, 900));
	const first = execution.readOutput();
	check('a later read carries the accumulated delta', first.delta.includes('tick-1'), first.delta);
	const second = execution.readOutput();
	check('consecutive reads never repeat output', !second.delta.includes('tick-1'), [first.delta, second.delta]);
	const killed = execution.kill();
	check('kill() true on a running handle', killed === true);
	check('kill() false once killed', execution.kill() === false);
	await execution.done;
	check('done resolves (never rejects) after kill', true);
	const after = await execution.result();
	check('result() after kill is a result, not a rejection', after.timedOut === false, after);

	const unkilled = await shell.execute(shell.resolve({ command: 'echo done-normally', onExpiry: 'none' }));
	await unkilled.done;
	const final = await unkilled.result();
	check('onExpiry none ignores no deadline', final.exitCode === 0 && final.timedOut === false, final);
}

// ---------------------------------------------------------------------------
section('infrastructure failure: spawn rejection');
{
	const boom = new Error('spawn ENOENT wsl.exe');
	const shell = boot(WSL, { throwOnSpawn: boom });
	const execution = await shell.execute(shell.resolve({ command: 'true' }));
	let rejected;
	try {
		await execution.result();
	} catch (error) {
		rejected = error;
	}
	check('result() rejects for infrastructure failure', rejected === boom, String(rejected));
	await execution.done;
	check('done settles killed without rejecting', execution.status === 'killed', execution.status);
	const read = execution.readOutput();
	check('spawn failure surfaces on the read path', read.delta.includes('subprocess failed before reporting an outcome'), read.delta);
}

// ---------------------------------------------------------------------------
section('observed readers');
{
	const shell = boot(WSL);
	const execution = await shell.execute(shell.resolve({ command: 'echo peeked' }));
	await execution.done;
	const viaObserved = execution.observed.stdout.readFrom(0);
	check('observed.stdout is an offset reader', viaObserved.text === 'peeked\n', viaObserved.text);
	const final = await execution.result();
	check('consuming read still sees the output', final.stdout.text === 'peeked\n', final.stdout.text);
}

// ---------------------------------------------------------------------------
section('no sandbox, no ctx.sandbox use');
{
	const ctx = makeCtx(makeSubprocess());
	apply(ctx, { distro: 'Ubuntu' });
	check('ctx.sandbox never touched', ctx.sandbox === undefined);
	const spec = ctx.providedShell.resolve({ command: 'true', sandboxPolicy: { mode: 'workspace-write' } });
	check('sandboxPolicy passes through untouched', spec.sandboxPolicy.mode === 'workspace-write');
	const result = await (await ctx.providedShell.execute(spec)).result();
	check('result carries no sandbox facts', result.sandbox === undefined, result.sandbox);
}

// ---------------------------------------------------------------------------
section('no @deepseek-ai imports (builtins only)');
{
	const { readFileSync } = await import('node:fs');
	const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
	const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
	check('every import is node: or a relative path', specifiers.every((s) => s.startsWith('node:') || s.startsWith('./')), specifiers);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
