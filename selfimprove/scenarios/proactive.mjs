import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import { normalizeConfig } from '../../index.js'
import { createTimerEnv, readJson } from '../lib/harness.mjs'

const HOUR = 3_600_000

const EMPTY_HOURS = Array.from({ length: 24 }, () => 0)

function seedCompanion(env, data = {}) {
  writeFileSync(env.companionPath, JSON.stringify({
    version: 1,
    firstSeenAt: env.clock.now - 5 * 86_400_000,
    turns: 20,
    lastInteractAt: env.clock.now - HOUR,
    lastProactiveAt: 0,
    lastProactiveDay: '',
    activeHours: EMPTY_HOURS,
    ...data,
  }), 'utf8')
}

function proactiveMessages(env) {
  return env.harness.sent.filter((message) => message.type === 'chat/proactive')
}

export const proactiveScenarios = [
  {
    id: 'proactive-quiet-level-morning-blocked',
    title: 'quiet 档位不主动早安',
    weight: 2,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'quiet' } })
      env.clock.now = new Date(2026, 10, 14, 9, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 10 * HOUR })
      await env.chat.loadCompanion()
      assert.equal(env.chat.tickProactive(), null)
      assert.equal(proactiveMessages(env).length, 0)
    },
  },
  {
    id: 'proactive-balanced-morning',
    title: 'balanced 档位早上轻声问候',
    weight: 2,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'balanced' } })
      env.clock.now = new Date(2026, 10, 14, 9, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 10 * HOUR })
      await env.chat.loadCompanion()
      const message = env.chat.tickProactive()
      assert.ok(message)
      assert.equal(message.kind, 'morning')
      assert.match(message.text, /早/)
      assert.equal(proactiveMessages(env).length, 1)
    },
  },
  {
    id: 'proactive-morning-habit-gate',
    title: '作息偏夜时早安让位',
    weight: 2,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'balanced' } })
      env.clock.now = new Date(2026, 10, 14, 9, 0, 0).getTime()
      const nightHours = [...EMPTY_HOURS]
      nightHours[23] = 8
      seedCompanion(env, { lastInteractAt: env.clock.now - 10 * HOUR, activeHours: nightHours })
      await env.chat.loadCompanion()
      assert.equal(env.chat.tickProactive(), null, '没有早起习惯时不该早安打扰')
    },
  },
  {
    id: 'proactive-early-morning',
    title: '凌晨 0–2 点也温柔提醒',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      env.clock.now = new Date(2026, 10, 15, 1, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 2 * HOUR })
      await env.chat.loadCompanion()
      const message = env.chat.tickProactive()
      assert.ok(message)
      assert.equal(message.kind, 'night')
    },
  },
  {
    id: 'proactive-chatty-noon',
    title: 'chatty 档位午间问候',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'chatty' } })
      env.clock.now = new Date(2026, 10, 14, 12, 30, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 5 * HOUR })
      await env.chat.loadCompanion()
      const message = env.chat.tickProactive()
      assert.ok(message)
      assert.equal(message.kind, 'noon')
    },
  },
  {
    id: 'proactive-daily-once',
    title: '同一天只主动关心一次',
    weight: 2,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'balanced' } })
      env.clock.now = new Date(2026, 10, 14, 9, 0, 0).getTime()
      seedCompanion(env, { lastInteractAt: env.clock.now - 10 * HOUR })
      await env.chat.loadCompanion()
      assert.ok(env.chat.tickProactive())
      env.clock.now = new Date(2026, 10, 14, 23, 0, 0).getTime()
      env.chat.companion.lastInteractAt = env.clock.now - HOUR
      assert.equal(env.chat.tickProactive(), null, '同一天不能再打扰')
      assert.equal(proactiveMessages(env).length, 1)
    },
  },
  {
    id: 'proactive-learns-active-hours',
    title: '学习用户活跃时段',
    weight: 2,
    async run() {
      const env = createTimerEnv({ chat: { chatProactiveLevel: 'balanced' } })
      env.clock.now = new Date(2026, 10, 14, 9, 0, 0).getTime()
      for (let index = 0; index < 3; index += 1) {
        await env.chat.handleChat({ id: index + 1, text: '早上好' })
      }
      const saved = readJson(env.companionPath)
      assert.equal(saved.activeHours[9], 3)
    },
  },
  {
    id: 'proactive-invalid-level',
    title: '非法主动关心档位被拒绝',
    weight: 1,
    async run() {
      assert.throws(() => normalizeConfig({ chatProactiveLevel: 'loud' }))
      assert.equal(normalizeConfig({}).chatProactiveLevel, 'quiet')
    },
  },
]
