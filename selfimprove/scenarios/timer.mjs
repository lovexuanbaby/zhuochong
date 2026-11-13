import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'

import { DeskpetChat } from '../../index.js'
import {
  BASE_OPTIONS,
  createTimerEnv,
  listFiles,
  readJson,
} from '../lib/harness.mjs'

const MINUTE = 60_000

function replyText(env) {
  const message = env.harness.lastSent('chat/reply')
  return message?.text ?? ''
}

function firedMessages(env) {
  return env.harness.sent.filter((message) => message.type === 'chat/timer' && message.event === 'fired')
}

function normalRequests(env) {
  return env.harness.requests.filter(
    (request) => typeof request.system !== 'string' || !request.system.includes('长期记忆整理器'),
  )
}

async function command(env, text, id = 1) {
  await env.chat.handleChat({ id, text })
  return replyText(env)
}

function restarted(env, clock) {
  const chat = new DeskpetChat(env.harness.ctx, env.harness.bridge, {
    ...BASE_OPTIONS,
    chatHistoryPath: env.historyPath,
    chatMemoryPath: env.memoryPath,
    chatTimerPath: env.timerPath,
    now: () => clock.now,
  })
  env.chat = chat
  return chat
}

export const timerScenarios = [
  {
    id: 'timer-create-countdown',
    title: '创建倒计时并立刻回复（不调用模型）',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      const before = normalRequests(env).length
      const text = await command(env, '计时 5 分钟')
      assert.match(text, /#1/)
      assert.equal(env.chat.timers.length, 1)
      assert.equal(env.chat.timers[0].kind, 'countdown')
      assert.equal(env.chat.timers[0].dueAt, env.clock.now + 5 * MINUTE)
      assert.equal(normalRequests(env).length, before, '计时命令不应请求模型')
      assert.ok(env.harness.sentOf('chat/accepted').length >= 1)
    },
  },
  {
    id: 'timer-create-reminder',
    title: '创建提醒并带上提醒内容',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      const text = await command(env, '10 分钟后提醒我 喝水')
      assert.match(text, /喝水/)
      assert.equal(env.chat.timers.length, 1)
      assert.equal(env.chat.timers[0].kind, 'reminder')
      assert.equal(env.chat.timers[0].label, '喝水')
      assert.equal(env.chat.timers[0].dueAt, env.clock.now + 10 * MINUTE)

      const reverse = await command(env, '提醒我 20 分钟后 站起来活动', 2)
      assert.match(reverse, /站起来活动/)
      assert.equal(env.chat.timers.length, 2)
    },
  },
  {
    id: 'timer-fire-countdown',
    title: '倒计时到点触发并清理',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 1 分钟')
      env.clock.advance(MINUTE - 1)
      env.chat.tickTimers()
      assert.equal(firedMessages(env).length, 0, '未到点不能触发')
      env.clock.advance(1)
      env.chat.tickTimers()
      const fired = firedMessages(env)
      assert.equal(fired.length, 1)
      assert.equal(fired[0].kind, 'countdown')
      assert.match(fired[0].text, /计时结束/)
      assert.equal(env.chat.timers.length, 0)
      const saved = readJson(env.timerPath)
      assert.equal(saved.timers.length, 0)
    },
  },
  {
    id: 'timer-fire-reminder',
    title: '提醒到点触发提醒内容',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '2 分钟后提醒我 关火')
      env.clock.advance(2 * MINUTE)
      env.chat.tickTimers()
      const fired = firedMessages(env)
      assert.equal(fired.length, 1)
      assert.equal(fired[0].kind, 'reminder')
      assert.match(fired[0].text, /关火/)
    },
  },
  {
    id: 'timer-concurrent',
    title: '并发计时互不干扰',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 5 分钟', 1)
      await command(env, '2 分钟后提醒我 休息', 2)
      env.chat.tickTimers()
      env.clock.advance(2 * MINUTE)
      env.chat.tickTimers()
      assert.equal(firedMessages(env).length, 1)
      assert.match(firedMessages(env)[0].text, /休息/)
      env.clock.advance(3 * MINUTE)
      env.chat.tickTimers()
      assert.equal(firedMessages(env).length, 2)
      assert.equal(env.chat.timers.length, 0)
    },
  },
  {
    id: 'timer-list-cancel',
    title: '查看、取消单个与取消全部',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 5 分钟', 1)
      await command(env, '10 分钟后提醒我 喝水', 2)
      const list = await command(env, '查看计时', 3)
      assert.match(list, /#1/)
      assert.match(list, /#2/)
      assert.match(list, /喝水/)
      const cancel = await command(env, '取消计时 1', 4)
      assert.match(cancel, /已取消/)
      assert.equal(env.chat.timers.length, 1)
      const cancelAll = await command(env, '取消所有计时', 5)
      assert.match(cancelAll, /已取消/)
      assert.equal(env.chat.timers.length, 0)
      const empty = await command(env, '查看计时', 6)
      assert.match(empty, /没有/)
    },
  },
  {
    id: 'timer-invalid',
    title: '非法时长/不存在的计时给出友好回复',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      const bad = await command(env, '计时 五分钟')
      assert.match(bad, /秒|分钟|小时|格式/)
      assert.equal(env.chat.timers.length, 0)
      const missing = await command(env, '取消计时 99', 2)
      assert.match(missing, /没有找到/)
    },
  },
  {
    id: 'timer-persist-restart',
    title: '计时落盘并在重启后恢复',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 5 分钟')
      env.chat.dispose()
      const saved = readJson(env.timerPath)
      assert.equal(saved.timers.length, 1)

      const chat = restarted(env, env.clock)
      await chat.loadTimers()
      assert.equal(chat.timers.length, 1)
      env.clock.advance(5 * MINUTE)
      chat.tickTimers()
      assert.equal(firedMessages(env).length, 1)
    },
  },
  {
    id: 'timer-overdue-catchup',
    title: '过期计时重启后只补触发一次',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 5 分钟')
      env.chat.dispose()
      env.clock.advance(10 * MINUTE)

      const chat = restarted(env, env.clock)
      await chat.loadTimers()
      chat.tickTimers()
      assert.equal(firedMessages(env).length, 1, '过期的计时应补触发一次')
      chat.tickTimers()
      assert.equal(firedMessages(env).length, 1, '不能重复触发')
      const saved = readJson(env.timerPath)
      assert.equal(saved.timers.length, 0)

      const third = restarted(env, env.clock)
      await third.loadTimers()
      third.tickTimers()
      assert.equal(firedMessages(env).length, 1, '再次重启不能重复触发')
    },
  },
  {
    id: 'timer-corrupt-quarantine',
    title: '损坏的计时文件被隔离',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      writeFileSync(env.timerPath, '{不是 JSON', 'utf8')
      await env.chat.loadTimers()
      assert.equal(env.chat.timers.length, 0)
      assert.ok(listFiles(env.dir).some((name) => name.includes('.corrupt-')), '损坏文件应改名保留')
    },
  },
  {
    id: 'timer-max-active',
    title: '并发计时数量有上限',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatTimerMaxActive: 2 } })
      await command(env, '计时 1 分钟', 1)
      await command(env, '计时 2 分钟', 2)
      const third = await command(env, '计时 3 分钟', 3)
      assert.match(third, /最多|上限|已满/)
      assert.equal(env.chat.timers.length, 2)
    },
  },
  {
    id: 'timer-natural-durations',
    title: '自然说法：半小时/一刻钟/一小时',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      assert.match(await command(env, '半小时后提醒我 喝水', 1), /喝水/)
      assert.equal(env.chat.timers[0].dueAt, env.clock.now + 30 * MINUTE)
      await command(env, '一刻钟后提醒我 站起来', 2)
      assert.equal(env.chat.timers[1].dueAt, env.clock.now + 15 * MINUTE)
      const hour = await command(env, '计时 一小时', 3)
      assert.match(hour, /#3/)
      assert.equal(env.chat.timers[2].dueAt, env.clock.now + 60 * MINUTE)
    },
  },
  {
    id: 'timer-changed-protocol',
    title: '创建/取消时推送计时状态，tick 刷新剩余时间',
    weight: 2,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 5 分钟')
      const changed = () => env.harness.sent.filter((m) => m.type === 'chat/timer' && m.event === 'changed')
      let list = changed()
      assert.ok(list.length >= 1, '创建后应推送 changed')
      assert.equal(list[list.length - 1].timers.length, 1)
      assert.equal(list[list.length - 1].timers[0].remainingMs, 5 * MINUTE)
      env.clock.advance(1_000)
      env.chat.tickTimers()
      list = changed()
      const latest = list[list.length - 1]
      assert.equal(latest.timers.length, 1)
      assert.equal(latest.timers[0].remainingMs, 5 * MINUTE - 1_000)
      await command(env, '取消计时 1', 2)
      list = changed()
      assert.equal(list[list.length - 1].timers.length, 0)
    },
  },
  {
    id: 'timer-fired-clears-changed',
    title: '到点后推送空的计时列表',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 1 分钟')
      env.clock.advance(MINUTE)
      env.chat.tickTimers()
      const changed = env.harness.sent.filter((m) => m.type === 'chat/timer' && m.event === 'changed')
      assert.ok(changed.length >= 2)
      assert.equal(changed[changed.length - 1].timers.length, 0)
    },
  },
  {
    id: 'timer-sound-flag',
    title: '到点消息携带提示音开关（安静型默认静音）',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      await command(env, '计时 10 秒')
      env.clock.advance(10_000)
      env.chat.tickTimers()
      assert.equal(firedMessages(env)[0].sound, false, '默认应静音')

      const loud = createTimerEnv({ chat: { chatTimerSound: true } })
      await command(loud, '计时 10 秒', 1)
      loud.clock.advance(10_000)
      loud.chat.tickTimers()
      assert.equal(firedMessages(loud)[0].sound, true)
    },
  },
]
