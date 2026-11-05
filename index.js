/**
 * Minimal Host-side bridge for a Python desktop-pet process.
 *
 * The plugin owns one child process and exchanges newline-delimited JSON over
 * its stdin/stdout. Python diagnostics must go to stderr; stdout is reserved
 * for protocol messages so a stray print cannot corrupt the stream.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(PLUGIN_DIR, 'python', 'deskpet_bridge.py')
const PYTHON_PATH_ENV = 'DSHPET_PYTHON'
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

function positiveInteger(value, fallback, field, min = 1) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`deskpet config: ${field} must be a finite number >= ${min}`)
  }
  return Math.floor(value)
}

function normalizeConfig(raw) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('deskpet config: expected an object')
  }

  const pythonPath = config.pythonPath ?? process.env[PYTHON_PATH_ENV] ?? 'python'
  if (typeof pythonPath !== 'string' || pythonPath.trim() === '') {
    throw new TypeError('deskpet config: pythonPath must be a non-empty string')
  }

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

/** 长期记忆整理器的系统提示：把聊天提炼成“用户画像”。 */
function memoryExtractionPrompt(existingFacts, maxFacts) {
  const existing = existingFacts.length === 0
    ? '（暂无）'
    : existingFacts.map((fact) => `- [${fact.kind}] ${fact.text}`).join('\n')
  return [
    '你是桌宠的长期记忆整理器：从用户的聊天里提炼值得长期记住的信息，形成一份稳定的“用户画像”。',
    '规则：',
    '1. 只保留对长期陪伴有价值的信息：用户称呼、偏好、习惯、目标、重要事实、忌讳、情绪倾向。',
    '2. 合并重复或相近的条目；新信息覆盖旧信息；不确定的不要写；不要编造。',
    `3. 每条不超过 40 个字；总数不超过 ${maxFacts} 条；按重要性排序。`,
    '4. 只输出一个 JSON 数组，元素形如 {"kind":"preference","text":"..."}；',
    '   kind 只能是 preference / habit / goal / fact / relation。',
    '5. 不要输出任何其他文字、解释或代码块标记。',
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
    const value = typeof item.text === 'string' ? item.text.trim() : ''
    if (value === '' || value.length > 80) continue
    if (seen.has(value)) continue
    seen.add(value)
    const kind = MEMORY_KINDS.has(item.kind) ? item.kind : 'fact'
    facts.push({ kind, text: value })
    if (facts.length >= maxFacts) break
  }
  return facts
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
    this.loaded = false
    this.memoryLoaded = false
    this.historyDirty = false
    this.memoryDirty = false
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
    this.memoryLoaded = true
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
      const facts = Array.isArray(parsed?.facts) ? parsed.facts : []
      this.memoryFacts = facts
        .filter((fact) => fact !== null && typeof fact === 'object'
          && typeof fact.text === 'string' && fact.text.trim() !== '')
        .map((fact) => ({
          kind: MEMORY_KINDS.has(fact.kind) ? fact.kind : 'fact',
          text: fact.text.trim(),
        }))
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

  memoryContent() {
    return JSON.stringify({
      version: MEMORY_VERSION,
      updatedAt: new Date().toISOString(),
      facts: this.memoryFacts,
    }, null, 2)
  }

  async persistMemory() {
    const saved = await this.persistFile(this.memoryPath, this.memoryContent(), 'memory')
    if (saved) this.memoryDirty = false
    return saved
  }

  persistMemorySync() {
    const saved = this.persistFileSync(this.memoryPath, this.memoryContent(), 'memory')
    if (saved) this.memoryDirty = false
    return saved
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
    const transcript = this.entries
      .slice(-this.options.chatMemoryTranscriptMessages)
      .map((entry) => `${entry.role === 'user' ? '用户' : '桌宠'}：${entry.text}`)
      .join('\n')
    if (transcript === '') return

    const abort = new AbortController()
    this.memoryAbort = abort
    const assembler = createTextAssembler()
    try {
      const request = {
        provider: selection.provider,
        model: selection.model,
        messages: [textMessage('user', `最近对话：\n${transcript}`)],
        system: memoryExtractionPrompt(this.memoryFacts, this.options.chatMemoryMaxFacts),
        maxTokens: 512,
        signal: abort.signal,
      }
      for await (const chunk of llm.stream(request)) {
        abort.signal.throwIfAborted()
        assembler.push(chunk)
      }
      const facts = parseMemoryFacts(assembler.text(), this.options.chatMemoryMaxFacts)
      if (facts === null) throw new Error('记忆整理结果不是合法 JSON 数组')
      this.memoryFacts = facts
      this.memoryDirty = true
      this.memoryTurns = 0
      await this.persistMemory()
      this.sendMemoryToPet()
      this.ctx.logger.info('deskpet memory updated: %d facts', this.memoryFacts.length)
    } catch (error) {
      this.memoryTurns = 0
      this.ctx.logger.warn('deskpet memory update failed: %s', error?.message ?? String(error))
    } finally {
      if (this.memoryAbort === abort) this.memoryAbort = null
    }
  }

  // ---------------------------------------------------------------- 对话

  dispose() {
    this.disposed = true
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
 * Cordis Function plugin. The cleanup is registered synchronously so unloading
 * cannot race the asynchronous startup handshake.
 */
export async function apply(ctx, config) {
  const options = normalizeConfig(config)
  let chat = null
  const bridge = new DeskpetBridge(ctx, options, {
    onChat: (message) => {
      chat?.handleChat(message).catch((error) => {
        ctx.logger.warn('deskpet chat handling failed: %s', error?.message ?? String(error))
      })
    },
  })
  chat = new DeskpetChat(ctx, bridge, options)
  // 记录当前关注的会话和轮次
  let watchedTurn = null;

  // 把 DSH 的结束原因转换成桌宠状态
  const resultStates = new Map([
    ["completed", "done"],
    ["error", "error"],
    ["aborted", "aborted"],
  ]);

  function showPetState(state) {
    if (
      !bridge.child?.stdin.writable ||
      bridge.stopping ||
      bridge.exited
    ) {
      return;
    }

    bridge.writeMessage({ type: "pet.state", state });
  }

  ctx.on("session/event", (session, event) => {
    // 一轮任务开始
    if (event.type === "turn/start") {
      watchedTurn = {
        sessionId: session.id,
        turn: event.data.turn,
      };

      showPetState("thinking");
      return;
    }

    // 只处理当前关注的这一轮结束事件
    if (
      event.type !== "turn/end" ||
      !watchedTurn ||
      session.id !== watchedTurn.sessionId ||
      event.data.turn !== watchedTurn.turn
    ) {
      return;
    }

    const reason = event.data.reason?.kind;
    showPetState(resultStates.get(reason) ?? "ended");
  });
  ctx.effect(() => {
    bridge.start()
    return () => {
      chat.dispose()
      return bridge.stop()
    }
  }, 'deskpet python bridge')

  try {
    await bridge.ready()
  } catch (error) {
    await bridge.stop()
    throw new Error(`deskpet startup failed: ${error.message}`, { cause: error })
  }

  // 恢复跨重启的聊天记忆：先读落盘历史与长期记忆，再让 Python 对话框渲染。
  await chat.loadHistory()
  await chat.loadMemory()
  chat.sendMemoryToPet()
  chat.sendHistoryToPet()
}
