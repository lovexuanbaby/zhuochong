/**
 * Minimal Host-side bridge for a Python desktop-pet process.
 *
 * The plugin owns one child process and exchanges newline-delimited JSON over
 * its stdin/stdout. Python diagnostics must go to stderr; stdout is reserved
 * for protocol messages so a stray print cannot corrupt the stream.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(PLUGIN_DIR, 'python', 'deskpet_bridge.py')
const PYTHON_PATH_ENV = 'DSHPET_PYTHON'

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

  return {
    pythonPath: pythonPath.trim(),
    pingIntervalMs: positiveInteger(config.pingIntervalMs, 15_000, 'pingIntervalMs', 1_000),
    pingTimeoutMs: positiveInteger(config.pingTimeoutMs, 5_000, 'pingTimeoutMs', 100),
    handshakeTimeoutMs: positiveInteger(config.handshakeTimeoutMs, 5_000, 'handshakeTimeoutMs', 100),
    shutdownTimeoutMs: positiveInteger(config.shutdownTimeoutMs, 3_000, 'shutdownTimeoutMs', 100),
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
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
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
 * Cordis Function plugin. The cleanup is registered synchronously so unloading
 * cannot race the asynchronous startup handshake.
 */
export async function apply(ctx, config) {
  const options = normalizeConfig(config)
  const bridge = new DeskpetBridge(ctx, options)

  ctx.effect(() => {
    bridge.start()
    return () => bridge.stop()
  }, 'deskpet python bridge')

  try {
    await bridge.ready()
  } catch (error) {
    await bridge.stop()
    throw new Error(`deskpet startup failed: ${error.message}`, { cause: error })
  }
}
