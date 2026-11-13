/**
 * Minimal Host-side bridge for a Python desktop-pet process.
 *
 * The plugin owns one child process and exchanges newline-delimited JSON over
 * its stdin/stdout. Python diagnostics must go to stderr; stdout is reserved
 * for protocol messages so a stray print cannot corrupt the stream.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolvePythonPath } from './python-runtime.js'
export { Config } from './config.js'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(PLUGIN_DIR, 'python', 'deskpet_bridge.py')
const CHAT_HISTORY_VERSION = 1
const MEMORY_VERSION = 1
const MEMORY_KINDS = new Set(['preference', 'habit', 'goal', 'fact', 'relation'])
const COMPANION_VERSION = 1

/** 安静温柔型桌宠的人格设定（用户确认的版本）。 */
const DEFAULT_PERSONA = [
  '你是一只安静的青色小机器人桌宠，是用户的陪伴伙伴。',
  '性格安静、温柔、有耐心，话不多。',
  '',
  '说话规则：',
  '- 每次回复 1～3 句，语气柔和，少用感叹号',
  '- 先接住情绪，再回应内容；不说教、不急着给建议',
  '- 默认称呼「你」；用户告诉你名字或称呼后，再温柔地用上',
  '- 不主动刷屏；关心的话只说一次',
  '- 不假装人类，也不反复强调自己是 AI',
  '- 不使用 Markdown 标题或表格；不要提及内部实现或协议',
].join('\n')

/** 情绪关键词 → 给模型的回应提示。 */
const MOOD_RULES = [
  { mood: 'tired', pattern: /累|困|熬夜|加班|疲惫|没精神/u, hint: '用户似乎很累：先接住疲惫，语气放轻，不要急着给建议。' },
  { mood: 'sad', pattern: /难过|伤心|失落|想哭|不开心|emo|委屈/u, hint: '用户似乎情绪低落：先共情，不要讲道理，也不要急着转移话题。' },
  { mood: 'stressed', pattern: /烦|焦虑|压力|崩溃|忙死|头大/u, hint: '用户似乎压力很大：先让情绪落地，再轻轻问一句是否需要陪着。' },
  { mood: 'happy', pattern: /开心|高兴|哈哈|太好了|兴奋/u, hint: '用户心情不错：轻轻回应这份开心，不要泼冷水。' },
]
const MOOD_EFFECTS = {
  tired: { valence: -0.18, energy: -0.25 },
  sad: { valence: -0.3, energy: -0.1 },
  stressed: { valence: -0.22, energy: -0.15 },
  happy: { valence: 0.28, energy: 0.12 },
}
const MOOD_LABELS = { tired: '累', sad: '难过', stressed: '压力大', happy: '开心' }
const MOOD_NEGATIONS = {
  tired: /不累|不困|没熬夜|没加班|还好|睡得很好/u,
  sad: /不难过|没伤心|没失落|还好|没事/u,
  stressed: /不烦|没压力|不焦虑|还好|没事/u,
  happy: /不开心|没那么高兴|一般般/u,
}
const EMOTION_MAX_RECENT = 5

function matchMood(text) {
  for (const rule of MOOD_RULES) {
    const negation = MOOD_NEGATIONS[rule.mood]
    if (negation !== undefined && negation.test(text)) continue
    if (!rule.pattern.test(text)) continue
    const hits = (text.match(rule.pattern) ?? []).length
    return { mood: rule.mood, hint: rule.hint, intensity: Math.min(1, 0.5 + hits * 0.1) }
  }
  return null
}

function detectMoodHint(text) {
  return matchMood(text)?.hint ?? null
}

function clamp(value, minimum, maximum, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

// ---------------------------------------------------------------- 事件记忆

const EVENT_VERSION = 1
const EVENT_RECALL_LIMIT = 3

function eventExtractionPrompt(existingEvents, maxEvents) {
  const existing = existingEvents.length === 0
    ? '（暂无）'
    : existingEvents.map((event) => `- ${event.summary}${event.when ? `（${event.when}）` : ''}`).join('\n')
  return [
    '你是桌宠的事件记忆整理器：从最近对话里提取值得长期记住的“具体事件”，形成一份事件记忆列表。',
    '规则：',
    '1. 只记录具体发生的事：时间、场景、人物、情绪、结果、承诺（例如“答应帮他提醒”）。',
    '2. 泛泛的偏好不属于事件，不要重复画像里的内容；合并重复或相近事件；不确定的不要写；不要编造。',
    `3. 每条 summary 不超过 60 个字；when 可选（如“2026-11-12 晚上”）；importance 为 1-5；总数不超过 ${maxEvents} 条。`,
    '4. 只输出 JSON 数组，元素形如 {"summary":"...","when":"...","importance":3}；不要输出其他文字。',
    '',
    '已有事件：',
    existing,
  ].join('\n')
}

function parseEvents(text, maxEvents, now) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const events = []
  const seen = new Set()
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const summary = typeof item.summary === 'string' ? sanitizeFactText(item.summary) : ''
    if (summary === '' || summary.length > 80) continue
    const key = summary.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const importance = Math.min(5, Math.max(1, Math.round(Number.isFinite(item.importance) ? item.importance : 3)))
    const when = typeof item.when === 'string' ? sanitizeFactText(item.when).slice(0, 40) : ''
    events.push({ id: eventIdOf(summary), summary, when, importance, createdAt: now })
    if (events.length >= maxEvents) break
  }
  return events
}

function eventIdOf(summary) {
  return createHash('sha256').update(String(summary).toLowerCase()).digest('hex')
}

function bigramSet(text) {
  const cleaned = String(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const grams = new Set()
  for (let index = 0; index < cleaned.length - 1; index += 1) {
    grams.add(cleaned.slice(index, index + 2))
  }
  return grams
}

/** 桌宠对话历史的默认落盘位置（DSH home 下，避免写进仓库）。 */
function defaultChatHistoryPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deskpet', 'chat-history.json')
}

/** 桌宠长期记忆（用户画像）的默认落盘位置。 */
function defaultMemoryPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deskpet', 'user-memory.json')
}

/** 桌宠计时/提醒的默认落盘位置。 */
function defaultTimersPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deskpet', 'timers.json')
}

/** 陪伴关系数据的默认落盘位置。 */
function defaultCompanionPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deskpet', 'companion.json')
}

/** 事件记忆的默认落盘位置。 */
function defaultEventsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'deskpet', 'events.json')
}

function positiveInteger(value, fallback, field, min = 1) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647) {
    throw new TypeError(`deskpet config: ${field} must be an integer between ${min} and 2147483647`)
  }
  return Math.floor(value)
}

