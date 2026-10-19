# dsh-wsl-shell

> **它替换整个 `ctx.shell`。** 装上之后，所有 shell 命令——DSH 自己的、别的插件的、你自己敲的——都会经 `wsl.exe` 跑进 WSL bash，而不是 Windows 原生 shell。
>
> **它跑在 DSH 沙箱之外。** WSL 不能在 Windows ACL 受限令牌里启动，所以 `ctx.sandbox.confine()` 用不上：命令以你的身份在 Linux 侧执行，文件写入不受 workspace 限制。
>
> **DSH 的审批弹窗基本管不到它。** DSH 的 approval 主要挂在"沙箱拒绝后的升级通道"上；本执行器没有沙箱，那条通道也就不存在。作为替代，它自带一道**破坏性命令闸门**（默认 `guard: strict`），拒绝 `rm -rf /`、`mkfs`、`dd of=/dev/…`、`poweroff` 这类命令。
>
> 你明确知道自己要这个，再装。

A `@deepseek-ai/dsh-desktop` Cordis plugin that provides `ctx.shell` by running **every command through WSL bash**:

```
C:\Windows\System32\wsl.exe -d Ubuntu -e bash -c "export PATH=$HOME/.local/bin:/usr/local/bin:$PATH; export DSH_…=…; <command>"
```

dsh itself stays on Windows; the executor spawns `wsl.exe` through `ctx.subprocess`, never through `ctx.sandbox.confine()`.

## Install

From the plugin market, or:

```bash
dsh plugin --profile desktop add dsh-wsl-shell
```

The package ships a `cordis.patch.yml` that inserts the plugin when the package is in `dsh.profile.bundles`:

```yaml
- insert:
    - id: wsl-shell
      name: dsh-wsl-shell
```

Fully restart DSH afterwards. During development you can point the patch at an absolute path instead; dsh-app-boot converts it to a `file:` URL:

```yaml
- insert:
    - id: wsl-shell
      name: 'C:\Users\you\.dsh-plugins\wsl-shell\lib\index.js'
      config:
        distro: Ubuntu
```

## Config

| field | default | meaning |
|---|---|---|
| `distro` | `Ubuntu` | WSL distribution passed as `-d` |
| `wslPath` | `C:\Windows\System32\wsl.exe` | launcher; trusted as-is so the Windows `PATH` never picks a different `wsl.exe` |
| `bashPath` | `bash` | shell inside the distribution |
| `loginShell` | `false` | `-lc` instead of `-c` (sources `/etc/profile`, `~/.profile`) |
| `pathPrefix` | `$HOME/.local/bin:/usr/local/bin` | prepended to the inherited `PATH`; `''` disables it |
| `user` | unset | adds `-u <user>` |
| `extraEnv` | `{}` | extra `export NAME='value'` statements on the Linux side |
| `cwd` | `process.cwd()` | fallback workdir when the caller names none |
| `timeoutMs` | `120000` | default deadline |
| `maxTimeoutMs` | `600000` | hard cap a caller's `timeoutMs` is clamped to |
| `maxOutputBytes` | `64000` | per-stream in-memory tail |
| `maxSpillBytes` | `67108864` | per-stream spill-file cap |
| `graceMs` | `3000` | SIGTERM→SIGKILL grace handed to the subprocess layer |
| `maxConcurrency` | `4` | how many `wsl.exe` processes may run at once; the rest queue FIFO |
| `guard` | `strict` | `strict` refuses the destructive commands listed below; `off` disables the gate |
| `guardAllow` | `[]` | regular expressions; a matching command skips the gate |

Using a distribution other than the default:

```yaml
- insert:
    - id: wsl-shell
      name: dsh-wsl-shell
      config:
        distro: Debian
```

Run `wsl -l -v` on Windows to see the exact names. A name WSL does not know surfaces as a spawn failure with a hint in the command's stderr, not as a silent fallback.

## Destructive-command gate

