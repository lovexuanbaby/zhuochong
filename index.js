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
  for (const field of ['chatProvider', 'chatModel', 'chatSystemPrompt', 'chatHistoryPath', 'chatMemoryPath', 'chatTimerPath']) {
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
      : '你是 DeepSeek Harness 桌面上的一个圆滚滚的青色小机器人桌宠，是用户的陪伴伙伴。用简洁自然的中文回答用户，语气轻松友好，一般不超过三句话。不要使用 Markdown 标题或表格，不要提及内部实现或协议，也不要说自己是 AI 助手。',
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

  /** 注入到每次回复的系统提示里。 */
  composeSystemPrompt() {
    const base = this.options.chatSystemPrompt
    if (!this.options.chatMemoryEnabled || this.memoryFacts.length === 0) return base
    const lines = this.memoryFacts.map((fact) => `- ${fact.text}`)
    return [
      base,
      '',
      '# 你记得关于用户的事（长期记忆，回答时自然使用，不要逐条复述）',
      ...lines,
    ].join('\n')
  }

  /** 每完成一轮对话计数；达到阈值就异步整理一次长期记忆。 */
  noteSuccessfulTurn() {
    if (!this.options.chatMemoryEnabled || this.disposed) return
    this.memoryTurns += 1
    if (this.memoryTurns < this.options.chatMemoryUpdateEveryTurns) return
    if (this.memoryJob !== null) return
    this.memoryJob = this.updateMemory().finally(() => {
      this.memoryJob = null
    })
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

  parseTimerCommand(text) {
    const value = (text || '').trim()
    if (value === '') return null
    if (/^(?:查看计时|计时列表|提醒列表)$/u.test(value)) return { action: 'list' }
    if (/^取消所有计时$/u.test(value)) return { action: 'cancel-all' }
    let match = value.match(/^取消(?:计时)?\s*#?(\d+)$/u)
    if (match) return { action: 'cancel', id: Number(match[1]) }
    match = value.match(/^(?:倒计时|计时)\s*(\d+)\s*(秒钟|秒|分钟|分|小时|钟头|min|m|s|h)\s*$/iu)
    if (match) {
      const durationMs = durationToMs(match[1], match[2])
      if (durationMs !== null) {
        return { action: 'create', kind: 'countdown', durationMs, label: '' }
      }
    }
    match = value.match(/^(?:提醒我\s*)?(\d+)\s*(秒钟|秒|分钟|分|小时|钟头|min|m|s|h)\s*后\s*(?:提醒我|提醒)?\s*(.*)$/iu)
    if (match) {
      const durationMs = durationToMs(match[1], match[2])
      if (durationMs !== null) {
        return { action: 'create', kind: 'reminder', durationMs, label: (match[3] ?? '').trim() }
      }
    }
    if (TIMER_ACTION_PREFIX.test(value)) return { action: 'invalid' }
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
      return `已取消全部 ${count} 个计时。`
    }
    if (command.action === 'cancel') {
      const target = this.timers.find(timer => timer.id === command.id)
      if (target === undefined) return `没有找到计时 #${command.id}，可用「查看计时」确认。`
      this.timers = this.timers.filter(timer => timer.id !== command.id)
      this.persistTimersSync()
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
    if (due.length === 0) return 0
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
      })
    }
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

  // ---------------------------------------------------------------- 对话

  dispose() {
    this.disposed = true
    this.stopTimerTicker()
    this.memoryAbort?.abort(new Error('deskpet chat disposed'))
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
}