export function normalizeConfig(raw) {
  let config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('deskpet config: expected an object')
  }

  config = { ...config }
  for (const field of ['chatProvider', 'chatModel', 'chatSystemPrompt', 'chatHistoryPath', 'chatMemoryPath', 'chatTimerPath', 'chatCompanionPath']) {
    if (typeof config[field] === 'string' && config[field].trim() === '') delete config[field]
  }
  const pythonPath = resolvePythonPath(config.pythonPath)

  const chatProvider = config.chatProvider
  const chatModel = config.chatModel
  if ((chatProvider === undefined) !== (chatModel === undefined)) {
    throw new TypeError('deskpet config: chatProvider and chatModel must be configured together')
  }
  if (chatProvider !== undefined
    && (typeof chatProvider !== 'string' || chatProvider.trim() === ''
      || typeof chatModel !== 'string' || chatModel.trim() === '')) {
    throw new TypeError('deskpet config: chatProvider/chatModel must be non-empty strings')
  }

  const chatSystemPrompt = config.chatSystemPrompt
  if (chatSystemPrompt !== undefined
    && (typeof chatSystemPrompt !== 'string' || chatSystemPrompt.trim() === '')) {
    throw new TypeError('deskpet config: chatSystemPrompt must be a non-empty string when set')
  }

  const chatHistoryPath = config.chatHistoryPath
  if (chatHistoryPath !== undefined
    && (typeof chatHistoryPath !== 'string' || chatHistoryPath.trim() === '')) {
    throw new TypeError('deskpet config: chatHistoryPath must be a non-empty string when set')
  }

  const chatMemoryPath = config.chatMemoryPath
  if (chatMemoryPath !== undefined
    && (typeof chatMemoryPath !== 'string' || chatMemoryPath.trim() === '')) {
    throw new TypeError('deskpet config: chatMemoryPath must be a non-empty string when set')
  }

  const chatMemoryEnabled = config.chatMemoryEnabled
  if (chatMemoryEnabled !== undefined && typeof chatMemoryEnabled !== 'boolean') {
    throw new TypeError('deskpet config: chatMemoryEnabled must be a boolean when set')
  }

  const chatTimerPath = config.chatTimerPath
  if (chatTimerPath !== undefined
    && (typeof chatTimerPath !== 'string' || chatTimerPath.trim() === '')) {
    throw new TypeError('deskpet config: chatTimerPath must be a non-empty string when set')
  }

  const chatTimerEnabled = config.chatTimerEnabled
  if (chatTimerEnabled !== undefined && typeof chatTimerEnabled !== 'boolean') {
    throw new TypeError('deskpet config: chatTimerEnabled must be a boolean when set')
  }

  const chatTimerSound = config.chatTimerSound
  if (chatTimerSound !== undefined && typeof chatTimerSound !== 'boolean') {
    throw new TypeError('deskpet config: chatTimerSound must be a boolean when set')
  }

  const chatCompanionPath = config.chatCompanionPath
  if (chatCompanionPath !== undefined
    && (typeof chatCompanionPath !== 'string' || chatCompanionPath.trim() === '')) {
    throw new TypeError('deskpet config: chatCompanionPath must be a non-empty string when set')
  }

  const chatProactiveEnabled = config.chatProactiveEnabled
  if (chatProactiveEnabled !== undefined && typeof chatProactiveEnabled !== 'boolean') {
    throw new TypeError('deskpet config: chatProactiveEnabled must be a boolean when set')
  }

  const chatEmotionEnabled = config.chatEmotionEnabled
  if (chatEmotionEnabled !== undefined && typeof chatEmotionEnabled !== 'boolean') {
    throw new TypeError('deskpet config: chatEmotionEnabled must be a boolean when set')
  }

  const chatEventPath = config.chatEventPath
  if (chatEventPath !== undefined
    && (typeof chatEventPath !== 'string' || chatEventPath.trim() === '')) {
    throw new TypeError('deskpet config: chatEventPath must be a non-empty string when set')
  }

  const chatEventsEnabled = config.chatEventsEnabled
  if (chatEventsEnabled !== undefined && typeof chatEventsEnabled !== 'boolean') {
    throw new TypeError('deskpet config: chatEventsEnabled must be a boolean when set')
  }

  return {
    pythonPath: pythonPath.trim(),
    pingIntervalMs: positiveInteger(config.pingIntervalMs, 15_000, 'pingIntervalMs', 1_000),
    pingTimeoutMs: positiveInteger(config.pingTimeoutMs, 5_000, 'pingTimeoutMs', 100),
    handshakeTimeoutMs: positiveInteger(config.handshakeTimeoutMs, 5_000, 'handshakeTimeoutMs', 100),
    shutdownTimeoutMs: positiveInteger(config.shutdownTimeoutMs, 3_000, 'shutdownTimeoutMs', 100),
    // 桌宠对话直接使用 DSH 已配置的模型（不建会话、不写 DSH 聊天记录）。
    chatProvider: typeof chatProvider === 'string' ? chatProvider.trim() : undefined,
    chatModel: typeof chatModel === 'string' ? chatModel.trim() : undefined,
    chatSystemPrompt: typeof chatSystemPrompt === 'string'
      ? chatSystemPrompt.trim()
      : DEFAULT_PERSONA,
    chatMaxTokens: positiveInteger(config.chatMaxTokens, 1_024, 'chatMaxTokens', 16),
    // 带进模型上下文的最近消息数。
    chatHistoryMessages: positiveInteger(config.chatHistoryMessages, 40, 'chatHistoryMessages', 1),
    // 落盘保存并显示在桌宠窗口里的历史上限。
    chatHistoryMaxMessages: positiveInteger(config.chatHistoryMaxMessages, 200, 'chatHistoryMaxMessages', 1),
    chatHistoryPath: typeof chatHistoryPath === 'string' ? chatHistoryPath.trim() : undefined,
    // 长期记忆（越聊越懂用户）：定期把聊天提炼成用户画像，注入每次对话。
    chatMemoryEnabled: chatMemoryEnabled ?? true,
    chatMemoryPath: typeof chatMemoryPath === 'string' ? chatMemoryPath.trim() : undefined,
    chatMemoryUpdateEveryTurns: positiveInteger(config.chatMemoryUpdateEveryTurns, 4, 'chatMemoryUpdateEveryTurns', 1),
    chatMemoryMaxFacts: positiveInteger(config.chatMemoryMaxFacts, 40, 'chatMemoryMaxFacts', 1),
    chatMemoryTranscriptMessages: positiveInteger(config.chatMemoryTranscriptMessages, 24, 'chatMemoryTranscriptMessages', 2),
    // 计时/提醒：聊天里直接说“计时 5 分钟”“10 分钟后提醒我 喝水”即可。
    chatTimerEnabled: chatTimerEnabled ?? true,
    chatTimerMaxActive: positiveInteger(config.chatTimerMaxActive, 20, 'chatTimerMaxActive', 1),
    chatTimerPath: typeof chatTimerPath === 'string' ? chatTimerPath.trim() : undefined,
    chatTimerSound: chatTimerSound ?? false,
    // 陪伴感：低打扰主动关心 + 关系数据文件。
    chatProactiveEnabled: chatProactiveEnabled ?? true,
    chatCompanionPath: typeof chatCompanionPath === 'string' ? chatCompanionPath.trim() : undefined,
    // 情绪状态层：心情/精力随对话变化并自然衰减。
    chatEmotionEnabled: chatEmotionEnabled ?? true,
    // 事件记忆：记住具体发生过的事，按相关度召回。
    chatEventsEnabled: chatEventsEnabled ?? true,
    chatEventUpdateEveryTurns: positiveInteger(config.chatEventUpdateEveryTurns, 4, 'chatEventUpdateEveryTurns', 1),
    chatEventMaxEvents: positiveInteger(config.chatEventMaxEvents, 50, 'chatEventMaxEvents', 1),
    chatEventPath: typeof chatEventPath === 'string' ? chatEventPath.trim() : undefined,
    chatTimeoutMs: positiveInteger(config.chatTimeoutMs, 180_000, 'chatTimeoutMs', 1_000),
  }
}

