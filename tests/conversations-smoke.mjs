import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeskpetChat } from '../index.js'
import { DshSessions } from '../dsh-sessions.js'

const checks = []
async function check(name, fn) { await fn(); checks.push(name) }
const entry = text => ({role: 'user', text, time: '2026-11-19T10:00:00Z'})
function localFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-conversations-')), sent = []
  const options = {chatHistoryPath: join(dir, 'history.json'), chatMemoryPath: join(dir, 'memory.json'), chatTimerPath: join(dir, 'timers.json'), chatCompanionPath: join(dir, 'companion.json'), chatEventPath: join(dir, 'events.json'), chatHistoryMaxMessages: 200, chatHistoryMessages: 20, chatMemoryEnabled: false, chatTimerEnabled: false, chatEventsEnabled: false, chatEmotionEnabled: false, chatProactiveEnabled: false, chatTimeoutMs: 1000, chatSystemPrompt: '桌宠', chatMaxTokens: 64}
  writeFileSync(options.chatHistoryPath, JSON.stringify({version: 1, messages: [entry('原对话')]}))
  const chat = new DeskpetChat({logger: {warn() {}, info() {}}}, {writeMessage: m => sent.push(m)}, options)
  return {chat, sent, options}
}
await check('Legacy history survives new/switch/restart with isolated model context', async () => {
  const h = localFixture(); await h.chat.loadHistory()
  const first = h.chat.conversationId
  await h.chat.manageConversations({action: 'new', id: 1, revision: 0})
  assert.deepEqual(h.chat.entries, [])
  assert.equal(h.chat.archivedConversations[0].id, first)
  h.chat.entries.push(entry('第二个对话'))
  h.chat.persistHistorySync()
  const second = h.chat.conversationId
  await h.chat.manageConversations({action: 'select', sessionId: first, id: 2, revision: h.chat.historyRevision})
  assert.equal(h.chat.entries[0].text, '原对话')
  assert.ok(!JSON.stringify(h.chat.historyMessages({provider: 'p', model: 'm'})).includes('第二个对话'))
  const restored = new DeskpetChat(h.chat.ctx, h.chat.bridge, h.options)
  await restored.loadHistory()
  assert.equal(restored.conversationId, first)
  assert.equal(restored.archivedConversations[0].id, second)
})
await check('Clear/delete scopes preserve other conversations and separate memory files', async () => {
  const h = localFixture(); await h.chat.loadHistory()
  const first = h.chat.conversationId
  await h.chat.manageConversations({action: 'new', revision: 0, id: 1})
  h.chat.entries.push(entry('当前对话')); h.chat.persistHistorySync()
  writeFileSync(h.options.chatMemoryPath, 'memory must stay')
  await h.chat.manageConversations({action: 'clear', sessionId: first, revision: h.chat.historyRevision, id: 2})
  assert.equal(h.chat.entries[0].text, '当前对话')
  assert.deepEqual(h.chat.archivedConversations[0].messages, [])
  await h.chat.manageConversations({action: 'delete', sessionId: first, revision: h.chat.historyRevision, id: 3})
  assert.equal(h.chat.archivedConversations.length, 0)
  await h.chat.manageConversations({action: 'clear-all', revision: h.chat.historyRevision, id: 4})
  assert.deepEqual(JSON.parse(readFileSync(h.options.chatHistoryPath)).messages, [])
  assert.equal(readFileSync(h.options.chatMemoryPath, 'utf8'), 'memory must stay')
})
await check('Stale revisions, pending/admitting replies and failed writes cannot destroy history', async () => {
  const h = localFixture(); await h.chat.loadHistory()
  const original = readFileSync(h.options.chatHistoryPath, 'utf8')
  await h.chat.manageConversations({action: 'clear-all', id: 1, revision: 99})
  assert.equal(h.sent.at(-1).type, 'chat/sessions/error')
  h.chat.admissionToken = Symbol()
  await h.chat.manageConversations({action: 'clear-all', id: 2, revision: 0})
  assert.match(h.sent.at(-1).message, /等待/)
  h.chat.admissionToken = null
  h.chat.pending = {}
  await h.chat.manageConversations({action: 'clear-all', id: 3, revision: 0})
  assert.match(h.sent.at(-1).message, /等待/)
  h.chat.pending = null
  h.chat.persistFileSync = () => false
  await h.chat.manageConversations({action: 'new', id: 4, revision: 0})
  assert.match(h.sent.at(-1).message, /保存失败/)
  assert.equal(h.chat.entries[0].text, '原对话')
  assert.equal(readFileSync(h.options.chatHistoryPath, 'utf8'), original)
})
await check('Conversation limit rejects creation instead of silently deleting older history', async () => {
  const h = localFixture(); await h.chat.loadHistory()
  h.chat.archivedConversations = Array.from({length: 19}, (_, i) => ({id: `old-${i}`, messages: [entry(`old ${i}`)]}))
  await h.chat.manageConversations({action: 'new', revision: 0, id: 1})
  assert.match(h.sent.at(-1).message, /20/)
  assert.equal(h.chat.archivedConversations.length, 19)
})

