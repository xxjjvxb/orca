# Issue 7936: macOS Login-Session Daemon Lifecycle

## Automated reproduction

`src/main/daemon/macos-login-session-lifecycle.test.ts` uses a real daemon server, authenticated clients, Unix socket, and live PTY registry with injected macOS audit-session scopes. Before the fix, the later-login client warm-attached the original PTY and returned `isNew: false`. The fixed contract rejects that client during hello, before session inventory or `createOrAttach`.

Run:

```sh
pnpm exec vitest run --config config/vitest.config.ts \
  src/main/daemon/daemon-login-session-history.test.ts \
  src/main/daemon/macos-gui-session-scope.test.ts \
  src/main/daemon/macos-login-session-lifecycle.test.ts
```

The suite separately covers:

- full logout/login: a changed audit-session scope cannot attach;
- WindowServer crash/restart: an unchanged scope warm-attaches;
- app crash/relaunch: an unchanged scope warm-attaches;
- normal quit/reopen: an unchanged scope warm-attaches;
- reboot: a changed boot UUID plus daemon loss creates a fresh PTY and discards prior-boot recovery bytes;
- fast user switching: a foreign scope is rejected without invalidating the original scoped daemon, and switching back can reattach;
- concurrent clients: clients in one scope share one PTY.

Fast user switching uses independent runtime directories for the two user accounts and proves each daemon/PTY remains independently attachable after the other account becomes active. A separate adversarial same-endpoint case proves a foreign scope cannot inspect or attach the switched-away account's daemon.

`daemon-init.test.ts` additionally proves a scope-rejected current daemon enters the existing exact-PID bounded replacement path, while a pre-scope daemon is adopted only after its verified process audit session matches.

## Safe macOS validation

These checks do not log out the user, kill WindowServer, or access the installed Orca daemon:

1. Run the focused suites above. The macOS-only resolver test reads the current test process with `/bin/launchctl print pid/<pid>` and asserts a valid UID/audit-session identity.
2. Run the daemon client/server, health, init, adapter, and idle-retirement suites. They use temporary directories and isolated socket/token files.
3. Build the main process and launch only the built daemon entry against a temporary runtime directory. Pass an injected old scope, create a disposable PTY, then connect with a different scope and verify hello rejection. Terminate only that recorded child PID and verify its socket/token disappear within the shutdown bound.
4. Repeat with the same scope and verify the daemon PID and PTY PID remain unchanged across client disconnect/reconnect.
5. Repeat with no scope to exercise the headless contract. This must retain existing unscoped behavior.

An optional manual qualification run may be performed only with explicit permission on a disposable macOS account or VM:

- normal quit/reopen and forced app-main crash must preserve terminals;
- fast-switch to a different account and back must preserve each account independently;
- a WindowServer-only restart should preserve terminals when the audit session survives;
- full logout/login must replace the old daemon and cold-resume rather than attach its PTYs;
- reboot must not claim a warm PTY survived.

Record the app PID, daemon PID, PTY PID, audit-session scope, and `isNew` result at each boundary. Never use `pkill -f orca`; target only fixture PIDs or the disposable qualification account.

## Reliability contract

- Invariant (`terminal-session.macos-login-scope`): a client can attach only to a daemon and PTYs in the same valid runtime/login-session scope.
- Failure source: issue 7936, including full logout and WindowServer-recovery reports.
- Oracle: a real-socket later-login client is rejected during hello, while same-scope recovery returns `isNew: false` with the original PTY PID.
- Gate: experimental entry `terminal-session.macos-login-scope` in `config/reliability-gates.jsonc`.
- Performance budget: one bounded `launchctl print pid/<pid>` and one bounded `sysctl kern.bootsessionuuid` at desktop startup, with no polling or hot-path inventory; one scope-tagged recovery slot avoids per-login disk growth.
- Diagnostics: daemon logs record accepted/rejected hello outcomes and the rejection reason without terminal output.

Provider/platform coverage:

| Area | Coverage |
| --- | --- |
| Local and daemon PTY | Real-socket lifecycle and built-daemon smoke cover attach identity and exact fixture cleanup. |
| SSH/headless | Unaffected: macOS `--serve` and non-GUI runtimes remain unscoped; unscoped built-daemon smoke passes. |
| WSL/Linux/Windows | Unaffected by runtime checks; focused daemon suites and Node typecheck pass. |
| Mobile/relay | Unaffected: clients continue through the owning desktop/headless runtime provider. |
| macOS GUI | Deterministic audit-scope resolver, lifecycle, history-isolation, and startup-replacement coverage passes. |

Residual gaps: destructive logout, WindowServer termination, reboot, and live multi-account switching were not run on the developer account. They remain optional qualification steps for a disposable account or VM.