function sleepTimeout(ms) {
  let timer
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

export class DeskpetBridge {
  constructor(ctx, options, handlers = {}) {
    this.ctx = ctx
    this.options = options
    this.handlers = handlers
    this.child = null
    this.stdoutLines = null
    this.stderrLines = null
    this.pendingPings = new Map()
    this.nextPingId = 1
    this.heartbeat = null
    this.pongCount = 0
    this.spawnPromise = null
    this.exitPromise = null
    this.exited = false
    this.stopping = false
    this.stopPromise = null
    this.exitCode = null
    this.exitSignal = null
  }

  start() {
    this.ctx.logger.info(
      'Starting Python deskpet: %s %s',
      this.options.pythonPath,
      SCRIPT_PATH,
    )

    const child = spawn(this.options.pythonPath, [SCRIPT_PATH], {
      cwd: PLUGIN_DIR,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: false,
    })
    this.child = child

    this.spawnPromise = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    // If apply() fails before ready() awaits this, do not surface a second,
    // unrelated unhandled rejection from the same spawn failure.
    this.spawnPromise.catch(() => {})

    this.exitPromise = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        this.exited = true
        this.exitCode = code
        this.exitSignal = signal
        this.onExit(code, signal)
        resolve({ code, signal })
      })
    })

    child.on('error', (error) => {
      this.ctx.logger.error('Python deskpet process error: %s', error.message)
      this.rejectPending(new Error(`Python deskpet process error: ${error.message}`))
    })

    child.stdin.on('error', (error) => {
      if (this.stopping) return
      this.ctx.logger.warn('Python deskpet stdin error: %s', error.message)
    })

    this.stdoutLines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.stdoutLines.on('line', (line) => this.onStdoutLine(line))

    this.stderrLines = createInterface({ input: child.stderr, crlfDelay: Infinity })
    this.stderrLines.on('line', (line) => {
      // Python debug output is kept on stderr and forwarded to the Host log.
      // It never enters the JSON protocol on stdout.
      this.ctx.logger.debug('[python] %s', line)
    })
  }

  async ready() {
    if (!this.child) throw new Error('deskpet bridge has not been started')

    const spawnTimeout = sleepTimeout(this.options.handshakeTimeoutMs)
    let spawned
    try {
      spawned = await Promise.race([
        this.spawnPromise.then(() => true),
        spawnTimeout.promise,
      ])
    } finally {
      spawnTimeout.cancel()
    }
    if (!spawned) {
      throw new Error(
        `Python did not spawn within ${this.options.handshakeTimeoutMs}ms: ${this.options.pythonPath}`,
      )
    }
    if (this.exited) {
      throw new Error(
        `Python exited before the handshake (code=${this.exitCode}, signal=${this.exitSignal})`,
      )
    }

    const pong = await this.ping('startup', this.options.handshakeTimeoutMs)
    this.ctx.logger.info(
      'Python deskpet ready: pid=%s pong=%d',
      pong.pid ?? this.child.pid,
      this.pongCount,
    )
    this.startHeartbeat()
    return pong
  }

  ping(reason, timeoutMs = this.options.pingTimeoutMs) {
    if (this.stopping) return Promise.reject(new Error('deskpet is stopping'))
    if (this.exited || !this.child) return Promise.reject(new Error('deskpet is not running'))
    if (!this.child.stdin.writable) return Promise.reject(new Error('deskpet stdin is closed'))

    const id = this.nextPingId++
    const message = {
      type: 'ping',
      id,
      reason,
      sentAt: new Date().toISOString(),
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(id)
        reject(new Error(`deskpet ping ${id} (${reason}) timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.pendingPings.set(id, { resolve, reject, timer })

      try {
        this.writeMessage(message)
      } catch (error) {
        clearTimeout(timer)
        this.pendingPings.delete(id)
        reject(error)
      }
    })
  }

  writeMessage(message) {
    if (!this.child?.stdin.writable) throw new Error('deskpet stdin is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  onStdoutLine(line) {
    const text = line.trim()
    if (text === '') return

    let message
    try {
      message = JSON.parse(text)
    } catch {
      // A non-JSON stdout line is a protocol violation. It is reported, not
      // forwarded as a response, so stale debug prints cannot satisfy a ping.
      this.ctx.logger.warn('Ignoring non-JSON stdout from Python deskpet: %s', text.slice(0, 300))
      return
    }

    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.ctx.logger.warn('Ignoring non-object JSON from Python deskpet: %s', text.slice(0, 300))
      return
    }

    switch (message.type) {
      case 'pong': {
        const pending = this.pendingPings.get(message.id)
        if (!pending) {
          this.ctx.logger.debug('Ignoring unmatched pong id=%s', message.id)
          return
        }
        clearTimeout(pending.timer)
        this.pendingPings.delete(message.id)
        this.pongCount += 1
        pending.resolve(message)
        return
      }
      case 'bye':
        this.ctx.logger.debug('Python deskpet acknowledged shutdown (id=%s)', message.id)
        return
      case 'chat':
        // 桌宠对话框的输入：交给 DeskpetChat，用 DSH 已配置的模型直接回答。
        if (typeof this.handlers.onChat === 'function') {
          this.handlers.onChat(message)
          return
        }
        this.ctx.logger.warn('deskpet chat is not routed (id=%s)', message.id)
        this.writeMessage({
          type: 'chat/error',
          id: message.id,
          message: '主机端聊天路由不可用',
        })
        return
      case 'memory/list':
        if (typeof this.handlers.onMemoryList === 'function') {
          this.handlers.onMemoryList(message)
          return
        }
        this.writeMessage({ type: 'chat/memory/error', id: message.id, message: '主机端记忆路由不可用' })
        return
      case 'memory/delete':
        if (typeof this.handlers.onMemoryDelete === 'function') {
          this.handlers.onMemoryDelete(message)
          return
        }
        this.writeMessage({ type: 'chat/memory/error', id: message.id, message: '主机端记忆路由不可用' })
        return
      default:
        this.ctx.logger.info('Python deskpet sent %s: %o', message.type ?? '(no type)', message)
    }
  }

  onExit(code, signal) {
    this.clearHeartbeat()
    this.rejectPending(
      new Error(`Python deskpet exited (code=${code}, signal=${signal})`),
    )
    this.stdoutLines?.close()
    this.stderrLines?.close()
    this.stdoutLines = null
    this.stderrLines = null

    if (this.stopping) {
      this.ctx.logger.info('Python deskpet exited (code=%s, signal=%s)', code, signal)
    } else {
      this.ctx.logger.warn('Python deskpet exited unexpectedly (code=%s, signal=%s)', code, signal)
    }
  }

  startHeartbeat() {
    this.clearHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.stopping || this.exited || this.pendingPings.size > 0) return
      this.ping('heartbeat').catch((error) => {
        if (!this.stopping) this.ctx.logger.warn('Python deskpet heartbeat failed: %s', error.message)
      })
    }, this.options.pingIntervalMs)
    this.heartbeat.unref?.()
  }

  clearHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  rejectPending(error) {
    for (const pending of this.pendingPings.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingPings.clear()
  }

  async waitForExit(timeoutMs) {
    if (this.exited) return true
    const timeout = sleepTimeout(timeoutMs)
    try {
      return await Promise.race([
        this.exitPromise.then(() => true),
        timeout.promise,
      ])
    } finally {
      timeout.cancel()
    }
  }

  stop() {
    if (this.stopPromise) return this.stopPromise
    this.stopping = true
    this.clearHeartbeat()
    this.rejectPending(new Error('deskpet is stopping'))
    this.stopPromise = this.shutdown()
    return this.stopPromise
  }

  async shutdown() {
    const child = this.child
    if (!child) return

    this.ctx.logger.info('Stopping Python deskpet...')
    if (!this.exited) {
      try {
        if (child.stdin.writable) {
          child.stdin.write(
            `${JSON.stringify({ type: 'shutdown', id: this.nextPingId++ })}\n`,
          )
          child.stdin.end()
        }
      } catch (error) {
        this.ctx.logger.warn('Could not send deskpet shutdown message: %s', error.message)
      }

      let exited = await this.waitForExit(this.options.shutdownTimeoutMs)
      if (!exited) {
        this.ctx.logger.warn(
          'Python deskpet did not exit within %dms; terminating pid=%s',
          this.options.shutdownTimeoutMs,
          child.pid,
        )
        child.kill()
        exited = await this.waitForExit(1_000)
        if (!exited) {
          this.ctx.logger.error('Python deskpet pid=%s is still running after termination', child.pid)
        }
      }
    }

    this.stdoutLines?.close()
    this.stderrLines?.close()
    this.stdoutLines = null
    this.stderrLines = null
    this.ctx.logger.info('Python deskpet stopped (code=%s, signal=%s)', this.exitCode, this.exitSignal)
  }
}

/**
 * 桌宠对话：直接用 DSH 已配置的模型回答，不创建会话、不写 DSH 聊天记录。
 *
 * - 模型路由默认取 `agentDefaultModel.currentSelection()`，可用配置覆盖；
 * - 对话历史保存在本对象内存里，只回传给模型用于上下文；
 * - 桌宠窗口的气泡是唯一的聊天记录展示处；
 * - 模型调用走 `ctx.llm.stream()`，与 DSH 里的模型/密钥配置共用，不需要另配 Key。
 */

/** 只保留/拼接文本块的最小流装配器，不依赖 @deepseek-ai 包。 */
function createTextAssembler() {
  const parts = new Map()
  const order = []
  let finish = { kind: 'stop' }

  function ensure(index, type) {
    let part = parts.get(index)
    if (part === undefined) {
      part = { type, text: '' }
      parts.set(index, part)
      order.push(index)
    }
    return part
  }

  return {
    push(chunk) {
      switch (chunk.type) {
        case 'block-start':
          ensure(chunk.index, chunk.blockType)
          return
        case 'text-delta':
          ensure(chunk.index, 'text').text += chunk.text
          return
        case 'reasoning-delta':
        case 'tool-call-delta':
          return
        case 'block-end': {
          const part = ensure(chunk.index, chunk.block?.type ?? 'text')
          if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
            part.text = chunk.block.text
          }
          return
        }
        case 'finish':
          finish = chunk.reason ?? finish
          return
        default:
          return
      }
    },
    text() {
      return order
        .map((index) => parts.get(index))
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('')
    },
    get finish() {
      return finish
    },
  }
}

/** 一条只含文本的 durable 消息；不需要会话也能作为模型输入。 */
function textMessage(role, text, source) {
  return {
    id: randomUUID(),
    role,
    content: [{ type: 'text', text }],
    source,
  }
}

/** 校验持久化历史里的一条记录。 */
function isHistoryEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && (entry.role === 'user' || entry.role === 'assistant')
    && typeof entry.text === 'string' && entry.text.trim() !== ''
}

/** 记忆文本归一化：必须单行，避免换行/控制字符注入系统提示。 */
function sanitizeFactText(text) {
  return text
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 长期记忆整理器的系统提示：把聊天提炼成“用户画像”。 */
function memoryExtractionPrompt(existingFacts, maxFacts, forgottenCount = 0) {
  const existing = existingFacts.length === 0
    ? '（暂无）'
    : existingFacts.map((fact) => `- [${fact.kind}] ${fact.text}`).join('\n')
  const rules = [
    '1. 只保留对长期陪伴有价值的信息：用户称呼、偏好、习惯、目标、重要事实、忌讳、情绪倾向。',
    '2. 合并重复或相近的条目；新信息覆盖旧信息；不确定的不要写；不要编造。',
    `3. 每条不超过 40 个字；总数不超过 ${maxFacts} 条；按重要性排序。`,
    '4. 只输出一个 JSON 数组，元素形如 {"kind":"preference","text":"..."}；',
    '   kind 只能是 preference / habit / goal / fact / relation。',
    '5. 不要输出任何其他文字、解释或代码块标记。',
  ]
  if (forgottenCount > 0) {
    rules.push(
      `6. 用户已删除 ${forgottenCount} 条记忆：不要恢复、不要重新添加已删除的内容，`
      + '只根据最近对话与已有记忆整理。',
    )
  }
  return [
    '你是桌宠的长期记忆整理器：从用户的聊天里提炼值得长期记住的信息，形成一份稳定的“用户画像”。',
    '规则：',
    ...rules,
    '',
    '已有记忆：',
    existing,
  ].join('\n')
}

/** 从模型输出里解析记忆 JSON；解析失败返回 null，保留旧记忆。 */
function parseMemoryFacts(text, maxFacts) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  let parsed
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const facts = []
  const seen = new Set()
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const value = typeof item.text === 'string' ? sanitizeFactText(item.text) : ''
    if (value === '' || value.length > 80) continue
    if (seen.has(value)) continue
    seen.add(value)
    const kind = MEMORY_KINDS.has(item.kind) ? item.kind : 'fact'
    facts.push({ kind, text: value })
    if (facts.length >= maxFacts) break
  }
  return facts
}

function memoryFactId(fact) {
  return createHash('sha256').update(sanitizeFactText(fact.text).toLowerCase()).digest('hex')
}

// ---------------------------------------------------------------- 计时/提醒

const TIMER_VERSION = 1
const TIMER_UNITS = [
  ['钟头', 3_600_000], ['小时', 3_600_000], ['h', 3_600_000],
  ['分钟', 60_000], ['分', 60_000], ['min', 60_000], ['m', 60_000],
  ['秒钟', 1_000], ['秒', 1_000], ['s', 1_000],
]
const TIMER_ACTION_PREFIX = /^(?:倒计时|计时|提醒我|查看计时|计时列表|提醒列表|取消)/u

function durationToMs(count, unit) {
  const label = String(unit).toLowerCase()
  const entry = TIMER_UNITS.find(([name]) => name.toLowerCase() === label)
  if (entry === undefined) return null
  const value = Number(count) * entry[1]
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) return null
  return Math.round(value)
}

function formatDuration(ms) {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000 * 10) / 10} 小时`
  if (ms >= 60_000) return `${Math.round(ms / 60_000 * 10) / 10} 分钟`
  return `${Math.round(ms / 1_000)} 秒`
}

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1_000))
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    return `${hours}小时${minutes}分`
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return `${minutes}分${rest}秒`
  }
  return `${seconds}秒`
}

