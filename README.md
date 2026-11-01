# dsh-deskpet

Minimal DSH Host plugin that starts one Python process and talks to it over
newline-delimited JSON on stdin/stdout. This is the integration layer only: it
does not call a model, read API keys, or start another Harness.

## Files

| Path | Purpose |
|---|---|
| [`index.js`](./index.js) | Cordis Host plugin, child-process lifecycle, JSON protocol, logging |
| [`python/deskpet_bridge.py`](./python/deskpet_bridge.py) | Python test peer: `ping` → `pong`, `shutdown` → `bye` |
| [`cordis.patch.yml`](./cordis.patch.yml) | Bundle patch that inserts the `deskpet` row and configures Python |
| [`package.json`](./package.json) | Bundle manifest (`dsh.bundle.patch`) and exports |
| [`tests/bridge-smoke.mjs`](./tests/bridge-smoke.mjs) | Host-contract smoke test using a mock `ctx` |
| [`locale/en.json`](./locale/en.json), [`locale/zh.json`](./locale/zh.json) | Plugin title and description |
| [`icon.svg`](./icon.svg) | Original plugin icon |

## Interface verification against this installation

Checked on this machine on 2026-10-31 (Asia/Shanghai):

| Item | Value |
|---|---|
| Desktop runtime package | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5** at `D:\deepseekharness\resources\app.asar\dsh\package.json` |
| Host framework | `@deepseek-ai/cordis` **4.0.5** |
| Node used by the runtime | **24.21.0** |
| Python used by this config | **3.14.6** at `C:\Users\chen1\AppData\Local\Programs\Python\Python314\python.exe` |
| `dsh --version` on `PATH` | **0.2.1-rc.2** |

The `dsh` on `PATH` is the standalone CLI and is *not* the Desktop Host that
loaded this plugin. The live Host is the rc.5 Desktop runtime above, so the
plugin was verified against rc.5 and Cordis 4.0.5.

The specific interfaces used were read from the installed runtime:

- **Function plugin shape:** `Plugin.Function` is `(ctx, config) => any`; an
  async function is valid. See Cordis `src/registry.ts` lines 120–124.
- **Cleanup ownership:** `ctx.effect(execute, label)` runs `execute`
  immediately, collects its returned disposer, and runs it in reverse order
  when the fiber unloads. See Cordis `src/fiber.ts` lines 402–418 and
  504–560.
- **Activation timing:** `_reload()` awaits the plugin callback's promise
  before the fiber becomes `ACTIVE`. See Cordis `src/fiber.ts` lines 646–664.
  Because `apply()` waits for the startup `pong`, the live `active` row in
  `list_plugins` is evidence that the real plugin completed ping/pong.
- **Bundle format:** `package.json` declares `dsh.bundle.patch`; the patch
  inserts row `deskpet`. Installed with `plugin_manager` `install_bundle`,
  which returned `application: "applied"`.

`Config.listConfigs` reports `status: "absent"` for this row because the plugin
intentionally does not export a Schemastery `Config` schema. Keeping the bundle
dependency-free was more important for this minimal bridge. The config is
validated in `normalizeConfig()` in [`index.js`](./index.js). If settings-panel
editing is required later, the next step is to add a `Config` export and a
Schemastery dependency.

## Protocol

One JSON object per line, in both directions. Python stdout is protocol-only;
Python diagnostics go to stderr and are forwarded to the Host logger with a
`[python]` prefix.

Host → Python:

```json
{"type":"ping","id":1,"reason":"startup","sentAt":"2026-10-31T13:30:00.000Z"}
{"type":"ping","id":2,"reason":"heartbeat","sentAt":"2026-10-31T13:30:15.000Z"}
{"type":"shutdown","id":3}
```

Python → Host:

```json
{"type":"pong","id":1,"pid":12345,"echo":"2026-10-31T13:30:00.000Z"}
{"type":"bye","id":3,"pid":12345}
```

Startup rules:

1. Spawn Python with pipes for stdin/stdout/stderr.
2. Wait for the OS `spawn` event.
3. Send `ping` with a fresh id and wait for the matching `pong`.
4. Only then let `apply()` resolve; start the heartbeat.
5. On unload, send `shutdown`, close stdin, wait up to
   `shutdownTimeoutMs`, then terminate the process if necessary. `stop()` is
   idempotent.

