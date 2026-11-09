# dsh-deskpet

A DSH Host plugin for a PySide6 desktop pet. The Host owns one Python child
process; the two sides exchange newline-delimited JSON over stdin/stdout. The
pet includes a small chat dialog whose replies use the DSH-configured model.
Credentials stay owned by DSH: the plugin reads no key files and starts no
second Harness.

The current local installation candidate is **0.2.0-rc.1**. See
[`docs/INSTALL.md`](./docs/INSTALL.md) for setup, diagnostics, settings, and data
handling. Release artifacts are produced by `npm run release:check`.

## Files

| Path | Purpose |
|---|---|
| [`index.js`](./index.js) | Cordis Host plugin, child-process lifecycle, JSON protocol, logging |
| [`config.js`](./config.js), [`python-runtime.js`](./python-runtime.js) | Real Schemastery settings schema and portable interpreter discovery |
| [`scripts/setup.ps1`](./scripts/setup.ps1), [`scripts/doctor.ps1`](./scripts/doctor.ps1) | Isolated Python environment installation and read-only diagnosis |
| [`python/deskpet_bridge.py`](./python/deskpet_bridge.py) | Python test peer: `ping` → `pong`, `shutdown` → `bye`, task-state and chat routing |
| [`python/pet_windows.py`](./python/pet_windows.py) | Desktop-pet window: frameless always-on-top robot plus the chat dialog |
| [`requirements.txt`](./requirements.txt) | Pinned UI dependency (`PySide6-Essentials==6.12.0`) |
| [`python/pet.py`](./python/pet.py) | Legacy stdin/stdout test peer (not spawned by the plugin) |
| [`cordis.patch.yml`](./cordis.patch.yml) | Bundle patch that inserts the `deskpet` row and configures Python |
| [`package.json`](./package.json) | Bundle manifest (`dsh.bundle.patch`) and exports |
| [`tests/bridge-smoke.mjs`](./tests/bridge-smoke.mjs) | Host-contract smoke test using a mock `ctx` |
| [`tests/chat-host-smoke.mjs`](./tests/chat-host-smoke.mjs) | Direct-model chat smoke test with mock `llm`/`agentDefaultModel` services |
| [`tests/chat-ui-smoke.py`](./tests/chat-ui-smoke.py) | Offscreen chat-dialog smoke test (submit, reply, failure, long text) |
| [`test.mjs`](./test.mjs) | Legacy manual protocol test (not part of the automated suite) |
| [`locale/en.json`](./locale/en.json), [`locale/zh.json`](./locale/zh.json) | Plugin title and description |
| [`icon.svg`](./icon.svg) | Original plugin icon |

## Interface verification against this installation

Verified against the Desktop runtime that loaded this plugin:

| Item | Value |
|---|---|
| Desktop runtime package | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5** |
| Host framework | `@deepseek-ai/cordis` **4.0.5** |
| Node used by the runtime | **24.21.0** |
| Python used in local verification | **3.14.6**, including a fresh isolated environment |
| PySide6 | **6.12.0** |

The specific interfaces used were read from the installed runtime:

- **Function plugin shape:** `Plugin.Function` is `(ctx, config) => any`; an
  async function is valid.
- **Cleanup ownership:** `ctx.effect(execute, label)` runs `execute`
  immediately, collects its returned disposer, and runs it when the fiber
  unloads.
- **Activation timing:** `apply()` waits for the startup `pong` before the
  fiber becomes active, so an `active` row is evidence that the real bridge
  completed ping/pong.
- **Bundle format:** `package.json` declares `dsh.bundle.patch`; the patch
  inserts row `deskpet`. Installed with `plugin_manager` `install_bundle`,
  which returned `application: "applied"`.
- **Model access:** replies use the existing DSH `llm` service with the route
  from `agentDefaultModel`; the plugin reads no credential and needs no second
  API key.
- **Session boundary:** chat and memory live in the plugin's own files; no DSH
  session is created or written.

Configuration is exposed through the real Schemastery `Config` from
[`config.js`](./config.js), pinned to the installed Host's version 3.18.5.
The native Cordis `resolveConfig()` contract is verified; runtime normalization
also validates paired model overrides and resolves a blank Python path.

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
{"type":"ready"}
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

### Task state and chat

These lines reuse the same request/response protocol after the handshake; they
do not change startup or shutdown:

```json
{"type":"pet.state","state":"thinking"}
{"type":"pet.state","state":"thinking","result":{"id":1,"state":"done"}}
{"type":"pet.state","state":"idle","result":{"id":1,"state":"done"}}
{"type":"chat","id":7,"text":"帮我看看 README"}
```

```json
{"type":"chat/accepted","id":7}
{"type":"chat/reply","id":7,"text":"README 主要讲了协议和安装步骤……","reason":"completed"}
{"type":"chat/error","id":7,"message":"模型调用失败的原因"}
{"type":"chat/history","entries":[{"role":"user","text":"…","time":"2026-11-05T09:00:00+08:00"}]}
{"type":"chat/memory","count":12,"updatedAt":"2026-11-05T09:00:00+08:00"}
{"type":"chat/memory/details","id":1,"revision":0,"enabled":true,"items":[{"id":"…","kind":"preference","text":"喜欢青色"}]}
{"type":"chat/memory/error","id":1,"message":"记忆保存失败，原条目已保留"}
```

`pet.state` follows live `agent/status` events (`{ agent, status }`):
`running` maps to `thinking`; once every observed agent is `idle` (or disposed),
the activity returns to `idle`. On activation,
`agents.list()` seeds agents already running; updates received before the Python
handshake are coalesced and sent after it. Duplicate states do not restart the
animation, and unloading removes the subscriptions. Agent instances are tracked
separately so disposing an old instance cannot clear a replacement's busy state.
`session/event` provides results separately: `turn/end` maps `completed` to
`done`, `error` to `error`, `aborted` to `aborted`, and other reasons to `ended`.
Session identity and turn number reject stale/duplicate results. A plugin loaded
mid-turn can accept the live end of its exact running agent without having seen
the start; an idle session's history is not replayed.

The optional `result` contains a monotonic `id` and terminal `state`. Python
keeps the result bubble for 3.8 seconds even when activity becomes idle; it then
returns to **空闲中，随时待命** (or the thinking bubble if work remains). While
any agent is running the pet keeps its thinking expression; when idle it can
briefly play the result animation. Repeating an id does not extend its deadline
or replay an expired result. A new run or `turn/start` clears the old result
immediately, including consecutive turns in one running interval. When several
agents finish, the latest accepted result replaces the previous notification.
Omitting `result` clears a notification; idle alone never means success.
Legacy `pet.state` terminal values remain supported by Python.
Chat messages keep the same line framing:
`id` is echoed back, `reason` is `completed`/`truncated`, and failures arrive as
`chat/error` so the dialog never stays pending without an explanation. Chat ids
are numbered independently from ping ids. `chat/history` carries the persisted
conversation back to the dialog once at plugin startup. The conversation is
stored by the plugin (see below) and is never written to a DSH session log, so
nothing from the pet dialog appears in the DSH conversation.

## Chat dialog

Click the robot's screen face or use the right-click menu item
**打开对话框**. The dialog keeps its history while hidden and offers:

- Enter to send, Esc (or ✕) to hide;
- a muted **DSH 正在思考…** line while the Host works on the request;
- pet replies as left bubbles, your own messages as right bubbles, and
  failures as red bubbles;
- input disabled while a request is outstanding, re-enabled on reply or error;
- the saved conversation is restored on open, with a date divider per day.

### How the Host answers a message

The plugin does not create a session, a second Harness, or an API key. It calls
the model that the user's DSH installation is already configured with:

1. `index.js` → `DeskpetChat` resolves the route from
   `agentDefaultModel.currentSelection()` (or the `chatProvider`/`chatModel`
   config override);
2. it streams the request through `ctx.llm.stream({ provider, model, messages,
   system, maxTokens, signal })` — the same service the DSH agent loop uses, so
   the user's provider, credentials, and model settings apply unchanged;
3. text deltas are assembled locally into the reply and sent to Python as
   `chat/reply`.

### Data and privacy

- Chat text is sent to the provider/model configured in DSH. When long-term
  memory is enabled, the recent transcript is also sent periodically to the
  same model to distil a user profile.
- Chat history and the distilled profile are stored locally as plaintext JSON
  under `$DSH_HOME/deskpet/` by default. They are not encrypted.
- The pet does not create or write a DSH session, so pet chat is separate from
  the DSH conversation log. It still uses DSH's configured model credentials.
- `chatHistoryPath` and `chatMemoryPath` control where the local files live;
  `chatMemoryEnabled: false` disables profile extraction and injection.

### Memory (conversation persistence)