function timerFireText(timer) {
  if (timer.kind === 'reminder') return timer.label ? `提醒：${timer.label}` : '时间到了'
  return `计时结束：${formatDuration(timer.durationMs ?? (timer.dueAt - timer.createdAt))}`
}

function normalizeTimer(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = raw.id
  const dueAt = raw.dueAt
  const createdAt = Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0
  if (!Number.isSafeInteger(id) || id <= 0) return null
  if (raw.kind !== 'countdown' && raw.kind !== 'reminder') return null
  if (!Number.isSafeInteger(dueAt) || dueAt <= 0) return null
  const label = typeof raw.label === 'string' ? sanitizeFactText(raw.label) : ''
  const durationMs = Number.isSafeInteger(raw.durationMs) && raw.durationMs > 0
    ? raw.durationMs
    : Math.max(0, dueAt - createdAt)
  return { id, kind: raw.kind, label, dueAt, createdAt, durationMs }
}

export class DeskpetChat {
  constructor(ctx, bridge, options) {
    this.ctx = ctx
    this.bridge = bridge
    this.options = options
    // 对话历史：[{ role: 'user' | 'assistant', text, time }]
    // 同时用于模型上下文、桌宠窗口显示和落盘保存，做到重启后仍有记忆。
    this.entries = []
    this.historyPath = options.chatHistoryPath ?? defaultChatHistoryPath()
    // 长期记忆：[{ kind, text }]，越聊越懂用户。
    this.memoryFacts = []
    this.memoryPath = options.chatMemoryPath ?? defaultMemoryPath()
    this.memoryTurns = 0
    this.memoryJob = null
    this.memoryAbort = null
    this.memoryRevision = 0
    this.memoryLoad = null
    this.memoryChanges = Promise.resolve()
    this.forgottenFactHashes = new Set()
    this.forgottenAfter = 0
    this.loaded = false
    this.memoryLoaded = false
    this.historyDirty = false
    this.memoryDirty = false
    // 计时/提醒：[{ id, kind, label, dueAt, createdAt, durationMs }]
    this.timers = []
    this.timerPath = options.chatTimerPath ?? defaultTimersPath()
    this.timerLoad = null
    this.timerLoaded = false
    this.timerSeq = 0
    this.timerTickHandle = null
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    // 陪伴关系：认识时间、聊天轮数、主动关心的节流。
    this.companion = {
      version: COMPANION_VERSION,
      firstSeenAt: 0,
      turns: 0,
      lastInteractAt: 0,
      lastProactiveAt: 0,
      lastProactiveDay: '',
      emotion: { valence: 0, energy: 0.5, updatedAt: 0, recent: [] },
    }
    this.companionPath = options.chatCompanionPath ?? defaultCompanionPath()
    this.companionLoad = null
    this.companionLoaded = false
    this.proactiveHandle = null
    this.moodHint = null
    // 事件记忆：[{ id, summary, when, importance, createdAt }]
    this.events = []
    this.eventPath = options.chatEventPath ?? defaultEventsPath()
    this.eventLoad = null
    this.eventLoaded = false
    this.eventTurns = 0
    this.eventJob = null
    this.eventAbort = null
    this.recalledEvents = []
    this.pending = null
    this.disposed = false
  }

  // ---------------------------------------------------------------- 历史

  async loadHistory() {
    this.loaded = true
    this.historyDirty = false
    let raw
    try {
      raw = await readFile(this.historyPath, 'utf8')
    } catch (error) {
      this.entries = []
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn('deskpet chat history load failed: %s', error?.message ?? String(error))
        await this.quarantineFile(this.historyPath)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
      this.entries = messages.filter(isHistoryEntry).map((entry) => ({
        role: entry.role,
        text: entry.text,
        time: typeof entry.time === 'string' && entry.time !== ''
          ? entry.time
          : new Date().toISOString(),
      }))
    } catch (error) {
      this.ctx.logger.warn('deskpet chat history is not valid JSON: %s', error?.message ?? String(error))
      this.entries = []
      await this.quarantineFile(this.historyPath)
    }
    this.trimEntries()
    this.ctx.logger.info(
      'deskpet chat history loaded: %d messages from %s',
      this.entries.length,
      this.historyPath,
    )
  }