A non-JSON or non-object stdout line is logged as a warning and never treated
as a pong, so a stray debug `print()` cannot accidentally satisfy the
handshake.

## Configuration

The active values are in [`cordis.patch.yml`](./cordis.patch.yml):

| Field | Default | Meaning |
|---|---|---|
| `pythonPath` | `DSHPET_PYTHON`, else `python` | Interpreter path or command name |
| `pingIntervalMs` | `15000` | Heartbeat interval |
| `pingTimeoutMs` | `5000` | Per-ping timeout |
| `handshakeTimeoutMs` | `5000` | Spawn plus startup-pong timeout |
| `shutdownTimeoutMs` | `3000` | Graceful shutdown wait before terminate |

The Python script path is **not** configurable: it is resolved from the plugin
module URL as `python/deskpet_bridge.py`, so moving or renaming the plugin
directory keeps the script next to `index.js`.

To change the interpreter, edit the bundle patch and let the profile
recompose/restart, or add a higher-priority override in
`C:\Users\chen1\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- id: deskpet
  name: dsh-deskpet
  config:
    pythonPath: 'C:\path\to\python.exe'
    pingIntervalMs: 15000
    pingTimeoutMs: 5000
    handshakeTimeoutMs: 5000
    shutdownTimeoutMs: 3000
```

The profile override replaces the whole `config` object; omitted fields are
filled by `normalizeConfig()` defaults.

## Current installation state

`plugin_manager` installed this workspace directory as a linked profile
dependency and selected the bundle:

- Profile dependency:
  `dsh-deskpet`: `link:C:/Users/chen1/Desktop/deepseek-harness/default-workspace/dsh-deskpet`
- Bundle row: `include:deskpet` (`patchId: deskpet`)
- Initial install result: `application: "applied"`, no warnings
- At the end of verification the row was enabled and the Python child was
  running

Do not edit the profile's `package.json` or `cordis.patch.yml` by hand to
install it; use `plugin_manager`.

## Verification performed

### 1. Host-contract smoke test

Because the DSH tool sandbox blocks named-pipe stdio for programs it spawns,
this test was run once with full local access. The plugin Host itself is not
under that tool sandbox; the live process below confirms that.

```powershell
node tests/bridge-smoke.mjs "C:\Users\chen1\AppData\Local\Programs\Python\Python314\python.exe"
```

Result:

```json
{
  "ok": true,
  "pythonPath": "C:\\Users\\chen1\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",
  "checks": [
    "apply registered a Cordis effect disposer",
    "startup ping received pong before active",
    "explicit ping id=2 received pong",
    "Python stderr forwarded without protocol warnings",
    "disposer stopped Python and was idempotent"
  ]
}
```

This exercised the real `apply()` path with a mock Cordis context, a real
Python 3.14.6 child, startup `ping`/`pong`, an extra explicit ping, stderr
forwarding, idempotent cleanup, and process exit.

### 2. Live plugin and process lifecycle

Observed with Windows process inspection (outside the tool sandbox because the
sandbox hides the Host's child processes):

| Step | Python processes |
|---|---|
| Install and activate | one: PID 33948, parent 20756 |
| Disable `include:deskpet` | zero |
| Re-enable | one: PID 30660 |
| Disable again | zero |
| Re-enable again | one: PID 26088 |

The command line in every running case was the configured interpreter plus the
plugin-relative script:

```text
C:\Users\chen1\AppData\Local\Programs\Python\Python314\python.exe
C:\Users\chen1\Desktop\deepseek-harness\default-workspace\dsh-deskpet\python\deskpet_bridge.py
```

No duplicate Python process and no old PID remained after either re-enable.
The final live row had `fiberPhase: "active"`.

### 3. Configuration and metadata checks

- `package.json` and both locale files parse as JSON.
- The patch loaded successfully through DSH's loader and `plugin_manager`
  (installation returned `application: "applied"`).
- The SVG icon parses as XML.
- `Config.listConfigs` finds `include:deskpet`; schema status is `absent`, as
  explained above.
- No model, LLM, credential, or API-key code is imported or called.

## Next steps

1. Add a Schemastery `Config` schema if the path must be editable from the
   settings UI.
2. Implement the actual desktop-pet window and richer commands in
   `python/deskpet_bridge.py`.
3. Add request/response routing and typed events on top of the same line
   protocol.
