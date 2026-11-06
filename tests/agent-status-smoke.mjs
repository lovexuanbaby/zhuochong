import assert from 'node:assert/strict'
import { DeskpetAgentState } from '../index.js'

function harness(initial = []) {
  const listeners = new Map()
  const sent = []
  const bridge = { writeMessage: message => sent.push(message), stopping: false, exited: false }
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
  }
  const tracker = new DeskpetAgentState(ctx, bridge, { list: () => initial })
  return {
    tracker, bridge, sent, listeners,
    emit: (name, ...args) => listeners.get(name)?.(...args),
    states: () => sent.map(message => message.state),
  }
}

const a = { id: 'a', status: 'idle' }
const b = { id: 'b', status: 'running' }
const h = harness()
assert.deepEqual(h.sent, [], 'wait for Python handshake')
h.tracker.activate()
h.emit('agent/status', { agent: a, status: 'running' })
h.emit('agent/status', { agent: a, status: 'running' })
h.emit('agent/status', { agent: a, status: 'idle' })
assert.deepEqual(h.states(), ['idle', 'thinking', 'idle'])
assert.ok(h.sent.every(message => message.type === 'pet.state'))

h.emit('agent/status', { agent: a, status: 'running' })
h.emit('agent/status', { agent: b, status: 'running' })
h.emit('agent/status', { agent: a, status: 'idle' })
assert.equal(h.states().at(-1), 'thinking', 'other agent is still running')
h.emit('agent/disposed', { agent: b })
assert.equal(h.states().at(-1), 'idle', 'disposal clears busy state')

const replacement = { id: 'a', status: 'running' }
h.emit('agent/created', { agent: replacement })
h.emit('agent/disposed', { agent: a })
assert.equal(h.states().at(-1), 'thinking', 'old instance cannot clear replacement')
h.emit('agent/status', { agent: replacement, status: 'idle' })
const count = h.sent.length
h.emit('agent/status', { agent: a, status: 'unknown' })
h.emit('agent/status', { status: 'running' })
h.emit('session/event', { type: 'turn/end' })
assert.equal(h.sent.length, count, 'invalid status and turn events do not change availability')
h.bridge.stopping = true
h.emit('agent/status', { agent: a, status: 'running' })
assert.equal(h.sent.length, count, 'no writes during teardown')
h.tracker.dispose()
h.tracker.dispose()
assert.equal(h.listeners.size, 0, 'listeners cleaned up idempotently')

const startup = harness([b])
startup.tracker.activate()
assert.deepEqual(startup.states(), ['thinking'], 'snapshot restores an already running agent')
startup.tracker.dispose()
const pending = harness()
pending.emit('agent/status', { agent: a, status: 'running' })
pending.emit('agent/status', { agent: a, status: 'idle' })
pending.tracker.activate()
assert.deepEqual(pending.states(), ['idle'], 'handshake flushes latest state only')
pending.tracker.dispose()
const stopped = harness([b])
stopped.tracker.dispose()
stopped.tracker.activate()
assert.deepEqual(stopped.sent, [], 'late handshake cannot reactivate disposed tracker')

const makeAgent = id => ({ id, session: { id }, status: 'idle' })
const start = (h, agent, turn) => h.emit('session/event', agent.session, { type: 'turn/start', data: { turn } })
const end = (h, agent, turn, kind) => h.emit('session/event', agent.session, {
  type: 'turn/end', data: { turn, reason: { kind } },
})

// Result and availability are independent, including unknown terminal reasons.
for (const [kind, state] of [['completed', 'done'], ['error', 'error'], ['aborted', 'aborted'], ['blocked', 'ended']]) {
  const agent = makeAgent(kind)
  const h = harness([agent])
  h.tracker.activate()
  h.emit('agent/status', { agent, status: 'running' })
  start(h, agent, 1)
  end(h, agent, 1, kind)
  assert.deepEqual(h.sent.at(-1), { type: 'pet.state', state: 'thinking', result: { id: 1, state } })
  h.emit('agent/status', { agent, status: 'idle' })
  assert.deepEqual(h.sent.at(-1), { type: 'pet.state', state: 'idle', result: { id: 1, state } })
  const count = h.sent.length
  end(h, agent, 1, kind)
  h.emit('agent/status', { agent, status: 'idle' })
  assert.equal(h.sent.length, count, 'duplicate end/idle must not replay results')
  h.emit('agent/status', { agent, status: 'running' })
  assert.deepEqual(h.sent.at(-1), { type: 'pet.state', state: 'thinking' }, 'new run clears result')
  start(h, agent, 2)
  end(h, agent, 1, 'error')
  assert.equal(h.sent.at(-1).result, undefined, 'late older end cannot overwrite next turn')
  h.tracker.dispose()
}

