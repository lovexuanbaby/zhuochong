import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

import { createTimerEnv, readJson } from '../lib/harness.mjs'

const HOUR = 3_600_000

function seedCompanion(env, data = {}) {
  writeFileSync(env.companionPath, JSON.stringify({
    version: 1,
    firstSeenAt: env.clock.now - 2 * 86_400_000,
    turns: 3,
    lastInteractAt: env.clock.now - HOUR,
    lastProactiveAt: 0,
    lastProactiveDay: '',
    ...data,
  }), 'utf8')
}

function lastReplyRequest(env) {
  return env.harness.requests.filter(
    (request) => !request.system.includes('长期记忆整理器'),
  ).pop()
}

function moodMessages(env) {
  return env.harness.sent.filter((message) => message.type === 'pet.mood')
}

export const emotionScenarios = [
  {
    id: 'emotion-init-state',
    title: '首次对话建立情绪状态',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '你好呀' })
      const saved = readJson(env.companionPath)
      assert.ok(saved.emotion, 'companion.json 应包含 emotion')
      assert.equal(typeof saved.emotion.valence, 'number')
      assert.equal(typeof saved.emotion.energy, 'number')
      assert.ok(saved.emotion.updatedAt > 0)
      assert.ok(moodMessages(env).length >= 1, '应推送 pet.mood 状态')
    },
  },
  {
    id: 'emotion-tired-lowers',
    title: '疲惫会拉低心情与精力',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '今天好累，加班到很晚' })
      const emotion = readJson(env.companionPath).emotion
      assert.ok(emotion.valence < 0, '心情应变负')
      assert.ok(emotion.energy < 0.5, '精力应下降')
      assert.ok(emotion.recent.some((item) => item.mood === 'tired'))
    },
  },
  {
    id: 'emotion-happy-raises',
    title: '开心会提升心情',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '今天好开心，事情都顺利' })
      const emotion = readJson(env.companionPath).emotion
      assert.ok(emotion.valence > 0, '心情应变正')
      assert.ok(emotion.recent.some((item) => item.mood === 'happy'))
    },
  },
  {
    id: 'emotion-negation',
    title: '否定句不误判情绪',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '我不累，也没加班' })
      const system = lastReplyRequest(env).system
      assert.ok(!system.includes('当前情绪'), '否定句不应注入情绪提示')
      const emotion = readJson(env.companionPath).emotion
      assert.ok(Math.abs(emotion.valence) <= 0.05, '心情不应被拉低')
    },
  },
  {
    id: 'emotion-decay',
    title: '情绪随时间自然衰减',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      seedCompanion(env, {
        emotion: { valence: -0.6, energy: 0.1, updatedAt: env.clock.now - 10 * HOUR, recent: [] },
      })
      await env.chat.loadCompanion()
      const valence = env.chat.companion.emotion.valence
      assert.ok(valence > -0.6, '10 小时后负向情绪应衰减')
      assert.ok(valence < 0)
      const energy = env.chat.companion.emotion.energy
      assert.ok(energy > 0.1, '精力应回升')
    },
  },
  {
    id: 'emotion-state-in-prompt',
    title: '桌宠状态与用户情绪进入系统提示',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      seedCompanion(env, {
        emotion: {
          valence: -0.5,
          energy: 0.2,
          updatedAt: env.clock.now,
          recent: [{ mood: 'tired', intensity: 0.7, at: env.clock.now - HOUR }],
        },
      })
      await env.chat.handleChat({ id: 1, text: '今天有点累' })
      const system = lastReplyRequest(env).system
      assert.match(system, /你的状态/)
      assert.match(system, /累/)
      assert.match(system, /当前情绪/)
    },
  },
  {
    id: 'emotion-persist-restart',
    title: '情绪状态跨重启恢复',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await env.chat.handleChat({ id: 1, text: '今天好累' })
      env.chat.dispose()
      const saved = readJson(env.companionPath).emotion
      assert.ok(saved.valence < 0)

      const { DeskpetChat } = await import('../../index.js')
      const { BASE_OPTIONS } = await import('../lib/harness.mjs')
      const restarted = new DeskpetChat(env.harness.ctx, env.harness.bridge, {
        ...BASE_OPTIONS,
        chatHistoryPath: env.historyPath,
        chatMemoryPath: env.memoryPath,
        chatTimerPath: env.timerPath,
        chatCompanionPath: env.companionPath,
        now: () => env.clock.now,
      })
      await restarted.loadCompanion()
      assert.ok(restarted.companion.emotion.valence < 0)
      assert.ok(restarted.companion.emotion.recent.length >= 1)
    },
  },
  {
    id: 'emotion-disabled',
    title: '关闭情绪模块后不更新不注入',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatEmotionEnabled: false } })
      await env.chat.handleChat({ id: 1, text: '今天好累' })
      const system = lastReplyRequest(env).system
      assert.ok(!system.includes('你的状态'))
      assert.equal(moodMessages(env).length, 0)
      const saved = readJson(env.companionPath)
      assert.ok(!saved.emotion || saved.emotion.recent.length === 0)
    },
  },
  {
    id: 'emotion-recent-cap',
    title: '最近情绪记录有上限',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      const texts = ['好累', '好开心', '有点烦', '好难过', '很开心', '又累了']
      for (let index = 0; index < texts.length; index += 1) {
        await env.chat.handleChat({ id: index + 1, text: texts[index] })
      }
      const emotion = readJson(env.companionPath).emotion
      assert.ok(emotion.recent.length <= 5)
    },
  },
]
