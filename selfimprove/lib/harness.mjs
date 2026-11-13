import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DeskpetChat } from '../../index.js'

/** 记忆整理请求的系统提示里必须出现的标记（用于 mock 区分调用类型）。 */
export const MEMORY_MARKER = '长期记忆整理器'

/** 把文本包装成与真实 llm 服务一致的 chunk 序列。 */
export function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  const split = Math.max(1, Math.floor(text.length / 2))
  yield { type: 'text-delta', index: 0, text: text.slice(0, split) }
  yield { type: 'reasoning-delta', index: 1, text: '（mock 思考过程，不进入回复）' }
  yield { type: 'text-delta', index: 0, text: text.slice(split) }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

export function makeHarness({
  selection = { provider: 'deepseek-account', model: 'deepseek-flash' },
  replyText = '好的',
  replyFails = false,
  memoryReplies = [],
  eventReplies = [],
} = {}) {
  const sent = []
  const requests = []
  const warns = []
  const memoryRepliesLeft = [...memoryReplies]
  const eventRepliesLeft = [...eventReplies]

  const llm = {
    async *stream(request) {
      requests.push(request)
      const system = typeof request.system === 'string' ? request.system : ''
      if (system.includes(MEMORY_MARKER)) {
        const text = memoryRepliesLeft.length > 0 ? memoryRepliesLeft.shift() : '[]'
        yield* textChunks(text)
        return
      }
      if (system.includes('事件记忆整理器')) {
        const text = eventRepliesLeft.length > 0 ? eventRepliesLeft.shift() : '[]'
        yield* textChunks(text)
        return
      }
      if (replyFails) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'mock 模型失败' } } }
        return
      }
      yield* textChunks(replyText)
    },
  }

  const ctx = {
    logger: {
      info() {},
      debug() {},
      warn: (...args) => warns.push(args.map(String).join(' ')),
      error() {},
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') {
        return selection === null ? undefined : { currentSelection: () => ({ ...selection }) }
      }
      return undefined
    },
  }

  const bridge = { writeMessage: (message) => sent.push(message) }

  return {
    ctx,
    bridge,
    sent,
    requests,
    warns,
    memoryCalls: () => requests.filter(
      (request) => typeof request.system === 'string' && request.system.includes(MEMORY_MARKER),
    ),
    sentOf: (type) => sent.filter((message) => message.type === type),
    lastSent: (type) => [...sent].reverse().find((message) => message.type === type),
    harness: { selection },
  }
}

export const BASE_OPTIONS = {
  chatProvider: undefined,
  chatModel: undefined,
  chatSystemPrompt: '你是桌宠',
  chatMaxTokens: 512,
  chatHistoryMessages: 20,
  chatHistoryMaxMessages: 200,
  chatHistoryPath: undefined,
  chatMemoryEnabled: true,
  chatMemoryPath: undefined,
  chatMemoryUpdateEveryTurns: 2,
  chatMemoryMaxFacts: 40,
  chatMemoryTranscriptMessages: 24,
  chatTimerEnabled: true,
  chatTimerMaxActive: 20,
  chatTimerPath: undefined,
  chatProactiveEnabled: true,
  chatProactiveLevel: 'quiet',
  chatCompanionPath: undefined,
  chatEmotionEnabled: true,
  chatEventsEnabled: true,
  chatEventUpdateEveryTurns: 2,
  chatEventMaxEvents: 50,
  chatEventPath: undefined,
  chatTimeoutMs: 5_000,
}

/** 新建一个独立临时环境（历史/记忆/计时文件都在临时目录，互不影响）。 */
export function createEnv({ harness: harnessOptions = {}, chat: chatOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'deskpet-si-'))
  const harness = makeHarness(harnessOptions)
  const pathOptions = {
    chatHistoryPath: join(dir, 'chat-history.json'),
    chatMemoryPath: join(dir, 'user-memory.json'),
    chatTimerPath: join(dir, 'timers.json'),
    chatCompanionPath: join(dir, 'companion.json'),
    chatEventPath: join(dir, 'events.json'),
  }
  const chat = new DeskpetChat(harness.ctx, harness.bridge, {
    ...BASE_OPTIONS,
    ...pathOptions,
    ...chatOptions,
  })
  return {
    dir,
    harness,
    chat,
    historyPath: pathOptions.chatHistoryPath,
    memoryPath: pathOptions.chatMemoryPath,
    timerPath: pathOptions.chatTimerPath,
    companionPath: pathOptions.chatCompanionPath,
    eventPath: pathOptions.chatEventPath,
  }
}

/** 创建带假时钟的计时环境；clock.advance(ms) 推进时间。 */
export function createTimerEnv({ harness: harnessOptions = {}, chat: chatOptions = {} } = {}) {
  const clock = {
    now: 1_700_000_000_000,
    advance(ms) { this.now += ms },
  }
  const env = createEnv({
    harness: harnessOptions,
    chat: { ...chatOptions, now: () => clock.now },
  })
  return { ...env, clock }
}

/** 与插件内部一致的记忆 id 归一化（用于预置 forgottenFactHashes）。 */
export function memoryFactId(fact) {
  return createHash('sha256')
    .update(fact.text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase())
    .digest('hex')
}

/** 跑满 chatMemoryUpdateEveryTurns 轮（默认 2 轮）并等待记忆整理完成。 */
export async function runTurns(env, texts = ['我喜欢青色', '我晚上工作']) {
  let id = 1
  for (const text of texts) {
    await env.chat.handleChat({ id: id++, text })
  }
  if (env.chat.memoryJob !== null) await env.chat.memoryJob
}

/** 直接触发一次记忆整理（不经过聊天轮次）。 */
export async function triggerMemoryUpdate(env) {
  env.chat.memoryTurns = Math.max(1, env.chat.memoryTurns)
  env.chat.memoryTurns = 99
  env.chat.memoryJob = env.chat.updateMemory().finally(() => { env.chat.memoryJob = null })
  await env.chat.memoryJob
}

export function listFiles(dir) {
  return readdirSync(dir)
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export { assert, readFileSync }