  /** 历史/记忆文件损坏时改名保留，避免下一次保存把它悄悄覆盖掉。 */
  async quarantineFile(path) {
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // 文件不存在或不可重命名时忽略
    }
  }

  /** 把历史交给 Python 对话框渲染（插件启动时调用一次）。 */
  sendHistoryToPet() {
    this.write({
      type: 'chat/history',
      entries: this.entries.map((entry) => ({
        role: entry.role,
        text: entry.text,
        time: entry.time,
      })),
    })
  }

  historyContent() {
    return JSON.stringify({
      version: CHAT_HISTORY_VERSION,
      savedAt: new Date().toISOString(),
      messages: this.entries,
    }, null, 2)
  }

  async persistHistory() {
    const saved = await this.persistFile(this.historyPath, this.historyContent(), 'history')
    if (saved) this.historyDirty = false
    return saved
  }

  persistHistorySync() {
    const saved = this.persistFileSync(this.historyPath, this.historyContent(), 'history')
    if (saved) this.historyDirty = false
    return saved
  }

  trimEntries() {
    const limit = this.options.chatHistoryMaxMessages
    if (this.entries.length > limit) {
      this.entries.splice(0, this.entries.length - limit)
    }
  }

  historyMessages(selection) {
    const limit = this.options.chatHistoryMessages
    return this.entries.slice(-limit).map((entry) => textMessage(
      entry.role,
      entry.text,
      entry.role === 'user'
        ? { kind: 'user' }
        : { kind: 'model', provider: selection.provider, model: selection.model },
    ))
  }

  // ---------------------------------------------------------------- 长期记忆

  async loadMemory() {
    this.memoryLoad ??= this.readMemory().finally(() => { this.memoryLoaded = true })
    return this.memoryLoad
  }

  async readMemory() {
    this.memoryDirty = false
    let raw
    try {
      raw = await readFile(this.memoryPath, 'utf8')
    } catch (error) {
      this.memoryFacts = []
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn('deskpet memory load failed: %s', error?.message ?? String(error))
        await this.quarantineFile(this.memoryPath)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      this.forgottenAfter = Number.isSafeInteger(parsed?.forgottenAfter) && parsed.forgottenAfter >= 0
        ? parsed.forgottenAfter : 0
      this.forgottenFactHashes = new Set((Array.isArray(parsed?.forgottenFactHashes) ? parsed.forgottenFactHashes : [])
        .filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)))
      const facts = Array.isArray(parsed?.facts) ? parsed.facts : []
      this.memoryFacts = facts
        .filter((fact) => fact !== null && typeof fact === 'object'
          && typeof fact.text === 'string' && fact.text.trim() !== '')
        .map((fact) => ({
          kind: MEMORY_KINDS.has(fact.kind) ? fact.kind : 'fact',
          text: sanitizeFactText(fact.text),
        }))
        .filter(fact => fact.text !== '')
        .filter(fact => !this.forgottenFactHashes.has(memoryFactId(fact)))
        .slice(-this.options.chatMemoryMaxFacts)
    } catch (error) {
      this.ctx.logger.warn('deskpet memory is not valid JSON: %s', error?.message ?? String(error))
      this.memoryFacts = []
      await this.quarantineFile(this.memoryPath)
    }
    this.ctx.logger.info(
      'deskpet memory loaded: %d facts from %s',
      this.memoryFacts.length,
      this.memoryPath,
    )
  }

  memoryContent(facts = this.memoryFacts, hashes = this.forgottenFactHashes, after = this.forgottenAfter) {
    return JSON.stringify({
      version: MEMORY_VERSION,
      updatedAt: new Date().toISOString(),
      facts,
      forgottenAfter: after,
      forgottenFactHashes: [...hashes],
    }, null, 2)
  }

  async persistMemory() {
    return this.queueMemoryChange(() => !this.disposed && this.persistMemorySync())
  }

  persistMemorySync() {
    const saved = this.persistFileSync(this.memoryPath, this.memoryContent(), 'memory')
    if (saved) this.memoryDirty = false
    return saved
  }

  queueMemoryChange(change) {
    const task = this.memoryChanges.then(change)
    this.memoryChanges = task.catch(() => {})
    return task
  }

  // A small bounded profile is saved synchronously inside the mutation queue:
  // rename finishes before publishing state, so unload cannot race an old write.
  commitMemory(facts, hashes = this.forgottenFactHashes, after = this.forgottenAfter) {
    if (this.disposed) return false
    if (!this.persistFileSync(this.memoryPath, this.memoryContent(facts, hashes, after), 'memory')) return false
    this.memoryFacts = facts
    this.forgottenFactHashes = hashes
    this.forgottenAfter = after
    this.memoryRevision += 1
    this.memoryDirty = false
    return true
  }

  async persistFile(path, content, label) {
    try {
      await mkdir(dirname(path), { recursive: true })
      const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
      await writeFile(temp, content, 'utf8')
      await rename(temp, path)
      return true
    } catch (error) {
      this.ctx.logger.warn('deskpet %s save failed: %s', label, error?.message ?? String(error))
      return false
    }
  }

  persistFileSync(path, content, label) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
      writeFileSync(temp, content, 'utf8')
      renameSync(temp, path)
      return true
    } catch (error) {
      this.ctx.logger.warn('deskpet %s save failed at shutdown: %s', label, error?.message ?? String(error))
      return false
    }
  }

  /** 把“已记住 N 件事”同步给对话框，让用户看到桌宠在变懂自己。 */
  sendMemoryToPet() {
    this.write({
      type: 'chat/memory',
      count: this.memoryFacts.length,
      updatedAt: new Date().toISOString(),
    })
  }

  memoryError(id, message) {
    this.write({ type: 'chat/memory/error', id, message })
  }

  sendMemoryDetails(id) {
    if (this.disposed || !this.memoryLoaded) {
      this.memoryError(id, this.disposed ? '桌宠桥接已停止' : '记忆正在加载，请稍后刷新')
      return
    }
    this.write({
      type: 'chat/memory/details',
      ...(id === undefined ? {} : { id }),
      revision: this.memoryRevision,
      enabled: this.options.chatMemoryEnabled,
      items: this.memoryFacts.map((fact) => ({
        id: memoryFactId(fact),
        kind: fact.kind,
        text: fact.text,
      })),
    })
  }

  async deleteMemory(factId, revision, requestId) {
    return this.queueMemoryChange(() => {
      if (this.disposed || !this.memoryLoaded) {
        this.memoryError(requestId, '记忆尚不可用，请稍后刷新')
        return
      }
      if (!Number.isSafeInteger(revision) || revision !== this.memoryRevision) {
        this.memoryError(requestId, '记忆列表已更新，请刷新后重新选择')
        return
      }
      if (typeof factId !== 'string' || !this.memoryFacts.some(fact => memoryFactId(fact) === factId)) {
        this.memoryError(requestId, '要删除的记忆不存在，请刷新列表')
        return
      }
      const remaining = this.memoryFacts.filter(fact => memoryFactId(fact) !== factId)
      const forgotten = new Set([...this.forgottenFactHashes, factId])
      if (!this.commitMemory(remaining, forgotten, Math.max(Date.now(), this.forgottenAfter))) {
        this.memoryError(requestId, '记忆保存失败，原条目已保留；请重试')
        return
      }
      this.memoryTurns = 0
      this.sendMemoryToPet()
      this.sendMemoryDetails(requestId)
    })
  }

  /** 注入到每次回复的系统提示里：人格 + 长期记忆 + 关系感 + 当前情绪。 */
  composeSystemPrompt() {
    const sections = [this.options.chatSystemPrompt]
    if (this.options.chatMemoryEnabled && this.memoryFacts.length > 0) {
      sections.push(
        '',
        '# 你记得关于用户的事（长期记忆，回答时自然使用，不要逐条复述）',
        ...this.memoryFacts.map((fact) => `- ${fact.text}`),
      )
    }
    if (this.options.chatEventsEnabled && this.recalledEvents.length > 0) {
      sections.push(
        '',
        '# 你们之前聊过的一些事（按相关度选取，自然引用，不要逐条复述）',
        ...this.recalledEvents.map((event) => `- ${event.summary}${event.when ? `（${event.when}）` : ''}`),
      )
    }
    const days = this.companionDays()
    if (this.companionLoaded && days >= 2) {
      sections.push('', '# 关系', `你们已经认识 ${days} 天，聊过 ${this.companion.turns} 轮。`)
    }
    if (this.options.chatEmotionEnabled && this.companionLoaded) {
      const emotion = this.companion.emotion
      const meaningful = emotion.recent.length > 0
        || Math.abs(emotion.valence) >= 0.1
        || Math.abs(emotion.energy - 0.5) >= 0.15
      if (meaningful) sections.push('', '# 你的状态', this.emotionStateText())
    }
    if (this.moodHint) sections.push('', '# 当前情绪', this.moodHint)
    return sections.join('\n')
  }

  /** 每完成一轮对话计数；达到阈值就异步整理长期记忆与事件记忆。 */
  noteSuccessfulTurn() {
    if (this.disposed) return
    if (this.options.chatMemoryEnabled) {
      this.memoryTurns += 1
      if (this.memoryTurns >= this.options.chatMemoryUpdateEveryTurns
        && this.memoryJob === null) {
        this.memoryJob = this.updateMemory().finally(() => {
          this.memoryJob = null
        })
      }
    }
    if (this.options.chatEventsEnabled) {
      this.eventTurns += 1
      if (this.eventTurns >= this.options.chatEventUpdateEveryTurns
        && this.eventJob === null) {
        this.eventJob = this.updateEvents().finally(() => {
          this.eventJob = null
        })
      }
    }
  }

  /** 用同一模型的轻量调用把最近聊天提炼成用户画像。 */
  async updateMemory() {
    if (this.disposed) return
    const selection = this.modelSelection()
    const llm = this.service('llm')
    if (selection === null || typeof llm?.stream !== 'function') return
    // After a deletion, never re-distil pre-deletion user turns (including
    // a reply to an old user message that finishes after deletion).
    let includeTurn = this.forgottenAfter === 0
    const transcript = this.entries.filter(entry => {
      if (entry.role === 'user') includeTurn = this.forgottenAfter === 0 || Date.parse(entry.time) > this.forgottenAfter
      return includeTurn
    })
      .slice(-this.options.chatMemoryTranscriptMessages)
      .map((entry) => `${entry.role === 'user' ? '用户' : '桌宠'}：${entry.text}`)
      .join('\n')
    if (transcript === '') return

    const abort = new AbortController()
    const revision = this.memoryRevision
    this.memoryAbort = abort
    const assembler = createTextAssembler()
    try {
      const request = {
        provider: selection.provider,
        model: selection.model,
        messages: [textMessage('user', `最近对话：\n${transcript}`)],
        system: memoryExtractionPrompt(
          this.memoryFacts,
          this.options.chatMemoryMaxFacts,
          this.forgottenFactHashes.size,
        ),
        maxTokens: 512,
        signal: abort.signal,
      }
      for await (const chunk of llm.stream(request)) {
        abort.signal.throwIfAborted()
        assembler.push(chunk)
      }
      abort.signal.throwIfAborted()
      if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') throw new Error('记忆整理未正常完成')
      const facts = parseMemoryFacts(assembler.text(), this.options.chatMemoryMaxFacts)
      if (facts === null) throw new Error('记忆整理结果不是合法 JSON 数组')
      await this.queueMemoryChange(() => {
        if (this.disposed || revision !== this.memoryRevision) return
        const retained = facts.filter(fact => !this.forgottenFactHashes.has(memoryFactId(fact)))
        if (!this.commitMemory(retained)) throw new Error('记忆保存失败，保留旧画像')
        this.memoryTurns = 0
        this.sendMemoryToPet()
        this.ctx.logger.info('deskpet memory updated: %d facts', this.memoryFacts.length)
      })
    } catch (error) {
      this.memoryTurns = 0
      this.ctx.logger.warn('deskpet memory update failed: %s', error?.message ?? String(error))
    } finally {
      if (this.memoryAbort === abort) this.memoryAbort = null
    }
  }

  // ---------------------------------------------------------------- 计时/提醒

  async loadTimers() {
    this.timerLoad ??= this.readTimers().finally(() => { this.timerLoaded = true })
    return this.timerLoad
  }

  async readTimers() {
    let raw
    try {
      raw = await readFile(this.timerPath, 'utf8')
    } catch (error) {
      this.timers = []
      this.timerSeq = 0
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn('deskpet timers load failed: %s', error?.message ?? String(error))
        await this.quarantineFile(this.timerPath)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.timers) ? parsed.timers : []
      this.timers = list.map(normalizeTimer).filter(timer => timer !== null)
      const seq = Number.isSafeInteger(parsed?.seq) && parsed.seq > 0 ? parsed.seq : 0
      this.timerSeq = Math.max(seq, ...this.timers.map(timer => timer.id), 0)
    } catch (error) {
      this.ctx.logger.warn('deskpet timers is not valid JSON: %s', error?.message ?? String(error))
      this.timers = []
      this.timerSeq = 0
      await this.quarantineFile(this.timerPath)
    }
    this.ctx.logger.info('deskpet timers loaded: %d', this.timers.length)
  }

  timerContent() {
    return JSON.stringify({
      version: TIMER_VERSION,
      updatedAt: new Date().toISOString(),
      seq: this.timerSeq,
      timers: this.timers,
    }, null, 2)
  }

  persistTimersSync() {
    this.persistFileSync(this.timerPath, this.timerContent(), 'timers')
  }

  /** 把当前计时状态推给 Python，用于标题栏实时倒计时。 */
  sendTimerChanged() {
    if (this.disposed) return
    const now = this.now()
    this.write({
      type: 'chat/timer',
      event: 'changed',
      timers: [...this.timers]
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)
        .map((timer) => ({
          id: timer.id,
          kind: timer.kind,
          label: timer.label,
          remainingMs: Math.max(0, timer.dueAt - now),
        })),
    })
  }

  parseTimerCommand(text) {
    const value = (text || '').trim()
    if (value === '') return null
    // 常见自然说法归一化成「数字 + 单位」再解析。
    const normalized = value
      .replace(/半个小时|半小时/gu, '30 分钟')
      .replace(/一刻钟/gu, '15 分钟')
      .replace(/一个小时|一小时/gu, '1 小时')
    if (/^(?:查看计时|计时列表|提醒列表)$/u.test(normalized)) return { action: 'list' }
    if (/^取消所有计时$/u.test(normalized)) return { action: 'cancel-all' }
    let match = normalized.match(/^取消(?:计时)?\s*#?(\d+)$/u)
    if (match) return { action: 'cancel', id: Number(match[1]) }
    match = normalized.match(/^(?:倒计时|计时)\s*(\d+)\s*(秒钟|秒|分钟|分|小时|钟头|min|m|s|h)\s*$/iu)
    if (match) {
      const durationMs = durationToMs(match[1], match[2])
      if (durationMs !== null) {
        return { action: 'create', kind: 'countdown', durationMs, label: '' }
      }
    }
    match = normalized.match(/^(?:提醒我\s*)?(\d+)\s*(秒钟|秒|分钟|分|小时|钟头|min|m|s|h)\s*后\s*(?:提醒我|提醒)?\s*(.*)$/iu)
    if (match) {
      const durationMs = durationToMs(match[1], match[2])
      if (durationMs !== null) {
        return { action: 'create', kind: 'reminder', durationMs, label: (match[3] ?? '').trim() }
      }
    }
    if (TIMER_ACTION_PREFIX.test(normalized)) return { action: 'invalid' }
    return null
  }

  timerListReply() {
    if (this.timers.length === 0) return '现在没有进行中的计时。'
    const lines = [...this.timers]
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)
      .map((timer) => {
        const remaining = formatRemaining(timer.dueAt - this.now())
        if (timer.kind === 'countdown') return `#${timer.id} 计时 ${remaining}后结束`
        return `#${timer.id} 提醒 ${remaining}后${timer.label ? `：${timer.label}` : ''}`
      })
    return lines.join('\n')
  }

  executeTimerCommand(command) {
    if (command.action === 'list') return this.timerListReply()
    if (command.action === 'invalid') {
      return '计时命令没看懂：时长要写成「数字 + 秒/分钟/小时」，比如「计时 5 分钟」或「10 分钟后提醒我 喝水」。'
    }
    if (command.action === 'cancel-all') {
      if (this.timers.length === 0) return '现在没有进行中的计时。'
      const count = this.timers.length
      this.timers = []
      this.persistTimersSync()
      this.sendTimerChanged()
      return `已取消全部 ${count} 个计时。`
    }
    if (command.action === 'cancel') {
      const target = this.timers.find(timer => timer.id === command.id)
      if (target === undefined) return `没有找到计时 #${command.id}，可用「查看计时」确认。`
      this.timers = this.timers.filter(timer => timer.id !== command.id)
      this.persistTimersSync()
      this.sendTimerChanged()
      return `已取消计时 #${command.id}。`
    }
    if (command.action === 'create') {
      const limit = this.options.chatTimerMaxActive
      if (this.timers.length >= limit) {
        return `现在最多同时进行 ${limit} 个计时，先取消一个再来吧。`
      }
      const id = ++this.timerSeq
      const createdAt = this.now()
      const timer = {
        id,
        kind: command.kind,
        label: command.label,
        dueAt: createdAt + command.durationMs,
        createdAt,
        durationMs: command.durationMs,
      }
      this.timers.push(timer)
      this.persistTimersSync()
      this.sendTimerChanged()
      const duration = formatDuration(command.durationMs)
      if (command.kind === 'countdown') {
        return `好，开始计时 ${duration}（#${id}）。到点我会提醒你。`
      }
      return command.label === ''
        ? `好，${duration} 后提醒你（#${id}）。`
        : `好，${duration} 后提醒你：${command.label}（#${id}）。`
    }
    return '计时命令没看懂。'
  }

  /** 触发所有到点的计时；返回本次触发的数量。 */
  tickTimers() {
    if (this.disposed || !this.options.chatTimerEnabled || !this.timerLoaded) return 0
    const now = this.now()
    const due = this.timers
      .filter(timer => timer.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)
    if (due.length > 0) {
      const dueIds = new Set(due.map(timer => timer.id))
      this.timers = this.timers.filter(timer => !dueIds.has(timer.id))
      this.persistTimersSync()
      for (const timer of due) {
        this.write({
          type: 'chat/timer',
          event: 'fired',
          id: timer.id,
          kind: timer.kind,
          label: timer.label,
          text: timerFireText(timer),
          dueAt: timer.dueAt,
          sound: this.options.chatTimerSound === true,
        })
      }
    }
    // 有进行中的计时就每秒刷新倒计时；最后一个触发后也推一次空列表。
    if (this.timers.length > 0 || due.length > 0) this.sendTimerChanged()
    return due.length
  }

  startTimerTicker() {
    if (this.timerTickHandle !== null || this.disposed || !this.options.chatTimerEnabled) return
    const tick = () => {
      try {
        this.tickTimers()
      } catch (error) {
        this.ctx.logger.warn('deskpet timer tick failed: %s', error?.message ?? String(error))
      }
    }
    tick()
    this.timerTickHandle = setInterval(tick, 1_000)
    this.timerTickHandle.unref?.()
  }

  stopTimerTicker() {
    if (this.timerTickHandle === null) return
    clearInterval(this.timerTickHandle)
    this.timerTickHandle = null
  }

  // ---------------------------------------------------------------- 陪伴关系

  async loadCompanion() {
    this.companionLoad ??= this.readCompanion().finally(() => { this.companionLoaded = true })
    return this.companionLoad
  }

  async readCompanion() {
    let raw
    try {
      raw = await readFile(this.companionPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn('deskpet companion load failed: %s', error?.message ?? String(error))
        await this.quarantineFile(this.companionPath)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const safe = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
      const rawEmotion = parsed?.emotion ?? {}
      this.companion = {
        version: COMPANION_VERSION,
        firstSeenAt: safe(parsed?.firstSeenAt),
        turns: safe(parsed?.turns),
        lastInteractAt: safe(parsed?.lastInteractAt),
        lastProactiveAt: safe(parsed?.lastProactiveAt),
        lastProactiveDay: typeof parsed?.lastProactiveDay === 'string' ? parsed.lastProactiveDay : '',
        emotion: {
          valence: clamp(rawEmotion?.valence, -1, 1),
          energy: clamp(rawEmotion?.energy, 0, 1, 0.5),
          updatedAt: safe(rawEmotion?.updatedAt),
          recent: (Array.isArray(rawEmotion?.recent) ? rawEmotion.recent : [])
            .filter((item) => item !== null && typeof item === 'object'
              && typeof item.mood === 'string' && MOOD_EFFECTS[item.mood] !== undefined
              && Number.isSafeInteger(item.at) && item.at > 0)
            .map((item) => ({
              mood: item.mood,
              intensity: clamp(item.intensity, 0, 1, 0.5),
              at: item.at,
            }))
            .slice(-EMOTION_MAX_RECENT),
        },
      }
    } catch (error) {
      this.ctx.logger.warn('deskpet companion is not valid JSON: %s', error?.message ?? String(error))
      this.companion = {
        ...this.companion,
        firstSeenAt: 0,
        turns: 0,
        lastInteractAt: 0,
        lastProactiveAt: 0,
        lastProactiveDay: '',
        emotion: { valence: 0, energy: 0.5, updatedAt: 0, recent: [] },
      }
      await this.quarantineFile(this.companionPath)
    }
    this.decayEmotion()
    this.ctx.logger.info('deskpet companion loaded: %d turns', this.companion.turns)
  }

  companionContent() {
    return JSON.stringify({
      version: COMPANION_VERSION,
      updatedAt: new Date().toISOString(),
      ...this.companion,
    }, null, 2)
  }

  persistCompanionSync() {
    this.persistFileSync(this.companionPath, this.companionContent(), 'companion')
  }

  /** 情绪随时间的自然衰减：心情趋近 0，精力趋近 0.5。 */
  decayEmotion(now = this.now()) {
    const emotion = this.companion.emotion
    if (emotion === undefined) return
    if (emotion.updatedAt <= 0) {
      emotion.updatedAt = now
      return
    }
    const hours = Math.max(0, (now - emotion.updatedAt) / 3_600_000)
    if (hours <= 0) return
    emotion.valence *= 1 - Math.min(1, hours * 0.02)
    emotion.energy += (0.5 - emotion.energy) * Math.min(1, hours * 0.05)
    emotion.updatedAt = now
  }

  /** 根据用户这轮说的话更新情绪状态（关闭时不更新）。 */
  updateEmotion(text) {
    if (!this.options.chatEmotionEnabled) return
    this.decayEmotion()
    const mood = matchMood(text)
    if (mood === null) return
    const effect = MOOD_EFFECTS[mood.mood]
    const emotion = this.companion.emotion
    emotion.valence = clamp(emotion.valence + effect.valence * mood.intensity, -1, 1)
    emotion.energy = clamp(emotion.energy + effect.energy * mood.intensity, 0, 1)
    emotion.updatedAt = this.now()
    emotion.recent.push({ mood: mood.mood, intensity: mood.intensity, at: this.now() })
    if (emotion.recent.length > EMOTION_MAX_RECENT) {
      emotion.recent.splice(0, emotion.recent.length - EMOTION_MAX_RECENT)
    }
  }

  emotionStateText() {
    const emotion = this.companion.emotion
    const mood = emotion.valence < -0.25 ? '有些低落' : emotion.valence > 0.25 ? '不错' : '平静'
    const energy = emotion.energy < 0.3 ? '精力偏低' : emotion.energy > 0.7 ? '精力充沛' : '精力一般'
    const recent = [...new Set(emotion.recent.map((item) => MOOD_LABELS[item.mood]).filter(Boolean))]
    const recentText = recent.length > 0 ? `最近感受到的用户情绪：${recent.join('、')}。` : ''
    return `你现在心情${mood}，${energy}。${recentText}`
  }

  // ---------------------------------------------------------------- 事件记忆

  async loadEvents() {
    this.eventLoad ??= this.readEvents().finally(() => { this.eventLoaded = true })
    return this.eventLoad
  }

  async readEvents() {
    let raw
    try {
      raw = await readFile(this.eventPath, 'utf8')
    } catch (error) {
      this.events = []
      if (error?.code !== 'ENOENT') {
        this.ctx.logger.warn('deskpet events load failed: %s', error?.message ?? String(error))
        await this.quarantineFile(this.eventPath)
      }
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.events) ? parsed.events : []
      this.events = list
        .filter((event) => event !== null && typeof event === 'object'
          && typeof event.summary === 'string' && event.summary.trim() !== ''
          && Number.isSafeInteger(event.createdAt) && event.createdAt > 0)
        .map((event) => ({
          id: typeof event.id === 'string' ? event.id : eventIdOf(event.summary),
          summary: sanitizeFactText(event.summary),
          when: typeof event.when === 'string' ? sanitizeFactText(event.when) : '',
          importance: Math.min(5, Math.max(1, Math.round(Number.isFinite(event.importance) ? event.importance : 3))),
          createdAt: event.createdAt,
        }))
        .filter((event) => event.summary !== '')
        .slice(-this.options.chatEventMaxEvents)
    } catch (error) {
      this.ctx.logger.warn('deskpet events is not valid JSON: %s', error?.message ?? String(error))
      this.events = []
      await this.quarantineFile(this.eventPath)
    }
    this.ctx.logger.info('deskpet events loaded: %d', this.events.length)
  }

  eventContent() {
    return JSON.stringify({
      version: EVENT_VERSION,
      updatedAt: new Date().toISOString(),
      events: this.events,
    }, null, 2)
  }

  persistEventsSync() {
    this.persistFileSync(this.eventPath, this.eventContent(), 'events')
  }

  async updateEvents() {
    if (this.disposed || !this.options.chatEventsEnabled) return
    const selection = this.modelSelection()
    const llm = this.service('llm')
    if (selection === null || typeof llm?.stream !== 'function') return
    const transcript = this.entries
      .slice(-this.options.chatMemoryTranscriptMessages)
      .map((entry) => `${entry.role === 'user' ? '用户' : '桌宠'}：${entry.text}`)
      .join('\n')
    if (transcript === '') return
    const abort = new AbortController()
    this.eventAbort = abort
    const assembler = createTextAssembler()
    try {
      const request = {
        provider: selection.provider,
        model: selection.model,
        messages: [textMessage('user', `最近对话：\n${transcript}`)],
        system: eventExtractionPrompt(this.events, this.options.chatEventMaxEvents),
        maxTokens: 512,
        signal: abort.signal,
      }
      for await (const chunk of llm.stream(request)) {
        abort.signal.throwIfAborted()
        assembler.push(chunk)
      }
      abort.signal.throwIfAborted()
      if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
        throw new Error('事件整理未正常完成')
      }
      const events = parseEvents(assembler.text(), this.options.chatEventMaxEvents, this.now())
      if (events === null) throw new Error('事件整理结果不是合法 JSON 数组')
      this.events = events
      this.eventTurns = 0
      this.persistEventsSync()
      this.ctx.logger.info('deskpet events updated: %d', this.events.length)
    } catch (error) {
      this.eventTurns = 0
      this.ctx.logger.warn('deskpet events update failed: %s', error?.message ?? String(error))
    } finally {
      if (this.eventAbort === abort) this.eventAbort = null
    }
  }

  /** 按与当前输入的相关度挑选事件（关键词二元组 + 重要度 + 新近度）。 */
  recallEvents(text) {
    if (!this.options.chatEventsEnabled || this.events.length === 0) return []
    const query = bigramSet(text)
    if (query.size === 0) return []
    const now = this.now()
    const scored = []
    for (const event of this.events) {
      const target = bigramSet(event.summary)
      let score = 0
      for (const gram of query) {
        if (target.has(gram)) score += 1
      }
      if (score < 2) continue
      if (event.importance >= 4) score += 0.5
      if (now - event.createdAt <= 7 * 86_400_000) score += 0.5
      scored.push({ event, score })
    }
    scored.sort((left, right) => right.score - left.score
      || right.event.importance - left.event.importance
      || right.event.createdAt - left.event.createdAt)
    return scored.slice(0, EVENT_RECALL_LIMIT).map((item) => item.event)
  }

  companionDays() {
    if (this.companion.firstSeenAt <= 0) return 0
    return Math.max(0, Math.floor((this.now() - this.companion.firstSeenAt) / 86_400_000))
  }

  /** 低打扰主动关心：深夜轻声提醒、白天很久没说话时问候；每天最多一次。 */
  tickProactive() {
    if (this.disposed || !this.options.chatProactiveEnabled || !this.companionLoaded) return null
    const now = this.now()
    const date = new Date(now)
    const dayKey = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    if (this.companion.lastProactiveDay === dayKey) return null
    const hour = date.getHours()
    const silentFor = this.companion.lastInteractAt > 0
      ? now - this.companion.lastInteractAt
      : Number.POSITIVE_INFINITY
    let kind = null
    let text = null
    if (hour >= 22 && silentFor <= 6 * 3_600_000) {
      kind = 'night'
      text = '夜深了，我把灯光调暗了一点。早点休息，我在这儿。'
    } else if (hour >= 10 && hour <= 21 && silentFor >= 4 * 3_600_000) {
      kind = 'silence'
      text = '好久没听到你的声音了。想聊的时候，我一直在。'
    }
    if (kind === null) return null
    this.companion.lastProactiveAt = now
    this.companion.lastProactiveDay = dayKey
    this.persistCompanionSync()
    this.write({ type: 'chat/proactive', kind, text })
    this.ctx.logger.info('deskpet proactive care: %s', kind)
    return { kind, text }
  }

  startProactiveTicker() {
    if (this.proactiveHandle !== null || this.disposed || !this.options.chatProactiveEnabled) return
    const tick = () => {
      try {
        this.tickProactive()
      } catch (error) {
        this.ctx.logger.warn('deskpet proactive tick failed: %s', error?.message ?? String(error))
      }
    }
    tick()
    this.proactiveHandle = setInterval(tick, 60_000)
    this.proactiveHandle.unref?.()
  }

  stopProactiveTicker() {
    if (this.proactiveHandle === null) return
    clearInterval(this.proactiveHandle)
    this.proactiveHandle = null
  }

  // ---------------------------------------------------------------- 对话

  dispose() {
    this.disposed = true
    this.stopTimerTicker()
    this.stopProactiveTicker()
    this.memoryAbort?.abort(new Error('deskpet chat disposed'))
    this.eventAbort?.abort(new Error('deskpet chat disposed'))
    // 只在确实加载过、且本轮之后没有写成功时才落盘：
    // 插件在启动握手/加载阶段被停用时，不能用空内存覆盖用户已有文件；
    // 没有新变化时也不重写，避免无意义的时间戳变动。
    if (this.loaded && this.historyDirty) this.persistHistorySync()
    if (this.options.chatMemoryEnabled && this.memoryLoaded && this.memoryDirty) {
      this.persistMemorySync()
    }
    if (this.pending !== null) {
      clearTimeout(this.pending.timer)
      this.pending.abort.abort(new Error('deskpet chat disposed'))
      this.pending = null
    }
  }

  write(message) {
    try {
      this.bridge.writeMessage(message)
    } catch (error) {
      this.ctx.logger.warn('deskpet could not write %s: %s', message.type, error.message)
    }
  }

  fail(chatId, message) {
    this.write({ type: 'chat/error', id: chatId, message })
  }

  service(name) {
    if (typeof this.ctx.get === 'function') {
      try {
        const service = this.ctx.get(name)
        if (service !== undefined && service !== null) return service
      } catch {
        // 回退到属性访问
      }
    }
    try {
      return this.ctx[name]
    } catch {
      return undefined
    }
  }

  modelSelection() {
    if (this.options.chatProvider !== undefined && this.options.chatModel !== undefined) {
      return { provider: this.options.chatProvider, model: this.options.chatModel }
    }
    const configured = this.service('agentDefaultModel')?.currentSelection?.()
    if (configured !== undefined
      && typeof configured.provider === 'string' && configured.provider !== ''
      && typeof configured.model === 'string' && configured.model !== '') {
      return { provider: configured.provider, model: configured.model }
    }
    return null
  }

  async streamReply(selection, signal) {
    const llm = this.service('llm')
    if (typeof llm?.stream !== 'function') {
      throw new Error('DSH 没有可用的模型服务（llm）')
    }
    const assembler = createTextAssembler()
    const request = {
      provider: selection.provider,
      model: selection.model,
      messages: this.historyMessages(selection),
      system: this.composeSystemPrompt(),
      maxTokens: this.options.chatMaxTokens,
      signal,
    }
    for await (const chunk of llm.stream(request)) {
      signal.throwIfAborted()
      assembler.push(chunk)
    }
    signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = finish.failure ?? {}
      const error = new Error(failure.message ?? '模型调用失败')
      if (typeof failure.code === 'string') error.code = failure.code
      throw error
    }
    return { text: assembler.text().trim(), finish: finish.kind }
  }

  async handleChat(message) {
    const chatId = message?.id
    if (this.disposed) {
      this.fail(chatId, '桌宠桥接已停止')
      return
    }
    if (this.pending !== null) {
      this.fail(chatId, '上一条消息还在等待回复，请稍候')
      return
    }
    const text = typeof message?.text === 'string' ? message.text.trim() : ''
    if (text === '') {
      this.fail(chatId, '消息不能为空')
      return
    }
    if (this.options.chatTimerEnabled) {
      const command = this.parseTimerCommand(text)
      if (command !== null) {
        await this.loadTimers()
        const reply = this.executeTimerCommand(command)
        this.write({ type: 'chat/accepted', id: chatId })
        this.write({ type: 'chat/reply', id: chatId, text: reply, reason: 'completed' })
        return
      }
    }
    if (!this.companionLoaded) await this.loadCompanion()
    if (this.companion.firstSeenAt === 0) {
      this.companion.firstSeenAt = this.now()
      this.persistCompanionSync()
    }
    if (!this.eventLoaded) await this.loadEvents()
    this.recalledEvents = this.recallEvents(text)
    this.updateEmotion(text)
    this.moodHint = detectMoodHint(text)
    const selection = this.modelSelection()
    if (selection === null) {
      this.fail(chatId, '无法确定 DSH 当前使用的模型：请先在 DSH 里选择模型，或在插件配置里指定 chatProvider/chatModel')
      return
    }
    if (!this.loaded) {
      await this.loadHistory()
      await this.loadMemory()
    }

    const pending = { chatId, abort: new AbortController(), timer: null }
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return
      this.pending = null
      pending.abort.abort(new Error('deskpet chat timeout'))
      this.fail(chatId, `等待模型回复超时（${Math.round(this.options.chatTimeoutMs / 1000)} 秒）`)
    }, this.options.chatTimeoutMs)
    pending.timer.unref?.()
    this.pending = pending

    const userEntry = { role: 'user', text, time: new Date().toISOString() }
    this.entries.push(userEntry)
    this.write({ type: 'chat/accepted', id: chatId })

    try {
      const { text: replyText, finish } = await this.streamReply(selection, pending.abort.signal)
      if (this.pending !== pending) return
      clearTimeout(pending.timer)
      this.pending = null
      this.entries.push({
        role: 'assistant',
        text: replyText,
        time: new Date().toISOString(),
      })
      this.trimEntries()
      this.historyDirty = true
      this.write({
        type: 'chat/reply',
        id: chatId,
        text: replyText,
        reason: finish === 'max-tokens' ? 'truncated' : 'completed',
      })
      void this.persistHistory()
      this.companion.turns += 1
      this.companion.lastInteractAt = this.now()
      this.persistCompanionSync()
      if (this.options.chatEmotionEnabled) {
        const emotion = this.companion.emotion
        this.write({
          type: 'pet.mood',
          valence: Math.round(emotion.valence * 1000) / 1000,
          energy: Math.round(emotion.energy * 1000) / 1000,
          mood: emotion.recent.length > 0 ? emotion.recent[emotion.recent.length - 1].mood : '',
        })
      }
      this.noteSuccessfulTurn()
      this.ctx.logger.info(
        'deskpet chat #%s answered by %s/%s',
        chatId,
        selection.provider,
        selection.model,
      )
    } catch (error) {
      if (this.pending !== pending) return
      clearTimeout(pending.timer)
      this.pending = null
      // 失败的一轮不进入上下文，避免下一条把半截对话带给模型。
      if (this.entries[this.entries.length - 1] === userEntry) this.entries.pop()
      this.fail(chatId, `模型回复失败：${error?.message ?? String(error)}`)
    }
  }
}

