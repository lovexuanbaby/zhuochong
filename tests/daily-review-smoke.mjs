import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DailyReview, localDay } from '../daily-review.js'
import { DeskpetChat, DeskpetBridge } from '../index.js'

const checks = []
async function check(name, fn) { await fn(); checks.push(name) }
const base = Date.parse('2026-11-19T12:00:00+08:00')
function fixture(options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'deskpet-daily-'))
  const sent = [], requests = []
  const review = new DailyReview({
    path: join(folder, 'daily.json'), now: () => base, logger: {warn() {}},
    write: message => sent.push(message), generate: async (facts, style, signal) => { requests.push({facts, style, signal}); return '根据记录完成工作回顾。' },
    ...options,
  })
  return {review, sent, requests, folder}
}
function task(review, {id = 'a', turn = 1, end = 'completed', at = base, child = false} = {}) {
  const session = {id, header: child ? {parentSession: 'parent'} : {}}
  const event = (type, data) => review.observe(session, {type, data, time: at})
  event('turn/start', {turn})
  event('user/message', {source: {kind: 'runtime-context'}, content: [{type: 'text', text: 'PRIVATE_RUNTIME_CONTEXT'}]})
  event('user/message', {source: {kind: 'user'}, content: [{type: 'text', text: '完成日报功能'}]})
  event('assistant/message', {turn, message: {content: [{type: 'reasoning', text: 'PRIVATE_REASONING'}, {type: 'text', text: '已补充代码和测试。'}]}})
  event('tool/call', {turn, callId: 'call-1', name: 'test', arguments: 'PRIVATE_ARGUMENTS'})
  event('tool/call', {turn, callId: 'call-1', name: 'test'})
  event('tool/result', {turn, message: {toolCallId: 'call-1', isError: true, content: [{type: 'text', text: 'PRIVATE_TOOL_OUTPUT'}]}})
  if (end) event('turn/end', {turn, reason: {kind: end}})
  return {session, event}
}

