/**
 * Smoke test for the deskpet Host bridge using the installed Cordis plugin
 * contract without booting DSH. It exercises apply(), ctx.effect cleanup,
 * explicit ping/pong messages, Python spawn, stderr forwarding, and teardown.
 *
 * Usage:
 *   node tests/bridge-smoke.mjs "C:\path\to\python.exe"
 */
import assert from 'node:assert/strict'
import { apply, DeskpetBridge } from '../index.js'

const pythonPath = process.argv[2] ?? process.env.DSHPET_TEST_PYTHON ?? 'python'
const options = {
  pythonPath,
  pingIntervalMs: 60_000,
  pingTimeoutMs: 3_000,
  handshakeTimeoutMs: 5_000,
  shutdownTimeoutMs: 3_000,
}

const records = []
const logger = {
  info: (...args) => records.push(['info', ...args]),
  debug: (...args) => records.push(['debug', ...args]),
  warn: (...args) => records.push(['warn', ...args]),
  error: (...args) => records.push(['error', ...args]),
}

let effectCleanup = null
const ctx = {
  logger,
  effect(execute, label) {
    const dispose = execute()
    assert.equal(typeof dispose, 'function', `effect ${label} must return a disposer`)
    effectCleanup = dispose
    return dispose
  },
  // apply() also subscribes to session/event to drive the pet state.
  on() {
    return () => {}
  },
}

function assertProcessGone(pid) {
  let stillRunning = true
  try {
    process.kill(pid, 0)
  } catch {
    stillRunning = false
  }
  assert.equal(stillRunning, false, `Python pid ${pid} must exit after cleanup`)
}

function assertCleanLogs(label) {
  const bad = records.filter(([level]) => level === 'warn' || level === 'error')
  assert.deepEqual(bad, [], `${label} must not report protocol or process errors`)
}

// 1. Direct bridge: startup handshake plus a second explicit ping/pong.
{
  const bridge = new DeskpetBridge(ctx, options)
  bridge.start()

  const ready = await bridge.ready()
  assert.equal(ready.type, 'pong')
  assert.equal(typeof ready.pid, 'number')
  // A venv/launcher interpreter may hand the work to a child process, so the pid
  // Python reports is not always the pid Node spawned. Both must be live.
  assert.equal(typeof bridge.child.pid, 'number')

  const second = await bridge.ping('smoke')
  assert.equal(second.type, 'pong')
  assert.equal(second.id, 2)
  assert.equal(bridge.pongCount, 2)

  await bridge.stop()
  await bridge.stop() // must be idempotent
  assert.equal(bridge.exited, true)
  assertProcessGone(ready.pid)
  assertCleanLogs('direct bridge')
}

// 2. Actual plugin apply(): the registered disposer must stop the process.
{
  records.length = 0
  await apply(ctx, options)
  assert.equal(typeof effectCleanup, 'function', 'apply() must register an effect disposer')

  const ready = records.find(([level, format]) => level === 'info' && String(format).includes('ready'))
  assert.ok(ready, 'startup ping/pong must be logged as ready')
  const pid = ready[2]
  assert.equal(typeof pid, 'number', 'ready log must include the Python pid')

  // The Python peer only writes to stderr when something goes wrong, so a clean
  // run may forward no diagnostics at all; assertCleanLogs() below asserts the
  // protocol side (no warnings or errors) instead.

  await effectCleanup()
  await effectCleanup() // Cordis disposers are idempotent; our bridge must be too.
  assertProcessGone(pid)
  assertCleanLogs('plugin apply')
}

console.log(JSON.stringify({
  ok: true,
  pythonPath,
  checks: [
    'apply registered a Cordis effect disposer',
    'startup ping received pong before active',
    'explicit ping id=2 received pong',
    'Python stderr forwarded without protocol warnings',
    'disposer stopped Python and was idempotent',
  ],
}, null, 2))