/**
 * Project live agent availability onto the pet after the Python handshake.
 */
export class DeskpetAgentState {
  constructor(ctx, bridge, agents) {
    this.bridge = bridge
    this.running = new Set()
    this.agents = new Map()
    this.retired = new WeakSet()
    this.turns = new Map()
    this.result = null
    this.resultAgent = null
    this.nextResultId = 1
    this.active = false
    this.disposed = false
    this.lastMessage = null
    this.disposers = [
      ctx.on('agent/status', payload => this.track(payload)),
      ctx.on('agent/created', ({ agent }) => this.track({ agent, status: agent.status })),
      ctx.on('agent/disposed', ({ agent }) => this.remove(agent)),
      ctx.on('session/event', (session, event) => this.onSessionEvent(session, event)),
    ]
    // Subscribe before taking the snapshot; plugin activation can happen mid-run.
    for (const agent of agents?.list() ?? []) this.track({ agent, status: agent.status })
  }

  clearResult() {
    this.result = null
    this.resultAgent = null
  }

  track({ agent, status } = {}) {
    if (this.disposed || !agent || typeof agent !== 'object' || typeof agent.id !== 'string'
      || this.retired.has(agent) || (status !== 'running' && status !== 'idle')) return
    const previous = this.agents.get(agent.id)
    if (previous && previous !== agent) {
      this.retired.add(previous)
      this.running.delete(previous)
      this.turns.delete(previous)
      if (this.resultAgent === previous) this.clearResult()
    }
    this.agents.set(agent.id, agent)
    if (status === 'running') {
      if (!this.running.has(agent)) this.clearResult()
      this.running.add(agent)
    } else {
      this.running.delete(agent)
    }
    this.flush()
  }