There is no sandbox below WSL, so this gate is the only stop in front of the handful of operations that damage the machine or the distribution:

- `rm -rf /`, `rm -rf /*`, `rm -rf ~`, `rm -rf $HOME`
- `mkfs.*`
- `dd … of=/dev/…`
- `shutdown` / `reboot` / `poweroff` / `halt`
- `chmod 777 /`
- `chown -R … /`
- fork bombs (`:(){ :|:& };:`)
- `> /dev/sd*`, `> /dev/nvme*`, `> /dev/hd*`

A project-scoped `rm -rf node_modules` or `rm -rf build` is **not** on the list and runs normally. To opt a command back in:

```yaml
config:
  guardAllow:
    - '^rm -rf /$'          # exact command
    - '^mkfs\.ext4 /dev/sdb$'
```

Or turn the gate off entirely with `guard: off` — after that, nothing stops anything.

## Workdir handling

* A Windows workdir (`C:\…`) is passed to `wsl.exe` unchanged; WSL maps it onto `/mnt/c/…`. A missing directory stays a loud spawn failure.
* `/mnt/<letter>/…` is translated back to `<LETTER>:\…` and used as the Windows cwd, so `pwd` reports exactly the path the caller named.
* Any other Linux path (`/home/you`, `/tmp`) has no stable Windows form, so the process starts in the default cwd and the command is prefixed with `cd -- '<path>' && `.

## Why it is hand-written instead of subclassing

The plugin imports **only Node built-ins**. A profile's `node_modules` cannot resolve `@deepseek-ai/*` (`ERR_MODULE_NOT_FOUND` for `dsh-shell`, `dsh-pwsh-local` and `cordis` alike), so a hard import of `PwshLocalExecutor`/`ShellExecutor` would either fail to load or install a second copy of cordis whose `Service` identity does not interoperate with the running instance. The executor therefore re-implements the documented seam and registers itself with `ctx.provide('shell', executor)`.

The observable contract mirrors `@deepseek-ai/dsh-bash-local` 0.2.0: `resolve(request) -> spec`, `execute(spec) -> handle`, `sandboxMode` (`undefined`), a `result()` that rejects only for infrastructure failures, first-cause `timedOut`/`aborted` classification with the `BASH_TIMEOUT` code, bounded collect output with spill files, incremental `readOutput()` deltas, and a `done` that never rejects.

## Uninstall and rollback

This plugin **replaces** `ctx.shell`; the list of plugins that provide it is not additive. To get the native shell back:

1. remove `dsh-wsl-shell` from `dsh.profile.bundles` (and from the profile's dependencies), or delete the `- insert:` entry you added to `cordis.patch.yml`;
2. fully restart DSH.

Removing only the package while leaving the patch entry produces a load error, not a fallback.

## Known limits

* **No sandbox, by construction.** File writes, network calls and process control happen in WSL as your user. Treat every command as running outside the workspace boundary.
* **No DSH approval prompts.** Approval is the sandbox-escalation channel; without a sandbox there is nothing to escalate. The destructive-command gate is the replacement, and it is a fixed list, not a policy engine.
* **Kill is Windows-side.** Terminating a command kills the `wsl.exe` range; a process that the distribution started may outlive that kill inside the WSL VM.
* **One launch per command.** Every command is a fresh `wsl.exe` process (about 90 ms for the launcher itself); no persistent shell is kept. Foreground commands are capped by `maxConcurrency`; background jobs (`onExpiry: none`) hold their slot until they finish.
* **WSL must already work.** This plugin does not install WSL or a distribution. `wsl.exe` missing, WSL optional component missing, and unknown `distro` values all surface as launch errors.

## Test

The contract harness is a faithful stand-in for `@deepseek-ai/dsh-subprocess-local` (collect readers with spill, terminate, done), so the seam obligations can be exercised without the app. Run it with Windows Node against a real WSL distro:

```bash
node test\contract-harness.mjs
```

## License

MIT.