The pet is meant to be a companion that remembers, so the conversation is saved
across restarts instead of living only in the dialog:

- every completed user/assistant turn is appended to
  `$DSH_HOME/deskpet/chat-history.json` (override with `chatHistoryPath`);
- writes are atomic (temp file + rename) and a corrupted file is renamed to
  `chat-history.json.corrupt-<timestamp>` instead of blocking chat;
- on startup the Host loads the file, keeps the most recent
  `chatHistoryMessages` turns as model context, and sends the retained history
  to Python as one `chat/history` message, so reopening the dialog shows the
  previous conversation (grouped by date).
- `chatHistoryMaxMessages` caps the stored/displayed history; the plugin also
  saves synchronously on unload so the last turn is not lost.

None of this touches a DSH session: the file is the pet's own memory.

### Long-term memory (a pet that understands you over time)

Raw history only reaches back `chatHistoryMessages` messages, so the pet also
distils a compact user profile and grows it as you chat:

- every `chatMemoryUpdateEveryTurns` completed turns, the plugin makes one
  lightweight model call (`memoryExtractionPrompt`) that merges the recent
  conversation with the existing profile and outputs a JSON list of facts
  (`preference` / `habit` / `goal` / `fact` / `relation`, at most
  `chatMemoryMaxFacts` items);
- the profile is stored at `$DSH_HOME/deskpet/user-memory.json` (atomic write,
  corrupted files quarantined) and is loaded on startup;
- after loading, the profile is appended to the system prompt of every reply,
  so the pet keeps using what it learned even after history rolls over;
- the dialog title shows **已记住 N 件事** so the user can see the pet getting
  to know them;
- failures never block chat: invalid model output keeps the previous profile,
  and the next threshold retries;
- `chatMemoryEnabled: false` turns the whole layer off.

None of this touches a DSH session either: `chat-history.json` and
`user-memory.json` are the pet's own files.

## Configuration

The chat dialog's **记忆** button opens a refreshable list. Deletion uses a
stable fact id and snapshot revision, asks for confirmation, and updates the UI
only after atomic persistence succeeds. An expired list must be refreshed.
Requests time out after 15 seconds and can be retried by refreshing.

Deleting a fact preserves chat history, stops re-distilling earlier user turns,
and filters the normalized text hash of the removed fact. New paraphrases may
still be learned from later conversations; this is not erasure of chat history
or provider-side data. Storage remains version 1 with additive `forgottenAfter`
and `forgottenFactHashes` fields. Older plugin versions do not enforce these
deletion rules; back up data before downgrading.

Python → Host uses `memory/list` with request `id`, and `memory/delete` with
`id`, `factId`, and `revision`. Host replies with `chat/memory/details`
(`id`, `revision`, `enabled`, `items`) or `chat/memory/error` (`id`, `message`).

The active values are in [`cordis.patch.yml`](./cordis.patch.yml):

| Field | Default | Meaning |
|---|---|---|
| `pythonPath` | blank: automatic discovery | Explicit path → DSHPET_PYTHON → managed environment → PATH → standard Windows installation |
| `pingIntervalMs` | `15000` | Heartbeat interval |
| `pingTimeoutMs` | `5000` | Per-ping timeout |
| `handshakeTimeoutMs` | `5000` | Spawn plus startup-pong timeout |
| `shutdownTimeoutMs` | `3000` | Graceful shutdown wait before terminate |
| `chatProvider` / `chatModel` | DSH `agentDefaultModel` | Pin the model route; unset reuses the user's current DSH default |
| `chatSystemPrompt` | built-in 桌宠 prompt | System prompt sent with every pet conversation |
| `chatHistoryMessages` | `40` | Most messages carried into one request as model context |
| `chatHistoryMaxMessages` | `200` | Most messages kept in the saved/displayed history |
| `chatHistoryPath` | `$DSH_HOME/deskpet/chat-history.json` | Where the pet's conversation memory is stored |
| `chatMemoryEnabled` | `true` | Distil and inject the long-term user profile |
| `chatMemoryUpdateEveryTurns` | `4` | Completed turns between profile distillation calls |
| `chatMemoryMaxFacts` | `40` | Most facts kept in the distilled profile |
| `chatMemoryTranscriptMessages` | `24` | Recent messages fed to one distillation call |
| `chatMemoryPath` | `$DSH_HOME/deskpet/user-memory.json` | Where the long-term profile is stored |
| `chatMaxTokens` | `1024` | Output-token cap per reply |
| `chatTimeoutMs` | `180000` | How long the dialog waits for one model reply before reporting a timeout |

