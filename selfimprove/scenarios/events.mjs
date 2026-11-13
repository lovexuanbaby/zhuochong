import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'

import { DeskpetChat } from '../../index.js'
import { BASE_OPTIONS, createTimerEnv, readJson } from '../lib/harness.mjs'

const EVENT_MARKER = '事件记忆整理器'

function eventCalls(env) {
  return env.harness.requests.filter((request) => request.system.includes(EVENT_MARKER))
}

function lastReplyRequest(env) {
  return env.harness.requests.filter((request) => !request.system.includes('长期记忆整理器')
    && !request.system.includes(EVENT_MARKER)).pop()
}

async function settle(env) {
  if (env.chat.memoryJob !== null) await env.chat.memoryJob
  if (env.chat.eventJob !== null) await env.chat.eventJob
}

async function runTurns(env, texts) {
  let id = 1
  for (const text of texts) {
    await env.chat.handleChat({ id: id++, text })
  }
  await settle(env)
}

function seedEvents(env, events) {
  writeFileSync(env.eventPath, JSON.stringify({
    version: 1,
    updatedAt: new Date(env.clock.now).toISOString(),
    events,
  }), 'utf8')
}

export const eventScenarios = [
  {
    id: 'events-request-shape',
    title: '事件整理请求结构正确',
    weight: 2,
    async run() {
      const env = createTimerEnv({ harness: { eventReplies: ['[]'] } })
      await runTurns(env, ['我在做一个桌宠插件', '今天加班到很晚'])
      const calls = eventCalls(env)
      assert.equal(calls.length, 1)
      assert.match(calls[0].system, /事件记忆整理器/)
      assert.match(calls[0].system, /summary/)
      assert.match(calls[0].system, /已有事件/)
      assert.equal(calls[0].messages[0].role, 'user')
      assert.match(calls[0].messages[0].content[0].text, /用户：/)
    },
  },
  {
    id: 'events-parse',
    title: '解析事件 JSON 并归一字段',
    weight: 2,
    async run() {
      const env = createTimerEnv({
        harness: {
          eventReplies: ['[{"summary":"11月12日加班到很晚","when":"2026-11-12 晚上","importance":4}]'],
        },
      })
      await runTurns(env, ['第一句', '第二句'])
      assert.equal(env.chat.events.length, 1)
      const event = env.chat.events[0]
      assert.equal(event.summary, '11月12日加班到很晚')
      assert.equal(event.when, '2026-11-12 晚上')
      assert.equal(event.importance, 4)
      assert.ok(event.id.length === 64)
    },
  },
  {
    id: 'events-fenced-json',
    title: '解析代码块包裹的事件 JSON',
    weight: 1,
    async run() {
      const env = createTimerEnv({
        harness: { eventReplies: ['```json\n[{"summary":"和小吴讨论了计时功能","importance":3}]\n```'] },
      })
      await runTurns(env, ['第一句', '第二句'])
      assert.equal(env.chat.events.length, 1)
      assert.equal(env.chat.events[0].summary, '和小吴讨论了计时功能')
    },
  },
  {
    id: 'events-max-cap',
    title: '事件条数有上限',
    weight: 1,
    async run() {
      const env = createTimerEnv({
        harness: {
          eventReplies: ['[{"summary":"事件一"},{"summary":"事件二"},{"summary":"事件三"},{"summary":"事件四"}]'],
        },
        chat: { chatEventMaxEvents: 2 },
      })
      await runTurns(env, ['第一句', '第二句'])
      assert.equal(env.chat.events.length, 2)
    },
  },
  {
    id: 'events-invalid-keeps-old',
    title: '非法输出保留旧事件',
    weight: 2,
    async run() {
      const env = createTimerEnv({ harness: { eventReplies: ['这不是 JSON'] } })
      seedEvents(env, [{ id: 'x'.repeat(64), summary: '旧事件', when: '', importance: 3, createdAt: env.clock.now - 1000 }])
      await runTurns(env, ['第一句', '第二句'])
      assert.equal(env.chat.events.length, 1)
      assert.equal(env.chat.events[0].summary, '旧事件')
    },
  },
  {
    id: 'events-recall',
    title: '按相关度召回事件并注入提示',
    weight: 2,
    async run() {
      const env = createTimerEnv({
        chat: { chatEventUpdateEveryTurns: 99, chatMemoryUpdateEveryTurns: 99 },
      })
      seedEvents(env, [
        { id: 'a'.repeat(64), summary: '11月12日加班到很晚，说很累', when: '2026-11-12 晚上', importance: 5, createdAt: env.clock.now - 86_400_000 },
        { id: 'b'.repeat(64), summary: '和小吴聊了青色桌宠配色', when: '', importance: 3, createdAt: env.clock.now - 2 * 86_400_000 },
        { id: 'c'.repeat(64), summary: '明天要交考试作业', when: '', importance: 2, createdAt: env.clock.now - 3 * 86_400_000 },
      ])
      await env.chat.handleChat({ id: 1, text: '最近加班到很晚，还是有点累' })
      const system = lastReplyRequest(env).system
      assert.match(system, /之前聊过/)
      assert.match(system, /加班到很晚/)
      assert.ok(!system.includes('考试作业'), '不相关事件不应召回')
    },
  },
  {
    id: 'events-recall-none',
    title: '无相关事件时不注入',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatEventUpdateEveryTurns: 99 } })
      seedEvents(env, [{ id: 'a'.repeat(64), summary: '加班到很晚', when: '', importance: 4, createdAt: env.clock.now - 1000 }])
      await env.chat.handleChat({ id: 1, text: '你好呀' })
      assert.ok(!lastReplyRequest(env).system.includes('之前聊过'))
    },
  },
  {
    id: 'events-persist-restart',
    title: '事件落盘并可重启恢复',
    weight: 2,
    async run() {
      const env = createTimerEnv({
        harness: { eventReplies: ['[{"summary":"11月12日加班到很晚","importance":5}]'] },
      })
      await runTurns(env, ['第一句', '第二句'])
      const saved = readJson(env.eventPath)
      assert.equal(saved.events.length, 1)

      const chat = new DeskpetChat(env.harness.ctx, env.harness.bridge, {
        ...BASE_OPTIONS,
        chatHistoryPath: env.historyPath,
        chatMemoryPath: env.memoryPath,
        chatTimerPath: env.timerPath,
        chatCompanionPath: env.companionPath,
        chatEventPath: env.eventPath,
        now: () => env.clock.now,
      })
      await chat.loadEvents()
      assert.equal(chat.events.length, 1)
      assert.equal(chat.events[0].importance, 5)
    },
  },
  {
    id: 'events-corrupt-quarantine',
    title: '损坏的事件文件被隔离',
    weight: 1,
    async run() {
      const env = createTimerEnv()
      writeFileSync(env.eventPath, '{不是 JSON', 'utf8')
      await env.chat.loadEvents()
      assert.equal(env.chat.events.length, 0)
      assert.ok(readdirSync(env.dir).some((name) => name.includes('.corrupt-')))
    },
  },
  {
    id: 'events-disabled',
    title: '关闭事件记忆后不整理不注入',
    weight: 1,
    async run() {
      const env = createTimerEnv({ chat: { chatEventsEnabled: false } })
      seedEvents(env, [{ id: 'a'.repeat(64), summary: '加班到很晚', when: '', importance: 4, createdAt: env.clock.now - 1000 }])
      await runTurns(env, ['加班到很晚', '还是有点累'])
      assert.equal(eventCalls(env).length, 0)
    },
  },
]