// Several turns can run without an idle edge; a result must still be cleared.
{
  const agent = makeAgent('continuous')
  const h = harness([agent])
  h.tracker.activate()
  h.emit('agent/status', { agent, status: 'running' })
  start(h, agent, 1)
  end(h, agent, 1, 'completed')
  start(h, agent, 2)
  assert.deepEqual(h.sent.at(-1), { type: 'pet.state', state: 'thinking' })
  end(h, agent, 2, 'aborted')
  assert.equal(h.sent.at(-1).result.state, 'aborted')
  const count = h.sent.length
  start(h, agent, 1)
  start(h, agent, 2)
  end(h, agent, 3, 'error')
  h.emit('session/event', { id: agent.id }, { type: 'turn/start', data: { turn: 3 } })
  h.emit('session/event', agent.session, { type: 'turn/end', data: { turn: '2' } })
  assert.equal(h.sent.length, count, 'stale, unpaired, malformed and other-session events ignored')
  h.tracker.dispose()
}

// Busy aggregation survives completion, a late end, and disposal of another agent.
{
  const a = makeAgent('a'), b = makeAgent('b')
  const h = harness([a, b])
  h.tracker.activate()
  for (const agent of [a, b]) {
    h.emit('agent/status', { agent, status: 'running' })
    start(h, agent, 1)
  }
  end(h, a, 1, 'error')
  h.emit('agent/status', { agent: a, status: 'idle' })
  h.emit('agent/disposed', { agent: a })
  assert.equal(h.sent.at(-1).state, 'thinking')
  assert.equal(h.sent.at(-1).result.state, 'error')
  // Also tolerate idle arriving before the paired end.
  h.emit('agent/status', { agent: b, status: 'idle' })
  end(h, b, 1, 'completed')
  assert.deepEqual(h.sent.at(-1), { type: 'pet.state', state: 'idle', result: { id: 2, state: 'done' } })
  h.tracker.dispose()
}

// Ignore retired instances even when ids are reused; no stale running latch.
{
  const old = makeAgent('same'), fresh = makeAgent('same')
  const h = harness([old])
  h.tracker.activate()
  h.emit('agent/status', { agent: old, status: 'running' })
  start(h, old, 1)
  fresh.status = 'running'
  h.emit('agent/created', { agent: fresh })
  start(h, fresh, 2)
  end(h, old, 1, 'error')
  h.emit('agent/status', { agent: old, status: 'running' })
  h.emit('agent/disposed', { agent: old })
  assert.equal(h.sent.at(-1).result, undefined)
  end(h, fresh, 2, 'completed')
  h.emit('agent/status', { agent: fresh, status: 'idle' })
  assert.equal(h.sent.at(-1).state, 'idle')
  h.tracker.dispose()
}

// Loading mid-turn still receives the live end; idle history is not a result.
{
  const agent = makeAgent('startup-result')
  agent.status = 'running'
  const h = harness([agent])
  end(h, agent, 7, 'completed')
  h.emit('agent/status', { agent, status: 'idle' })
  assert.deepEqual(h.sent, [], 'no protocol before handshake')
  h.tracker.activate()
  assert.deepEqual(h.sent, [{ type: 'pet.state', state: 'idle', result: { id: 1, state: 'done' } }])
  h.bridge.child = { stdin: { writable: false } }
  h.emit('agent/status', { agent, status: 'running' })
  assert.equal(h.sent.length, 1, 'closed pipe does not throw or send')
  h.tracker.dispose()
  const idle = harness([makeAgent('idle-history')])
  idle.tracker.activate()
  end(idle, idle.tracker.agents.get('idle-history'), 2, 'completed')
  assert.deepEqual(idle.states(), ['idle'])
  idle.tracker.dispose()
}
console.log('agent/status smoke: passed (availability, results, concurrency, continuous turns, stale events, startup, cleanup)')
