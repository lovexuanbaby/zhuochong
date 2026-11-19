import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const FEEDBACK = new Set(['shorter', 'longer', 'formal', 'casual', 'reset'])
const clean = (value, limit = 180) => typeof value === 'string'
  ? value.replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{12,}/gu, '[已隐藏凭据]').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit) : ''
const textOf = content => Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => clean(b.text)).join(' ').slice(0, 180) : ''
const statusLabel = value => ({running: '进行中', completed: '已结束', error: '失败', aborted: '中止', other: '其他结束', unknown: '待确认'})[value] || '待确认'
export const localDay = (time = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(time))
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day}`
}
const sessionKey = id => createHash('sha256').update(id).digest('hex').slice(0, 16)
const fresh = () => ({version: 1, tasks: [], reports: {}, style: {brevity: 0, formality: 0, revision: 0, feedback: []}})

/** Three bounded roles: collect observed work, write a recap, learn explicit
 * style feedback. One optional LLM call, no model training or code mutation. */
export class DailyReview {
  constructor({path, write, generate, logger, enabled = true, now = Date.now, timeoutMs = 60_000}) {
    Object.assign(this, {path, write, generate, logger, enabled, now, timeoutMs})
    this.state = fresh()
    this.live = new Map()
    this.pending = null
    this.disposed = false
    if (enabled && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        if (raw.version !== 1 || !Array.isArray(raw.tasks)) throw new Error('invalid daily review data')
        this.state.tasks = raw.tasks.filter(t => typeof t?.sessionId === 'string' && Number.isSafeInteger(t.turn) && t.turn > 0
          && Number.isFinite(t.startedAt) && typeof t.day === 'string').slice(-300).map(t => ({
          ...t, title: clean(t.title), result: clean(t.result), calls: Array.isArray(t.calls) ? t.calls.slice(-100) : [],
          errors: Array.isArray(t.errors) ? t.errors.slice(-100) : [], tools: Array.isArray(t.tools) ? t.tools.map(x => clean(x, 50)).slice(-20) : [],
        }))
        if (raw.reports && typeof raw.reports === 'object' && !Array.isArray(raw.reports)) this.state.reports = raw.reports
        const style = raw.style
        if (style && Number.isSafeInteger(style.revision) && style.revision >= 0) {
          this.state.style = {
            brevity: Number.isInteger(style.brevity) ? Math.max(-2, Math.min(2, style.brevity)) : 0,
            formality: Number.isInteger(style.formality) ? Math.max(-2, Math.min(2, style.formality)) : 0,
            revision: style.revision, feedback: Array.isArray(style.feedback) ? style.feedback.filter(f => FEEDBACK.has(f?.choice) && Number.isSafeInteger(f?.revision)).slice(-20) : [],
          }
        }
        // A restarted plugin cannot assume yesterday's open turns still run.
        for (const task of this.state.tasks) if (task.status === 'running') task.status = 'unknown'
        this.prune()
      } catch {
        try { renameSync(path, `${path}.corrupt-${this.now()}`) } catch {}
        logger?.warn('deskpet daily review data could not be loaded; starting an empty journal')
      }
    }
  }

  prune() {
    const cutoff = this.now() - 30 * 86_400_000
    this.state.tasks = this.state.tasks.filter(t => t.startedAt >= cutoff).slice(-300)
    const dates = Object.keys(this.state.reports).filter(key => /^\d{4}-\d{2}-\d{2}$/u.test(key) && key >= localDay(cutoff)).sort().slice(-30)
    this.state.reports = Object.fromEntries(dates.map(key => [key, this.state.reports[key]]))
  }

  save(next = this.state) {
    try {
      mkdirSync(dirname(this.path), {recursive: true})
      const temp = `${this.path}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
      renameSync(temp, this.path)
      this.state = next
      return true
    } catch {
      this.logger?.warn('deskpet daily review save failed')
      return false
    }
  }

  observe(session, event) {
    if (!this.enabled || this.disposed || typeof session?.id !== 'string' || !event?.data) return
    const type = event.type, data = event.data
    if (!['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(type)) return
    const at = Number.isFinite(event.time) ? event.time : this.now()
    if (at < this.now() - 30 * 86_400_000 || at > this.now() + 60_000) return
    let turn = Number.isSafeInteger(data.turn) && data.turn > 0 ? data.turn : this.live.get(session)
    if (type === 'turn/start' && turn > 0) this.live.set(session, turn)
    if (!(turn > 0)) return
    const key = sessionKey(session.id)
    let task = this.state.tasks.find(t => t.sessionId === key && t.turn === turn)
    if (!task) {
      if (type === 'user/message') return
      task = {sessionId: key, turn, day: localDay(at), startedAt: at, status: 'running', title: '', result: '', calls: [], errors: [], tools: [], subagent: typeof session.header?.parentSession === 'string'}
      this.state.tasks.push(task)
    }
    if (task.status === 'unknown' && type !== 'turn/end') task.status = 'running'
    if (type === 'user/message' && data.source?.kind === 'user' && !task.title) task.title = textOf(data.content)
    if (type === 'assistant/message') {
      const text = textOf(data.message?.content)
      if (text) task.result = text
    }
    if (type === 'tool/call' && typeof data.callId === 'string' && !task.calls.includes(data.callId) && task.calls.length < 100) {
      task.calls.push(data.callId)
      const name = clean(data.name, 50)
      if (name && !task.tools.includes(name) && task.tools.length < 20) task.tools.push(name)
    }
    if (type === 'tool/result' && (data.message?.isError || data.error)) {
      const id = data.message?.toolCallId || data.message?.source?.callId
      if (typeof id === 'string' && !task.errors.includes(id) && task.errors.length < 100) task.errors.push(id)
    }
    if (type === 'turn/end') {
      task.status = ['completed', 'error', 'aborted'].includes(data.reason?.kind) ? data.reason.kind : 'other'
      task.endedAt = at
      if (this.live.get(session) === turn) this.live.delete(session)
    }
    this.prune()
    if (['turn/start', 'turn/end', 'user/message'].includes(type)) this.save()
  }

  stylePrompt(style = this.state.style) {
    if (!this.enabled) return ''
    const length = ['详细列出关键步骤、依据和待办，但不杜撰。', '适度详细，补充必要的步骤和上下文。', '表达简洁完整。', '表达更简短，先给结论，减少铺垫。', '表达更简短，只保留最重要的结论和待办，尽量用一两句话。']
    const tone = ['语气轻松自然，使用亲切口语，避免夸张奉承。', '语气轻松自然，像熟悉的伙伴。', '语气自然、平实。', '语气正式、清晰。', '使用专业书面表达，避免口头语和表情符号。']
    return length[style.brevity + 2] + tone[style.formality + 2]
  }

  snapshot(day = localDay(this.now())) {
    this.prune()
    const tasks = this.state.tasks.filter(t => t.day === day)
    const facts = tasks.map(t => ({title: t.title || `任务 ${t.turn}`, result: t.result, status: t.status, tools: t.tools, toolCalls: t.calls.length, toolErrors: t.errors.length, subagent: t.subagent}))
    const hash = createHash('sha256').update(JSON.stringify(facts)).digest('hex')
    const style = this.state.style
    const cached = this.state.reports[day]
    const useCache = cached?.hash === hash && cached.styleRevision === style.revision && typeof cached.text === 'string'
    const detailed = style.brevity < 0
    const limit = style.brevity === 2 ? 3 : style.brevity === 1 ? 8 : 20
    const lines = [`${day} 工作回顾`, `记录 ${tasks.length} 项任务，${tasks.filter(t => t.status === 'completed').length} 项已结束，${tasks.filter(t => t.status === 'error').length} 项失败，${tasks.filter(t => t.status === 'aborted').length} 项中止。`,
      `涉及 ${new Set(tasks.map(t => t.sessionId)).size} 个会话，${tasks.filter(t => t.subagent).length} 个子 agent 轮次，${facts.reduce((n, t) => n + t.toolCalls, 0)} 次工具调用。`, '',
      ...facts.slice(-limit).map(t => `• ${t.title} — ${statusLabel(t.status)}${detailed && t.result ? `\n  回复摘要：${t.result}` : ''}${detailed && t.tools.length ? `\n  工具：${t.tools.join('、')}` : ''}`),
      ...(tasks.length > limit ? [`另有 ${tasks.length - limit} 项记录，可选择更详细。`] : []),
      ...(tasks.length ? [] : ['今天还没有记录到任务。此功能只记录启用后捕获的 DSH 工作，不扫描旧会话。']),
    ]
    return {day, text: useCache ? cached.text : lines.join('\n'), mode: useCache ? 'model' : 'local', taskCount: tasks.length, hash,
      facts: facts.slice(-50), style: {...style, feedback: style.feedback.slice(-5)}, styleText: this.stylePrompt(),
      dates: [...new Set([localDay(this.now()), ...this.state.tasks.map(t => t.day)])].sort().reverse().slice(0, 30)}
  }

  send(id, day, extra = {}) {
    const {facts, hash, ...snapshot} = this.snapshot(day)
    this.write({type: 'review/result', id, ...snapshot, ...extra})
  }

  async handle(message) {
    const id = message.id
    const day = message.day || localDay(this.now())
    if (!this.enabled || this.disposed) { this.write({type: 'review/error', id, message: '每日回顾未启用'}); return }
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) { this.write({type: 'review/error', id, message: '日期格式无效'}); return }
    if (message.type === 'review/open') { this.send(id, day); return }
    if (message.type === 'review/feedback') {
      if (!FEEDBACK.has(message.feedback) || message.revision !== this.state.style.revision) {
        this.write({type: 'review/error', id, message: '反馈无效或偏好已更新，请刷新后重试'}); return
      }
      const next = structuredClone(this.state), style = next.style
      if (message.feedback === 'reset') { style.brevity = 0; style.formality = 0 }
      if (message.feedback === 'shorter') style.brevity = Math.min(2, style.brevity + 1)
      if (message.feedback === 'longer') style.brevity = Math.max(-2, style.brevity - 1)
      if (message.feedback === 'formal') style.formality = Math.min(2, style.formality + 1)
      if (message.feedback === 'casual') style.formality = Math.max(-2, style.formality - 1)
      style.revision += 1
      style.feedback.push({at: this.now(), choice: message.feedback, revision: style.revision})
      style.feedback = style.feedback.slice(-20)
      if (!this.save(next)) { this.write({type: 'review/error', id, message: '偏好保存失败，未更改原设置'}); return }
      this.send(id, day, {step: '已采纳反馈，下次总结和聊天使用新偏好'})
      return
    }
    if (message.type !== 'review/generate') return
    if (message.styleRevision !== this.state.style.revision) {
      this.write({type: 'review/error', id, message: '表达偏好已变化，请刷新后重新生成'}); return
    }
    if (this.pending) { this.write({type: 'review/error', id, message: '正在生成回顾，请稍后'}); return }
    const snapshot = this.snapshot(day)
    if (!snapshot.taskCount) { this.send(id, day); return }
    const job = {id, abort: new AbortController()}
    this.pending = job
    this.write({type: 'review/progress', id, step: '记录员：收集任务 → 总结员：按偏好生成回顾'})
    try {
      const text = await Promise.race([
        this.generate(snapshot.facts, this.stylePrompt(), job.abort.signal, day),
        new Promise((_, reject) => {
          job.cancel = () => reject(new Error('每日回顾已停止'))
          job.timer = setTimeout(() => { job.abort.abort(); reject(new Error('回顾生成超时，请重试')) }, this.timeoutMs)
        }),
      ])
      if (this.disposed || this.pending !== job) return
      if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有返回回顾内容')
      if (this.state.style.revision !== snapshot.style.revision || this.snapshot(day).hash !== snapshot.hash) throw new Error('任务或偏好已变化，请刷新后重新生成')
      this.write({type: 'review/progress', id, step: '检查员：检查输出与数据版本 → 保存回顾'})
      const next = structuredClone(this.state)
      next.reports[day] = {text: text.trim().slice(0, 6000), hash: snapshot.hash, styleRevision: snapshot.style.revision, at: this.now()}
      if (!this.save(next)) throw new Error('回顾保存失败，本地任务记录仍保留')
      this.send(id, day, {step: '回顾已保存；反馈 → 偏好更新 → 下次应用'})
    } catch (error) {
      if (!this.disposed) this.write({type: 'review/error', id, message: clean(error?.message || '回顾生成失败')})
    } finally {
      clearTimeout(job.timer)
      if (this.pending === job) this.pending = null
    }
  }

  cancel(id) {
    const job = this.pending
    if (!job || (id !== undefined && id !== job.id)) return
    this.pending = null
    job.abort.abort()
    clearTimeout(job.timer)
    job.cancel?.()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    if (this.enabled && (this.state.tasks.length || this.state.style.revision)) { this.prune(); this.save() }
    this.live.clear()
  }
}