await check('Collects only bounded visible task summaries, with deduplicated tools', async () => {
  const h = fixture(); task(h.review)
  await h.review.handle({type: 'review/open', id: 1})
  assert.equal(h.requests.length, 0, 'opening a report is local')
  assert.equal(h.sent.at(-1).taskCount, 1)
  assert.match(h.sent.at(-1).text, /完成日报功能/)
  const saved = readFileSync(h.review.path, 'utf8')
  for (const privateText of ['PRIVATE_RUNTIME_CONTEXT', 'PRIVATE_REASONING', 'PRIVATE_ARGUMENTS', 'PRIVATE_TOOL_OUTPUT']) assert.ok(!saved.includes(privateText))
  assert.equal(h.review.snapshot().facts[0].toolCalls, 1)
  assert.equal(h.review.snapshot().facts[0].toolErrors, 1)
})
await check('Concurrent parent/child tasks retain their own outcomes', () => {
  const h = fixture(); task(h.review); task(h.review, {id: 'b', child: true, end: 'aborted'})
  assert.equal(h.review.snapshot().taskCount, 2)
  assert.equal(h.review.snapshot().facts[1].subagent, true)
  assert.deepEqual(h.review.snapshot().facts.map(t => t.status), ['completed', 'aborted'])
})
await check('Days follow the local calendar and old work is pruned', () => {
  assert.equal(localDay(Date.parse('2026-11-18T16:30:00Z'), 'Asia/Shanghai'), '2026-11-19', 'explicit time-zone boundary')
  const midnight = Date.parse('2026-11-20T00:01:00+08:00')
  const h = fixture({now: () => midnight})
  task(h.review, {at: midnight - 120_000})
  task(h.review, {id: 'b', at: midnight})
  assert.equal(h.review.snapshot(localDay(midnight - 120_000)).taskCount, 1)
  assert.equal(h.review.snapshot().taskCount, 1)
  task(h.review, {id: 'old', at: midnight - 31 * 86_400_000})
  assert.equal(h.review.state.tasks.length, 2)
  assert.match(h.review.state.tasks[0].sessionId, /^[a-f0-9]{16}$/u, 'session identifiers are not stored in clear text')
})
await check('Explicit feedback persists, rejects stale updates, and resets', async () => {
  const h = fixture()
  await h.review.handle({type: 'review/feedback', id: 1, feedback: 'shorter', revision: 0})
  assert.equal(h.review.state.style.brevity, 1)
  const restored = fixture({path: h.review.path}).review
  assert.match(restored.stylePrompt(), /更简短/)
  await restored.handle({type: 'review/feedback', id: 2, feedback: 'formal', revision: 0})
  assert.equal(restored.state.style.revision, 1)
  await restored.handle({type: 'review/feedback', id: 3, feedback: 'reset', revision: 1})
  assert.equal(restored.state.style.brevity, 0)
  assert.equal(restored.state.style.revision, 2)
})
await check('Saved preferences influence subsequent chat prompts', async () => {
  const h = fixture()
  const chat = new DeskpetChat({logger: {warn() {}, info() {}}}, {writeMessage() {}}, {chatSystemPrompt: '桌宠', chatHistoryPath: join(h.folder, 'history.json')})
  chat.daily = h.review
  assert.equal(chat.composeSystemPrompt(), '桌宠')
  await h.review.handle({type: 'review/feedback', id: 1, feedback: 'casual', revision: 0})
  assert.match(chat.composeSystemPrompt(), /语气轻松自然/)
})
await check('Model polishing uses one call and a trace; opening reuses the cache', async () => {
  const h = fixture(); task(h.review)
  await h.review.handle({type: 'review/generate', id: 1, styleRevision: 0})
  assert.equal(h.requests.length, 1)
  assert.equal(h.sent.at(-1).mode, 'model')
  assert.equal(h.sent.filter(m => m.type === 'review/progress').length, 2)
  await h.review.handle({type: 'review/open', id: 2})
  assert.equal(h.requests.length, 1)
  assert.equal(h.sent.at(-1).text, '根据记录完成工作回顾。')
})
await check('No work means no model call; stale generation preferences are rejected', async () => {
  const h = fixture()
  await h.review.handle({type: 'review/generate', id: 1, styleRevision: 0})
  assert.equal(h.requests.length, 0)
  await h.review.handle({type: 'review/generate', id: 2, styleRevision: 99})
  assert.equal(h.sent.at(-1).type, 'review/error')
})
await check('Feedback during generation prevents an old-style report overwriting new preferences', async () => {
  let resolve
  const h = fixture({generate: () => new Promise(r => {resolve = r})}); task(h.review)
  const job = h.review.handle({type: 'review/generate', id: 1, styleRevision: 0})
  await h.review.handle({type: 'review/feedback', id: 2, feedback: 'shorter', revision: 0})
  resolve('旧风格报告'); await job
  assert.equal(h.sent.at(-1).type, 'review/error')
  assert.equal(Object.keys(h.review.state.reports).length, 0)
})
await check('Model errors and timeouts preserve local work and permit retry', async () => {
  const h = fixture({timeoutMs: 15, generate: () => new Promise(() => {})}); task(h.review)
  await h.review.handle({type: 'review/generate', id: 1, styleRevision: 0})
  assert.equal(h.sent.at(-1).type, 'review/error')
  assert.equal(h.review.pending, null)
  assert.equal(h.review.snapshot().taskCount, 1)
  h.review.generate = async () => '重新生成成功'
  await h.review.handle({type: 'review/generate', id: 2, styleRevision: 0})
  assert.equal(h.sent.at(-1).text, '重新生成成功')
})
await check('Cancel is request-scoped and unload stops pending work without late writes', async () => {
  const h = fixture({generate: () => new Promise(() => {})}); task(h.review)
  const job = h.review.handle({type: 'review/generate', id: 7, styleRevision: 0})
  h.review.cancel(6); assert.ok(h.review.pending)
  const count = h.sent.length
  h.review.dispose(); await job
  assert.equal(h.sent.length, count)
  assert.equal(h.review.pending, null)
})
await check('Failed preference persistence preserves the previous style', async () => {
  const h = fixture(); h.review.save = () => false
  await h.review.handle({type: 'review/feedback', id: 1, revision: 0, feedback: 'formal'})
  assert.equal(h.review.state.style.revision, 0)
  assert.equal(h.sent.at(-1).type, 'review/error')
})
await check('Disabled recording creates no data and applies no style', async () => {
  const h = fixture({enabled: false}); task(h.review)
  await h.review.handle({type: 'review/open', id: 1})
  h.review.dispose()
  assert.equal(h.review.stylePrompt(), '')
  assert.equal(existsSync(h.review.path), false)
})
await check('Corrupt data is isolated without failing startup', () => {
  const h = fixture(); writeFileSync(h.review.path, 'invalid json')
  const restored = fixture({path: h.review.path}).review
  assert.equal(restored.state.tasks.length, 0)
  assert.equal(existsSync(`${h.review.path}.corrupt-${base}`), true)
})
await check('Bridge routes review operations without mixing chat requests', () => {
  const seen = [], canceled = []
  const bridge = new DeskpetBridge({logger: {warn() {}, info() {}}}, {}, {onReview: m => seen.push(m), onReviewCancel: m => canceled.push(m)})
  for (const type of ['review/open', 'review/generate', 'review/feedback', 'review/cancel']) bridge.onStdoutLine(JSON.stringify({type, id: 1}))
  assert.equal(seen.length, 3); assert.equal(canceled.length, 1)
})
await check('DSH model adapter forwards date/style and handles failed completion', async () => {
  const h = fixture(), seen = []
  let failed = false
  const llm = {async *stream(request) {
    seen.push(request)
    yield {type: 'text-delta', index: 0, text: '当天工作摘要'}
    yield {type: 'finish', reason: {kind: failed ? 'error' : 'stop'}}
  }}
  const ctx = {logger: {warn() {}, info() {}}, get(name) {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') return {currentSelection: () => ({provider: 'configured', model: 'current'})}
  }}
  const chat = new DeskpetChat(ctx, {writeMessage() {}}, {chatSystemPrompt: '桌宠', chatHistoryPath: join(h.folder, 'history.json')})
  const signal = new AbortController().signal
  assert.equal(await chat.generateDailyReview([{title: '任务'}], '更简短', signal, '2026-11-19'), '当天工作摘要')
  assert.equal(seen[0].provider, 'configured'); assert.equal(seen[0].model, 'current')
  assert.equal(JSON.parse(seen[0].messages[0].content[0].text).day, '2026-11-19')
  assert.match(seen[0].system, /更简短/); assert.equal(seen[0].signal, signal)
  failed = true
  await assert.rejects(chat.generateDailyReview([], '', signal, '2026-11-19'), /模型调用失败/)
})
console.log(JSON.stringify({ok: true, checks}, null, 2))
