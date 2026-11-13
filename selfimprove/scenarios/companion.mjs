import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

import { normalizeConfig } from '../../index.js'
import {
  createTimerEnv,
  readJson,
} from '../lib/harness.mjs'

const DAY = 86_400_000
const HOUR = 3_600_000

function replyRequests(env) {
  return env.harness.requests.filter((request) => !request.system.includes('长期记忆整理器'))
}

function lastReplyRequest(env) {
  return replyRequests(env).pop()
}

function seedCompanion(env, data = {}) {
  writeFileSync(env.companionPath, JSON.stringify({
    version: 1,
    firstSeenAt: 0,
    turns: 0,
    lastInteractAt: 0,
    lastProactiveAt: 0,
    lastProactiveDay: '',
    ...data,
  }), 'utf8')
}

function proactiveMessages(env) {
  return env.harness.sent.filter((message) => message.type === 'chat/proactive')
}

export const companionScenarios = [
  {
    id: 'companion-persona-default',
    title: '默认人格是安静温柔型',
    weight: 2,
    async run() {
      const persona = normalizeConfig({}).chatSystemPrompt
      assert.match(persona, /安静/)
      assert.match(persona, /温柔/)
      const env = createTimerEnv({ chat: { chatSystemPrompt: persona } })
      await env.chat.handleChat({ id: 1, text: '你好' })
      const request = lastReplyRequest(env)
      assert.equal(request.system, persona, '无记忆/关系/情绪时应只有人格提示')
      assert.match(request.system, /少用感叹号/)
    },
  },
  {
    id: 'companion-persona-custom',
    title: '自定义人格覆盖默认设定',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatSystemPrompt: '你是一只毒舌猫娘' } })
      await env.chat.handleChat({ id: 1, text: '你好' })
      assert.equal(lastReplyRequest(env).system, '你是一只毒舌猫娘')
    },
  },
  {
    id: 'companion-relationship-context',
    title: '关系感注入（认识天数/聊天轮数）',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      seedCompanion(env, {
        firstSeenAt: env.clock.now - 3 * DAY,
        turns: 42,
        lastInteractAt: env.clock.now - 1_000,
      })
      await env.chat.handleChat({ id: 1, text: '你好' })
      const system = lastReplyRequest(env).system
      assert.match(system, /3 天/)
      assert.match(system, /42 轮/)
    },
  },
  {
    id: 'companion-relationship-persist',
    title: '关系数据随对话落盘并可重启恢复',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '第一句' })
      await env.chat.handleChat({ id: 2, text: '第二句' })
      const saved = readJson(env.companionPath)
      assert.equal(saved.turns, 2)
      assert.ok(saved.firstSeenAt > 0)
      assert.ok(saved.lastInteractAt >= saved.firstSeenAt)
    },
  },
  {
    id: 'companion-mood-tired',
    title: '识别疲惫情绪并注入回应提示',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '今天加班好累啊' })
      const system = lastReplyRequest(env).system
      assert.match(system, /当前情绪/)
      assert.match(system, /累|疲惫/)
    },
  },
  {
    id: 'companion-mood-none',
    title: '普通聊天不注入情绪提示',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '今天天气不错' })
      assert.ok(!lastReplyRequest(env).system.includes('当前情绪'))
    },
  },
  {
    id: 'companion-proactive-night',
    title: '深夜只轻声提醒一次',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      env.clock.now = new Date(2026, 10, 14, 23, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - HOUR })
      await env.chat.loadCompanion()
      const first = env.chat.tickProactive()
      assert.ok(first)
      assert.equal(first.kind, 'night')
      assert.match(first.text, /夜/)
      assert.equal(proactiveMessages(env).length, 1)
      assert.equal(env.chat.tickProactive(), null, '同一天不能重复打扰')
      assert.equal(proactiveMessages(env).length, 1)
      const saved = readJson(env.companionPath)
      assert.ok(saved.lastProactiveDay)
    },
  },
  {
    id: 'companion-proactive-silence',
    title: '白天很久没说话时轻轻问候',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      env.clock.now = new Date(2026, 10, 14, 15, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 5 * HOUR })
      await env.chat.loadCompanion()
      const message = env.chat.tickProactive()
      assert.ok(message)
      assert.equal(message.kind, 'silence')
      assert.match(message.text, /好久|一直在/)
    },
  },
  {
    id: 'companion-proactive-avoid-annoying',
    title: '用户刚聊过/非深夜时不主动打扰',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      env.clock.now = new Date(2026, 10, 14, 15, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - HOUR })
      await env.chat.loadCompanion()
      assert.equal(env.chat.tickProactive(), null)
      assert.equal(proactiveMessages(env).length, 0)
    },
  },
  {
    id: 'companion-proactive-disabled',
    title: '关闭主动关心后不再打扰',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveEnabled: false } })
      env.clock.now = new Date(2026, 10, 14, 23, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - HOUR })
      await env.chat.loadCompanion()
      assert.equal(env.chat.tickProactive(), null)
      assert.equal(proactiveMessages(env).length, 0)
    },
  },
  {
    id: 'companion-corrupt-quarantine',
    title: '损坏的关系数据被隔离',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      writeFileSync(env.companionPath, '{不是 JSON', 'utf8')
      await env.chat.loadCompanion()
      assert.equal(env.chat.companion.turns, 0)
      assert.ok(readdirSync(env.dir).some((name) => name.includes('.corrupt-')), '损坏文件应改名保留')
      await env.chat.handleChat({ id: 1, text: '还能聊吗' })
      assert.ok(readJson(env.companionPath).firstSeenAt > 0)
    },
  },
]