  remove(agent) {
    if (this.disposed || !agent || typeof agent !== 'object') return
    this.retired.add(agent)
    this.running.delete(agent)
    this.turns.delete(agent)
    if (this.agents.get(agent.id) === agent) this.agents.delete(agent.id)
    // A completed result may outlive its agent until the UI's display deadline.
    this.flush()
  }

  onSessionEvent(session, event) {
    if (this.disposed || !session || !event
      || (event.type !== 'turn/start' && event.type !== 'turn/end')) return
    const agent = this.agents.get(session.id)
    // Session identity also matters when an id has been reused after replacement.
    if (!agent || agent.session !== session) return
    const turn = event.data?.turn
    if (!Number.isSafeInteger(turn) || turn < 1) return
    const previous = this.turns.get(agent)
    if (event.type === 'turn/start') {
      if (previous && turn <= previous.turn) return
      this.turns.set(agent, { turn, ended: false })
      this.clearResult()
      this.flush()
      return
    }
    if (previous && (turn !== previous.turn || previous.ended)) return
    // A plugin loaded mid-turn has not observed its start. Accept the live end
    // only for the exact running agent/session; never replay an idle history.
    if (!previous && !this.running.has(agent)) return
    this.turns.set(agent, { turn, ended: true })
    const states = new Map([['completed', 'done'], ['error', 'error'], ['aborted', 'aborted']])
    this.result = { id: this.nextResultId++, state: states.get(event.data.reason?.kind) ?? 'ended' }
    this.resultAgent = agent
    this.flush()
  }