The Python script path is **not** configurable: it is resolved from the plugin
module URL as `python/deskpet_bridge.py`, so moving or renaming the plugin
directory keeps the script next to `index.js`.

To change the interpreter, edit the bundle patch and let the profile
recompose/restart, or add a higher-priority override in
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

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

Install the Python UI dependency into the interpreter named by `pythonPath`:

```powershell
python -m pip install -r requirements.txt
```

`plugin_manager` installs the JS bundle; it does not install Python packages.

## Current installation state

The bundle is installed as a linked profile dependency and selected as a patch
layer:

- Bundle row: `include:deskpet` (`patchId: deskpet`)
- Install result: `application: "applied"`, no warnings
- At the end of verification the row was enabled and the Python child was
  running

Install and remove it through `plugin_manager` (or the **Plugins** page); do not
hand-edit the profile's `package.json` or `cordis.patch.yml` to install it.

## Verification performed

### 1. Automated smoke tests

| Test | Coverage | Result |
|---|---|---|
| `tests/config-smoke.mjs` | native schema shape, defaults, invalid inputs, interpreter selection | 10/10 |
| `tests/chat-host-smoke.mjs` | request shape, context, history persistence, long-term memory, stable-ID memory management, stale-write protection, failures, timeout, cleanup | 24/24 |
| `tests/chat-ui-smoke.py` | dialog submit/reply/continuation/error, history restore, date dividers, memory view/delete confirmation, save failure, timeout and stale response handling | 36/36 |
| `tests/bridge-smoke.mjs` | apply cleanup, ping/pong, process exit, idempotent stop, state forwarding, EOF and timeout termination | 8/8 |
| `tests/agent-status-smoke.mjs` | availability/results, concurrency, continuous turns, stale instances/events, startup, cleanup | Passed |
| `tests/agent-status-ui-smoke.py` | 11 queue → Qt transitions, result deadlines, concurrency, legacy/malformed input, ping/shutdown | Passed |

The agent-status contract was checked against the installed runtime on
2026-11-06. These new checks use mock Host events and an offscreen Qt window;
they do not constitute a live DSH task verification after plugin reload.
Separate live verification on November 6–7, 2026 has now confirmed plugin
normal completion, cancellation, recovery, concurrent agents, idle unload/reload,
reload during an active task,
and history/memory-hint restoration. User-observed pet transitions were
cross-checked against real `turn/end` events and process counts where applicable; see
[`docs/live-status-validation.md`](./docs/live-status-validation.md) for evidence
and the remaining scenarios.

The bridge smoke test spawns a real Python child, so it needs full local access
on Windows; the plugin Host itself is not under the tool sandbox.

### 2. Live checks

- Enable/disable through `plugin_manager`: disabling leaves zero Python
  children, enabling restores one active row.
- Chat through the pet dialog uses the model already configured in DSH; the DSH
  conversation list stays unchanged (no session is created or written).
- History: restarting the plugin restores the previous conversation in the
  dialog, with one date divider per day.
- Long-term memory: after four turns the pet distils a user profile, shows
  **已记住 N 件事**, answers questions from it, and keeps it across restarts.
- Metadata: `package.json`, both locale files and the SVG parse; the bundle
  patch loads through the DSH loader and `plugin_manager`.
- Packed file list: `package.json` `files` includes `python/*.py` and
  `requirements.txt`, so the PySide6 window module is not omitted from a packed
  bundle.

## Next steps

The synchronized development workflow is in
[`docs/desktop-pet-workflow.md`](./docs/desktop-pet-workflow.md); the immediate
implementation and live-verification checklist is in
[`docs/next-phase.md`](./docs/next-phase.md). Activity/result integration,
memory management, and automated regressions are complete. Core live checks have
passed; remaining DSH scenarios are tracked separately in the validation record.
Config settings, portable Python discovery, isolated environment setup and
candidate-package checks are implemented. The user confirmed acceptance testing
passed on November 9, 2026 and authorized the `0.2.0-rc.1` prerelease.
Timers/reminders and a bundled Python executable remain future
features, not blockers for the documented Python-environment delivery option.

See [`docs/RELEASE-STATUS.md`](./docs/RELEASE-STATUS.md) in the source checkout
for the completed checks and user acceptance record.