function dshFixture() {
  const sent = [], calls = [], servicesRead = []
  const rows = [{sessionId: 'existing', cwd: 'C:/work', running: false}, {sessionId: 'child', parentSessionId: 'existing', origin: 'subagent'}]
  const registry = {archivedSessionIds: [], list: () => [{id: 'work', title: '工作区', path: 'C:/work', sessionIds: rows.map(r => r.sessionId)}]}
  const state = {running: false, pendingInput: []}
  const records = [
    {event: {type: 'user/message', time: 1, surfaceOp: 'append', data: {source: {kind: 'runtime-context'}, content: [{type: 'text', text: 'PRIVATE_CONTEXT'}]}}},
    {event: {type: 'user/message', time: 2, surfaceOp: 'append', data: {source: {kind: 'user'}, content: [{type: 'text', text: '真实任务'}]}}},
    {event: {type: 'assistant/message', time: 3, surfaceOp: 'append', data: {message: {content: [{type: 'reasoning', text: 'PRIVATE_REASONING'}, {type: 'text', text: '任务回复'}]}}}},
  ]
  const controller = {
    async list(request, signal) { assert.deepEqual(request, {}); assert.ok(signal); return {items: rows} },
    async create(request) { calls.push(['create', request]); rows.unshift({sessionId: 'created', cwd: 'C:/work', running: false}); return {sessionId: 'created'} },
    async selectModel(request) { calls.push(['selectModel', request]); return {selected: request} },
    async events(request, signal) { calls.push(['events', request]); assert.ok(signal); return {cursor: 3, records, hasMore: false} },
    async state(request, signal) { assert.ok(signal); return state },
    async prompt(request, signal) { calls.push(['prompt', request]); assert.ok(signal); return {accepted: true} },
    async cancel(request) { calls.push(['cancel', request]); return {} },
  }
  const services = {sessionController: controller, workspaceRegistry: registry, agentDefaultModel: {currentSelection: () => ({provider: 'configured', model: 'current', reasoningEffort: 'high'})}, workspaceController: {
    async archiveSession(request) { calls.push(['archive', request]); if (state.running) throw new Error('任务仍在运行'); registry.archivedSessionIds.push(request.sessionId) },
  }}
  const adapter = new DshSessions({service: name => {servicesRead.push(name); return services[name]}, write: m => sent.push(m)})
  return {adapter, sent, calls, servicesRead, services, controller, registry, state, records}
}
await check('DSH lists ordinary sessions and creates in the explicitly selected workspace', async () => {
  const h = dshFixture()
  await h.adapter.handle({action: 'list', id: 1})
  assert.equal(h.sent.at(-1).sessions.length, 1)
  await h.adapter.handle({action: 'new', workspaceId: 'work', id: 2})
  assert.deepEqual(h.calls.find(c => c[0] === 'create')[1], {workspaceId: 'work'})
  assert.deepEqual(h.calls.find(c => c[0] === 'selectModel')[1], {sessionId: 'created', provider: 'configured', model: 'current', reasoningEffort: 'high'})
  assert.equal(h.sent.at(-1).view.sessionId, 'created')
  assert.equal(h.sent.at(-1).view.entries.length, 2)
  assert.ok(!JSON.stringify(h.sent.at(-1)).includes('PRIVATE_'))
  h.adapter.dispose()
})
await check('DSH prompt uses the official queue contract, never the pet LLM', async () => {
  const h = dshFixture(); await h.adapter.handle({action: 'list', id: 1})
  await h.adapter.handle({action: 'prompt', sessionId: 'existing', text: '帮我执行任务', id: 2})
  const payload = h.calls.find(c => c[0] === 'prompt')[1]
  assert.equal(payload.mode, 'queue'); assert.equal(payload.sessionId, 'existing')
  assert.deepEqual(payload.content, [{type: 'text', text: '帮我执行任务'}])
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/)
  assert.equal(h.sent.at(-1).type, 'dsh/accepted')
  assert.ok(!h.servicesRead.includes('llm'))
  await h.adapter.handle({action: 'prompt', sessionId: 'unknown', text: 'bad', id: 3})
  assert.equal(h.sent.at(-1).type, 'dsh/error')
  assert.equal(h.calls.filter(c => c[0] === 'prompt').length, 1)
  h.adapter.dispose()
})
await check('DSH archive is explicit, does not delete files, and refuses running work', async () => {
  const h = dshFixture(); await h.adapter.handle({action: 'list', id: 1})
  h.state.running = true
  await h.adapter.handle({action: 'archive', sessionId: 'existing', id: 2})
  assert.equal(h.sent.at(-1).type, 'dsh/error')
  assert.deepEqual(h.registry.archivedSessionIds, [])
  await h.adapter.handle({action: 'cancel', sessionId: 'existing', id: 3})
  assert.deepEqual(h.calls.find(c => c[0] === 'cancel')[1], {sessionId: 'existing'})
  h.state.running = false
  await h.adapter.handle({action: 'archive', sessionId: 'existing', id: 4})
  assert.deepEqual(h.calls.find(c => c[0] === 'archive')[1], {sessionId: 'existing', stopActivity: false})
  assert.equal(h.sent.at(-1).sessions.length, 0)
  assert.ok(!h.servicesRead.includes('sessionPersistence'))
  h.adapter.dispose()
})
await check('Unsupported Host capabilities report an error instead of pretending to run a task', async () => {
  const h = dshFixture(); delete h.services.sessionController
  await h.adapter.handle({action: 'new', workspaceId: 'work', id: 1})
  assert.equal(h.sent.at(-1).type, 'dsh/error')
  assert.equal(h.calls.length, 0)
  h.adapter.dispose()
})
await check('Edited DSH journal pages do not expose possibly deleted message text', async () => {
  const h = dshFixture(); h.records.push({event: {type: 'feedback/message-delete'}})
  await h.adapter.handle({action: 'list', id: 1})
  await h.adapter.handle({action: 'select', sessionId: 'existing', id: 2})
  assert.deepEqual(h.sent.at(-1).view.entries, [])
  assert.match(h.sent.at(-1).view.note, /编辑/)
  h.adapter.dispose()
})
await check('Detaching and plugin unload do not cancel a Host-owned task', async () => {
  const h = dshFixture(); await h.adapter.handle({action: 'list', id: 1})
  await h.adapter.handle({action: 'select', sessionId: 'existing', id: 2})
  h.adapter.detach()
  h.adapter.dispose()
  assert.ok(!h.calls.some(c => c[0] === 'cancel'))
})
await check('Explicit work-recap requests include observed cross-session work, ordinary chat does not', async () => {
  const h = localFixture(), requests = []
  h.chat.service = name => name === 'llm' ? {async *stream(request) {
    requests.push(request); yield {type: 'text-delta', index: 0, text: '工作摘要'}; yield {type: 'finish', reason: {kind: 'stop'}}
  }} : undefined
  h.chat.daily = {enabled: true, state: {style: {revision: 0}}, snapshot: day => ({day, taskCount: 2, facts: [{title: '来自会话 A'}, {title: '来自会话 B'}]})}
  h.chat.entries = [entry('总结今天的工作')]
  await h.chat.streamReply({provider: 'configured', model: 'current'}, new AbortController().signal)
  assert.match(requests[0].messages.at(-1).content[0].text, /来自会话 A/)
  assert.match(requests[0].messages.at(-1).content[0].text, /来自会话 B/)
  h.chat.entries = [entry('不要总结今天的工作，只聊天')]
  await h.chat.streamReply({provider: 'configured', model: 'current'}, new AbortController().signal)
  assert.equal(requests[1].messages.length, 1)
})
console.log(JSON.stringify({ok: true, checks}, null, 2))