  activate() {
    if (this.disposed) return
    this.active = true
    this.flush()
  }

  flush() {
    if (!this.active || this.bridge.stopping || this.bridge.exited) return
    if (this.bridge.child && !this.bridge.child.stdin?.writable) return
    const state = this.running.size > 0 ? 'thinking' : 'idle'
    const message = { type: 'pet.state', state, ...(this.result ? { result: this.result } : {}) }
    const key = JSON.stringify(message)
    if (key === this.lastMessage) return
    this.bridge.writeMessage(message)
    this.lastMessage = key
  }

  dispose() {
    this.disposed = true
    this.active = false
    for (const dispose of this.disposers.splice(0)) dispose()
    this.running.clear()
    this.agents.clear()
    this.turns.clear()
    this.clearResult()
  }
}

// Register cleanup synchronously so unloading cannot race the startup handshake.
export async function apply(ctx, config) {
  const options = normalizeConfig(config)
  let chat = null
  const bridge = new DeskpetBridge(ctx, options, {
    onChat: (message) => {
      chat?.handleChat(message).catch((error) => {
        ctx.logger.warn('deskpet chat handling failed: %s', error?.message ?? String(error))
      })
    },
    onMemoryList: (message) => {
      chat?.sendMemoryDetails(message.id)
    },
    onMemoryDelete: (message) => {
      chat?.deleteMemory(message.factId, message.revision, message.id).catch((error) => {
        ctx.logger.warn('deskpet memory deletion failed: %s', error?.message ?? String(error))
        chat?.memoryError(message.id, '记忆操作失败，请刷新后重试')
      })
    },
  })
  chat = new DeskpetChat(ctx, bridge, options)
  const agentState = new DeskpetAgentState(ctx, bridge, chat.service('agents'))
  ctx.effect(() => {
    bridge.start()
    return () => {
      agentState.dispose()
      chat.dispose()
      return bridge.stop()
    }
  }, 'deskpet python bridge')

  try {
    await bridge.ready()
    agentState.activate()
  } catch (error) {
    agentState.dispose()
    await bridge.stop()
    throw new Error(`deskpet startup failed: ${error.message}. 请运行插件 scripts/setup.ps1 安装独立 Python 环境，或在插件设置中指定已安装 PySide6 的 Python；详细原因见 [python] 日志。`, { cause: error })
  }

  // 恢复跨重启的聊天记忆：先读落盘历史与长期记忆，再让 Python 对话框渲染。
  await chat.loadHistory()
  await chat.loadMemory()
  chat.sendMemoryToPet()
  chat.sendHistoryToPet()
  // 恢复计时/提醒并启动 1 秒一次的 ticker（过期计时会补触发一次）。
  await chat.loadTimers()
  chat.startTimerTicker()
  // 恢复陪伴关系数据并启动低打扰主动关心（每分钟检查一次）。
  await chat.loadCompanion()
  chat.startProactiveTicker()
  // 恢复事件记忆（具体发生过的事）。
  await chat.loadEvents()
}
