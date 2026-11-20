import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

/** Host-owned DSH sessions. No filesystem access, credentials or second Harness. */
export class DshSessions {
  constructor({service, write}) {
    Object.assign(this, {service, write})
    this.selected = null
    this.known = new Map()
    this.epoch = 0
    this.disposed = false
    this.refreshTimer = null
    this.refreshGeneration = 0
    this.reads = new Set()
  }

  controller() {
    const controller = this.service('sessionController')
    if (!controller || typeof controller.list !== 'function' || typeof controller.prompt !== 'function') {
      throw new Error('当前 DSH 的会话接口尚不可用；桌宠独立聊天仍可使用')
    }
    return controller
  }

  async call(action) {
    if (this.disposed) throw new Error('会话连接已关闭')
    const abort = new AbortController()
    this.reads.add(abort)
    let timer
    try {
      return await Promise.race([
        Promise.resolve().then(() => action(abort.signal)),
        new Promise((_, reject) => {
          abort.signal.addEventListener('abort', () => reject(new Error('会话请求已取消或超时，请刷新确认结果')), {once: true})
          timer = setTimeout(() => abort.abort(), 15_000)
        }),
      ])
    } finally { clearTimeout(timer); this.reads.delete(abort) }
  }

  workspaces() {
    return (this.service('workspaceRegistry')?.list?.() || []).map(w => ({id: w.id, title: w.title || basename(w.path || '') || w.id, path: w.path || ''}))
  }

  async list() {
    const value = await this.call(signal => this.controller().list({}, signal))
    if (!Array.isArray(value?.items)) throw new Error('DSH 会话列表格式不兼容')
    const registry = this.service('workspaceRegistry')
    const archived = new Set(registry?.archivedSessionIds || [])
    const rows = value.items.filter(row => typeof row.sessionId === 'string' && !row.parentSessionId && row.origin !== 'subagent' && !archived.has(row.sessionId))
    this.known = new Map(rows.map(row => [row.sessionId, row]))
    const memberships = new Map()
    for (const workspace of registry?.list?.() || []) for (const id of workspace.sessionIds || []) memberships.set(id, workspace)
    return rows.slice(0, 100).map(row => {
      const workspace = memberships.get(row.sessionId)
      return {id: row.sessionId, title: `${workspace?.title || basename(row.cwd || '') || 'DSH会话'} · ${row.sessionId.slice(0, 8)}`,
        running: row.running === true, cwd: row.cwd || workspace?.path || '', workspaceId: workspace?.id || ''}
    })
  }

  requireKnown(id) {
    if (typeof id !== 'string' || !this.known.has(id)) throw new Error('请从刷新后的 DSH 会话列表中选择目标')
    return id
  }

  async view(id) {
    const controller = this.controller()
    const read = typeof controller.events === 'function' ? controller.events.bind(controller) : controller.page?.bind(controller)
    if (!read || typeof controller.state !== 'function') throw new Error('此 DSH 版本不支持读取会话历史')
    const [page, state] = await Promise.all([
      this.call(signal => read({address: {kind: 'session', sessionId: id}, maxMessages: 100}, signal)),
      this.call(signal => controller.state({sessionId: id}, signal)),
    ])
    if (!Array.isArray(page?.records) || !state) throw new Error('DSH 会话已不存在或无法读取')
    const entries = []
    const edited = page.records.some(r => r.event?.type?.startsWith('feedback/message-'))
    // Deletion/edit projection belongs to DSH; do not reconstruct it from a
    // partial journal page and accidentally reveal superseded messages.
    if (!edited) for (const record of page.records) {
      const event = record.event
      if (!event || (event.surfaceOp && event.surfaceOp !== 'append')) continue
      const data = event.data || {}
      const message = event.type === 'user/message' ? data : event.type === 'assistant/message' ? data.message : null
      const role = event.type === 'user/message' && data.source?.kind === 'user' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null
      if (!role || !Array.isArray(message?.content)) continue
      const text = message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').slice(0, 20_000)
      if (text.trim()) entries.push({role, text, time: Number.isFinite(event.time) ? new Date(event.time).toISOString() : ''})
    }
    return {sessionId: id, entries: entries.slice(-100), running: state.running === true, waiting: Boolean(state.pendingInput?.length), hasMore: page.hasMore === true,
      note: edited ? '本页含编辑/删除记录，请在 DSH 查看完整历史。' : '显示最近公开文字；工具详情和权限确认请在 DSH 查看。'}
  }

