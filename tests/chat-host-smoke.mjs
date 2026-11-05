/**
 * Smoke test for the deskpet chat: no DSH session, no Python, no real model.
 *
 * `DeskpetChat` is driven with a mock Cordis context (`llm` + `agentDefaultModel`
 * services) so request shape, reply assembly, history persistence, long-term
 * memory, and every failure path are deterministic — and so the test can prove
 * no session service is touched.
 *
 * Usage:
 *   node tests/chat-host-smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeskpetChat } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MEMORY_MARKER = '长期记忆整理器'

function textChunks(text, finishKind = 'stop', failure = undefined) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, 2) },
    { type: 'reasoning-delta', index: 1, text: '这里是思考过程' },
    { type: 'text-delta', index: 0, text: text.slice(2) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    {
      type: 'finish',
      reason: failure === undefined ? { kind: finishKind } : { kind: finishKind, failure },
    },
  ]
}

function makeHarness({
  selection = { provider: 'deepseek-account', model: 'deepseek-flash' },
  finishKind = 'stop',
  failure = undefined,
  hang = false,
  replyText = '你好，我是桌宠',
  memoryReplyText = '[]',
} = {}) {
  const sent = []
  const requests = []
  const servicesRead = []
  const historyDir = mkdtempSync(join(tmpdir(), 'deskpet-chat-'))
  const historyPath = join(historyDir, 'chat-history.json')
  const memoryPath = join(historyDir, 'user-memory.json')

  const llm = {
    async *stream(request) {
      requests.push(request)
      const isMemoryCall = typeof request.system === 'string' && request.system.includes(MEMORY_MARKER)
      for (const chunk of textChunks(isMemoryCall ? memoryReplyText : replyText, finishKind, failure)) {
        yield chunk
      }
      if (hang) {
        await new Promise((resolve) => {
          request.signal?.addEventListener('abort', resolve, { once: true })
          setTimeout(resolve, 5_000)
        })
        if (request.signal?.aborted) throw new Error('mock stream aborted')
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  }

  const ctx = {
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    get(name) {
      servicesRead.push(name)
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return selection === null ? undefined : { currentSelection: () => ({ ...selection }) }
      }
      return undefined
    },
  }
  const bridge = {
    writeMessage(message) {
      sent.push(message)
    },
  }
  return { ctx, bridge, sent, requests, servicesRead, llm, historyDir, historyPath, memoryPath }
}

function makeChat(harness, options = {}) {
  return new DeskpetChat(harness.ctx, harness.bridge, {
    chatProvider: undefined,
    chatModel: undefined,
    chatSystemPrompt: '你是桌宠',
    chatMaxTokens: 512,
    chatHistoryMessages: 20,
    chatHistoryMaxMessages: 200,
    chatHistoryPath: harness.historyPath,
    chatMemoryEnabled: true,
    chatMemoryPath: harness.memoryPath,
    chatMemoryUpdateEveryTurns: 4,
    chatMemoryMaxFacts: 40,
    chatMemoryTranscriptMessages: 24,
    chatTimeoutMs: 5_000,
    ...options,
  })
}

async function settleMemory(chat) {
  if (chat.memoryJob !== null) await chat.memoryJob.catch(() => {})
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: error?.message ?? String(error) })
  }
}

// 1. One turn: model request, reply assembly, and no session service touched.
await check('单轮：请求结构、回复装配、不触碰会话', async () => {
  const harness = makeHarness({ replyText: '你好，我是桌宠' })
  const chat = makeChat(harness)
  await chat.handleChat({ id: 7, text: ' 你好 ' })

  assert.equal(harness.requests.length, 1)
  const request = harness.requests[0]
  assert.equal(request.provider, 'deepseek-account')
  assert.equal(request.model, 'deepseek-flash')
  assert.equal(request.system, '你是桌宠')
  assert.equal(request.maxTokens, 512)
  assert.equal(request.messages.length, 1)
  assert.equal(request.messages[0].role, 'user')
  assert.equal(request.messages[0].content[0].text, '你好')
  assert.equal(typeof request.messages[0].id, 'string')

  assert.deepEqual(harness.sent[0], { type: 'chat/accepted', id: 7 })
  const reply = harness.sent.find((message) => message.type === 'chat/reply')
  assert.equal(reply.id, 7)
  assert.equal(reply.text, '你好，我是桌宠')
  assert.equal(reply.reason, 'completed')
  assert.ok(!harness.servicesRead.includes('sessionController'), 'must not touch sessions')
  assert.equal(chat.pending, null)
  assert.equal(chat.entries.length, 2, 'a completed turn is kept in local memory')
})

// 2. Second turn carries the previous pair as context.
await check('连续对话携带上下文', async () => {
  const harness = makeHarness({ replyText: '第一次回复' })
  const chat = makeChat(harness)
  await chat.handleChat({ id: 1, text: '第一句' })
  await chat.handleChat({ id: 2, text: '第二句' })

  const second = harness.requests[1]
  assert.deepEqual(second.messages.map((message) => message.role), ['user', 'assistant', 'user'])
  assert.equal(second.messages[1].content[0].text, '第一次回复')
  assert.equal(second.messages[2].content[0].text, '第二句')
})

// 3. Explicit provider/model override beats the DSH default.
await check('配置固定模型优先', async () => {
  const harness = makeHarness()
  const chat = makeChat(harness, { chatProvider: 'custom-provider', chatModel: 'custom-model' })
  await chat.handleChat({ id: 3, text: 'hi' })
  assert.equal(harness.requests[0].provider, 'custom-provider')
  assert.equal(harness.requests[0].model, 'custom-model')
})

// 4. Missing llm service is reported, not thrown into the void.
await check('缺少模型服务时报错', async () => {
  const harness = makeHarness()
  const brokenCtx = { logger: harness.ctx.logger, get: () => undefined }
  const chat = new DeskpetChat(brokenCtx, harness.bridge, {
    chatSystemPrompt: 'x',
    chatMaxTokens: 64,
    chatHistoryMessages: 4,
    chatHistoryMaxMessages: 20,
    chatHistoryPath: harness.historyPath,
    chatMemoryEnabled: false,
    chatMemoryPath: harness.memoryPath,
    chatTimeoutMs: 1_000,
  })
  await chat.handleChat({ id: 4, text: 'hi' })
  const failure = harness.sent.find((message) => message.type === 'chat/error' && message.id === 4)
  assert.ok(failure, 'must emit chat/error')
  assert.match(failure.message, /模型|llm/)
})

// 5. Missing model selection explains how to fix it.
await check('缺少默认模型时给出提示', async () => {
  const harness = makeHarness({ selection: null })
  const chat = makeChat(harness)
  await chat.handleChat({ id: 5, text: 'hi' })
  const failure = harness.sent.find((message) => message.type === 'chat/error' && message.id === 5)
  assert.match(failure.message, /模型/)
})

// 6. A terminal model error becomes chat/error and does not enter history.
await check('模型错误回显且不污染上下文', async () => {
  const harness = makeHarness({
    finishKind: 'error',
    failure: { message: '配额不足', code: 'QUOTA_EXCEEDED' },
  })
  const chat = makeChat(harness)
  await chat.handleChat({ id: 6, text: 'hi' })
  const failure = harness.sent.find((message) => message.type === 'chat/error' && message.id === 6)
  assert.ok(failure, 'must emit chat/error')
  assert.match(failure.message, /配额不足/)
  assert.equal(chat.entries.length, 0, 'failed turn must not stay in history')
})

// 7. Timeout aborts the model call and reports it.
await check('等待超时回显并中止', async () => {
  const harness = makeHarness({ hang: true })
  const chat = makeChat(harness, { chatTimeoutMs: 80 })
  const running = chat.handleChat({ id: 8, text: 'hi' })
  await sleep(200)
  const failure = harness.sent.find((message) => message.type === 'chat/error' && message.id === 8)
  assert.ok(failure, 'must report timeout')
  assert.match(failure.message, /超时/)
  assert.equal(chat.pending, null)
  chat.dispose()
  await running.catch(() => {})
})

// 8. Disposal aborts in-flight work and rejects later messages.
await check('停用清理与 abort', async () => {
  const harness = makeHarness({ hang: true })
  const chat = makeChat(harness)
  const running = chat.handleChat({ id: 9, text: 'hi' })
  await sleep(20)
  const signal = harness.requests[0].signal
  chat.dispose()
  assert.equal(signal.aborted, true, 'in-flight request must be aborted')
  await running.catch(() => {})
  await chat.handleChat({ id: 10, text: 'after dispose' })
  const failure = harness.sent.find((message) => message.type === 'chat/error' && message.id === 10)
  assert.ok(failure, 'post-disposal chat must fail fast')
})

// 9. The request carries at most the configured number of messages.
await check('历史窗口截断', async () => {
  const harness = makeHarness()
  const chat = makeChat(harness, { chatHistoryMessages: 2, chatMemoryEnabled: false })
  for (let index = 0; index < 3; index += 1) {
    await chat.handleChat({ id: 20 + index, text: `第 ${index} 句` })
  }
  assert.equal(chat.entries.length, 6, 'all completed turns stay in local memory')
  const last = harness.requests[2]
  assert.equal(last.messages.length, 2, 'one request carries at most the window size')
  assert.equal(last.messages[last.messages.length - 1].role, 'user')
  assert.equal(last.messages[last.messages.length - 1].content[0].text, '第 2 句')
})

// 10. Persistence: a new instance restores the saved conversation and sends it to Python.
await check('重启后恢复聊天记忆', async () => {
  const harness = makeHarness({ replyText: '我记得这句话' })
  const chat = makeChat(harness, { chatMemoryEnabled: false })
  await chat.handleChat({ id: 30, text: '记住：我喜欢青色' })
  await chat.persistHistory()

  const saved = JSON.parse(readFileSync(harness.historyPath, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.messages.length, 2)
  assert.equal(saved.messages[0].role, 'user')
  assert.equal(saved.messages[0].text, '记住：我喜欢青色')
  assert.equal(saved.messages[1].role, 'assistant')
  assert.equal(typeof saved.messages[1].time, 'string')

  const restarted = makeChat(harness, { chatMemoryEnabled: false })
  await restarted.loadHistory()
  assert.equal(restarted.entries.length, 2)
  restarted.sendHistoryToPet()
  const historyMessage = harness.sent.find((message) => message.type === 'chat/history')
  assert.ok(historyMessage, 'host must hand persisted history to the dialog')
  assert.equal(historyMessage.entries.length, 2)

  await restarted.handleChat({ id: 31, text: '我刚才说了什么？' })
  const request = harness.requests[1]
  assert.equal(request.messages.length, 3, 'restored history is used as model context')
  assert.equal(request.messages[0].content[0].text, '记住：我喜欢青色')
})

// 11. A corrupted history file is quarantined instead of blocking chat.
await check('历史文件损坏时隔离并继续', async () => {
  const harness = makeHarness()
  writeFileSync(harness.historyPath, 'this is not json', 'utf8')
  const chat = makeChat(harness, { chatMemoryEnabled: false })
  await chat.loadHistory()
  assert.equal(chat.entries.length, 0)
  const files = readdirSync(harness.historyDir)
  assert.ok(files.some((name) => name.includes('.corrupt-')), 'corrupt file must be kept aside')
  await chat.handleChat({ id: 40, text: '还能聊吗' })
  assert.equal(chat.entries.length, 2, 'chat keeps working after a corrupt history')
})

// 12. The persisted file is trimmed to chatHistoryMaxMessages.
await check('落盘历史按上限截断', async () => {
  const harness = makeHarness()
  const chat = makeChat(harness, { chatHistoryMaxMessages: 4, chatMemoryEnabled: false })
  for (let index = 0; index < 3; index += 1) {
    await chat.handleChat({ id: 50 + index, text: `第 ${index} 句` })
  }
  await chat.persistHistory()
  const saved = JSON.parse(readFileSync(harness.historyPath, 'utf8'))
  assert.equal(saved.messages.length, 4)
  assert.equal(saved.messages[saved.messages.length - 1].text, '你好，我是桌宠')
})

// 13. Disposal writes the current conversation synchronously.
await check('停用时同步落盘', async () => {
  const harness = makeHarness()
  const chat = makeChat(harness, { chatMemoryEnabled: false })
  await chat.handleChat({ id: 60, text: '这轮说完就关掉' })
  chat.dispose()
  assert.ok(existsSync(harness.historyPath), 'history file must exist after dispose')
  const saved = JSON.parse(readFileSync(harness.historyPath, 'utf8'))
  assert.equal(saved.messages.length, 2)
})

// 14. Long-term memory: after the configured turns the model profile is distilled,
// saved, and injected into later replies.
await check('长期记忆提炼、落盘与注入', async () => {
  const harness = makeHarness({
    replyText: '好呀',
    memoryReplyText: '[{"kind":"preference","text":"用户喜欢青色的桌宠"},{"kind":"goal","text":"用户想做出记时桌宠"}]',
  })
  const chat = makeChat(harness, { chatMemoryUpdateEveryTurns: 2 })
  await chat.handleChat({ id: 70, text: '我喜欢青色的桌宠' })
  await chat.handleChat({ id: 71, text: '我还想做记时功能' })
  await settleMemory(chat)

  assert.equal(chat.memoryFacts.length, 2, 'memory profile must be distilled')
  const memoryCalls = harness.requests.filter((request) => request.system.includes(MEMORY_MARKER))
  assert.equal(memoryCalls.length, 1, 'one distillation call per threshold')
  const saved = JSON.parse(readFileSync(harness.memoryPath, 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.facts.length, 2)
  const memoryNote = harness.sent.find((message) => message.type === 'chat/memory')
  assert.equal(memoryNote.count, 2, 'dialog must learn the memory count')

  await chat.handleChat({ id: 72, text: '你还记得我吗？' })
  const replyRequest = harness.requests.filter((request) => !request.system.includes(MEMORY_MARKER)).pop()
  assert.match(replyRequest.system, /长期记忆/)
  assert.match(replyRequest.system, /用户喜欢青色的桌宠/)
  assert.match(replyRequest.system, /用户想做出记时桌宠/)
})

// 15. Long-term memory survives a restart and is injected immediately.
await check('长期记忆跨重启生效', async () => {
  const harness = makeHarness({
    replyText: '记得',
    memoryReplyText: '[{"kind":"fact","text":"用户名字叫小吴"}]',
  })
  const first = makeChat(harness, { chatMemoryUpdateEveryTurns: 1 })
  await first.handleChat({ id: 80, text: '我叫小吴' })
  await settleMemory(first)
  assert.equal(first.memoryFacts.length, 1)

  const restarted = makeChat(harness, { chatMemoryUpdateEveryTurns: 99 })
  await restarted.loadMemory()
  assert.equal(restarted.memoryFacts.length, 1)
  restarted.sendMemoryToPet()
  await restarted.handleChat({ id: 81, text: '我叫什么？' })
  const request = harness.requests.filter((item) => !item.system.includes(MEMORY_MARKER)).pop()
  assert.match(request.system, /用户名字叫小吴/)
})

// 16. A corrupted memory file is quarantined and chat continues without it.
await check('记忆损坏时隔离并继续', async () => {
  const harness = makeHarness()
  writeFileSync(harness.memoryPath, 'not json', 'utf8')
  const chat = makeChat(harness)
  await chat.loadMemory()
  assert.equal(chat.memoryFacts.length, 0)
  assert.ok(readdirSync(harness.historyDir).some((name) => name.includes('.corrupt-')))
  await chat.handleChat({ id: 90, text: '还能聊吗' })
  assert.equal(chat.entries.length, 2)
})

// 17. Memory extraction failure never breaks the conversation.
await check('记忆整理失败不影响聊天', async () => {
  const harness = makeHarness({ replyText: '好的', memoryReplyText: '这不是 JSON' })
  const chat = makeChat(harness, { chatMemoryUpdateEveryTurns: 1 })
  await chat.handleChat({ id: 100, text: '你好' })
  await settleMemory(chat)
  assert.equal(chat.memoryFacts.length, 0, 'invalid model output must not replace memory')
  assert.ok(harness.sent.some((message) => message.type === 'chat/reply' && message.id === 100))
})

// 18. chatMemoryEnabled: false disables distillation and injection.
await check('关闭长期记忆时不做额外调用', async () => {
  const harness = makeHarness({ memoryReplyText: '[{"kind":"fact","text":"不应出现"}]' })
  const chat = makeChat(harness, { chatMemoryEnabled: false, chatMemoryUpdateEveryTurns: 1 })
  await chat.handleChat({ id: 110, text: '你好' })
  await chat.handleChat({ id: 111, text: '再见' })
  await settleMemory(chat)
  assert.ok(
    harness.requests.every((request) => !request.system.includes(MEMORY_MARKER)),
    'no memory call may run when disabled',
  )
  assert.equal(chat.memoryFacts.length, 0)
})

// 19. Disposing before the files were loaded must not overwrite existing memory.
await check('未加载就停用不覆盖已有记忆', async () => {
  const harness = makeHarness()
  writeFileSync(harness.historyPath, JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    messages: [
      { role: 'user', text: '旧消息一', time: '2026-11-01T10:00:00.000Z' },
      { role: 'assistant', text: '旧回复一', time: '2026-11-01T10:00:05.000Z' },
    ],
  }), 'utf8')
  writeFileSync(harness.memoryPath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    facts: [{ kind: 'fact', text: '旧记忆' }],
  }), 'utf8')

  const chat = makeChat(harness)
  chat.dispose() // 模拟启动阶段就被停用，尚未 loadHistory/loadMemory

  const savedHistory = JSON.parse(readFileSync(harness.historyPath, 'utf8'))
  assert.equal(savedHistory.messages.length, 2, 'existing history must survive an early dispose')
  const savedMemory = JSON.parse(readFileSync(harness.memoryPath, 'utf8'))
  assert.equal(savedMemory.facts.length, 1, 'existing memory must survive an early dispose')
  assert.equal(chat.memoryLoaded, false)
})

// 20. A clean load followed by dispose must not rewrite unchanged files.
await check('无变化停用不重写文件', async () => {
  const harness = makeHarness()
  const historyText = JSON.stringify({
    version: 1,
    savedAt: '2026-11-01T00:00:00.000Z',
    messages: [
      { role: 'user', text: '旧消息一', time: '2026-11-01T10:00:00.000Z' },
      { role: 'assistant', text: '旧回复一', time: '2026-11-01T10:00:05.000Z' },
    ],
  })
  const memoryText = JSON.stringify({
    version: 1,
    updatedAt: '2026-11-01T00:00:00.000Z',
    facts: [{ kind: 'fact', text: '旧记忆' }],
  })
  writeFileSync(harness.historyPath, historyText, 'utf8')
  writeFileSync(harness.memoryPath, memoryText, 'utf8')

  const chat = makeChat(harness)
  await chat.loadHistory()
  await chat.loadMemory()
  chat.dispose()

  assert.equal(readFileSync(harness.historyPath, 'utf8'), historyText, 'clean history must not be rewritten')
  assert.equal(readFileSync(harness.memoryPath, 'utf8'), memoryText, 'clean memory must not be rewritten')
})

const failed = results.filter((result) => !result.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2))
if (failed.length > 0) process.exitCode = 1