  async handle(message) {
    const {id, action} = message
    let managing = false
    try {
      if (this.disposed) return
      if (action === 'detach') { this.detach(); return }
      if (!['prompt', 'cancel'].includes(action)) {
        if (this.managing) throw new Error('上一项会话操作尚未完成，请稍后刷新')
        this.managing = true; managing = true
      }
      if (action === 'prompt') {
        const sessionId = this.requireKnown(message.sessionId)
        const text = typeof message.text === 'string' ? message.text.trim() : ''
        if (!text || text.length > 32_000) throw new Error('消息不能为空，且不得超过 32000 字符')
        const body = {requestId: randomUUID(), sessionId, mode: 'queue', content: [{type: 'text', text}], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}
        if (typeof this.controller().prompt !== 'function') throw new Error('此 DSH 版本暂不支持从插件发送会话消息')
        await this.call(signal => this.controller().prompt(body, signal))
        if (!this.disposed) this.write({type: 'dsh/accepted', id, sessionId})
        this.schedule(sessionId)
        return
      }
      if (action === 'cancel') {
        const sessionId = this.requireKnown(message.sessionId)
        await this.call(() => this.controller().cancel({sessionId}))
        if (!this.disposed) this.write({type: 'dsh/progress', sessionId, text: '已请求停止当前轮；已排队输入仍由 DSH 管理。'})
        this.schedule(sessionId)
        return
      }
      const epoch = this.epoch
      let nextSelected = this.selected, replaceHistory = false
      if (action === 'new') {
        const workspace = this.workspaces().find(w => w.id === message.workspaceId)
        if (!workspace) throw new Error('请先选择 DSH 工作区；没有工作区时请先在 DSH 创建')
        const value = await this.call(() => this.controller().create({workspaceId: workspace.id}))
        if (typeof value?.sessionId !== 'string') throw new Error('DSH 未返回会话标识，请刷新确认')
        const selection = this.service('agentDefaultModel')?.currentSelection?.()
        if (selection?.provider && selection?.model && typeof this.controller().selectModel === 'function') {
          await this.call(() => this.controller().selectModel({sessionId: value.sessionId, provider: selection.provider, model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : {reasoningEffort: selection.reasoningEffort})}))
        }
        this.known.set(value.sessionId, {sessionId: value.sessionId, running: false})
        nextSelected = value.sessionId; replaceHistory = true
      } else if (action === 'select') {
        nextSelected = this.requireKnown(message.sessionId); replaceHistory = true
      } else if (action === 'archive') {
        const sessionId = this.requireKnown(message.sessionId)
        const workspaces = this.service('workspaceController')
        if (typeof workspaces?.archiveSession !== 'function') throw new Error('此 DSH 版本不支持归档')
        await this.call(() => workspaces.archiveSession({sessionId, stopActivity: false}))
        if (this.selected === sessionId) { nextSelected = null; replaceHistory = true }
      } else if (action === 'delete') throw new Error('DSH 不提供删除会话接口。可归档隐藏会话，但原始历史仍由 DSH 保管。')
      else if (action !== 'list') throw new Error('DSH 不支持该操作；归档不是删除原始记录')
      const sessions = await this.list()
      const view = replaceHistory && nextSelected ? await this.view(nextSelected) : undefined
      if (this.disposed || epoch !== this.epoch) return
      if (replaceHistory) { this.selected = nextSelected; this.epoch += 1; clearTimeout(this.refreshTimer) }
      this.write({type: 'dsh/sessions', id, sessions, workspaces: this.workspaces(), selectedId: nextSelected, replaceHistory, view})
      if (replaceHistory && nextSelected) this.schedule(nextSelected)
    } catch (error) {
      if (!this.disposed) this.write({type: 'dsh/error', id, action, sessionId: message.sessionId, message: String(error?.message || 'DSH 请求失败').slice(0, 400)})
    } finally { if (managing) this.managing = false }
  }

  observe(session, event) {
    if (this.disposed || session?.id !== this.selected) return
    if (event.type === 'tool/call') this.write({type: 'dsh/progress', sessionId: session.id, text: `正在调用：${String(event.data?.name || '工具').slice(0, 80)}`})
    if (event.type === 'approval/asked') this.write({type: 'dsh/progress', sessionId: session.id, text: '等待权限确认，请在 DSH 主窗口处理。'})
    if (['turn/start', 'turn/end', 'user/message', 'assistant/message', 'approval/asked', 'approval/decided'].includes(event.type)) this.schedule(session.id)
  }

  schedule(id) {
    if (this.disposed || this.selected !== id) return
    clearTimeout(this.refreshTimer)
    const epoch = this.epoch
    const generation = ++this.refreshGeneration
    this.refreshTimer = setTimeout(async () => {
      try {
        const view = await this.view(id)
        if (!this.disposed && this.selected === id && this.epoch === epoch && this.refreshGeneration === generation) this.write({type: 'dsh/view', ...view})
      } catch (error) {
        if (!this.disposed && this.epoch === epoch && this.refreshGeneration === generation) this.write({type: 'dsh/progress', sessionId: id, text: '读取任务状态失败，请刷新或到 DSH 查看。'})
      }
    }, 120)
    this.refreshTimer.unref?.()
  }

  detach() { this.selected = null; this.epoch += 1; this.refreshGeneration += 1; clearTimeout(this.refreshTimer) }
  dispose() { this.disposed = true; this.detach(); for (const abort of this.reads) abort.abort(); this.reads.clear() }
}
