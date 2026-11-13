#!/usr/bin/env node
/**
 * 桌宠自改进评测器（v0，确定性、不联网、不调用真实模型）。
 *
 * 用法：
 *   node selfimprove/evaluate.mjs            # 打印评分表并写 reports/latest.json
 *   node selfimprove/evaluate.mjs --strict   # 存在失败场景时以非 0 退出
 *
 * 每个场景在独立的临时目录中运行（复制/伪造历史与记忆文件），
 * 不会读写用户真实的 chat-history.json / user-memory.json。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scenarios as memoryScenarios } from './scenarios/memory.mjs'
import { timerScenarios } from './scenarios/timer.mjs'

const scenarios = [
  ...memoryScenarios.map((scenario) => ({ ...scenario, group: 'memory' })),
  ...timerScenarios.map((scenario) => ({ ...scenario, group: 'timer' })),
]

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = join(HERE, 'reports')
const STRICT = process.argv.includes('--strict')

const startedAt = new Date()
const results = []

for (const scenario of scenarios) {
  const begin = performance.now()
  try {
    await scenario.run()
    results.push({
      id: scenario.id,
      title: scenario.title,
      weight: scenario.weight ?? 1,
      ok: true,
      durationMs: Math.round(performance.now() - begin),
    })
  } catch (error) {
    results.push({
      id: scenario.id,
      title: scenario.title,
      weight: scenario.weight ?? 1,
      ok: false,
      durationMs: Math.round(performance.now() - begin),
      error: error?.message ?? String(error),
    })
  }
}

const totalWeight = results.reduce((sum, item) => sum + item.weight, 0)
const passedWeight = results.filter((item) => item.ok).reduce((sum, item) => sum + item.weight, 0)
const score = totalWeight === 0 ? 0 : Math.round((passedWeight / totalWeight) * 10000) / 100

const report = {
  tool: 'deskpet-selfimprove-evaluate',
  version: 1,
  mode: 'deterministic-mock-llm',
  startedAt: startedAt.toISOString(),
  scenarios: results.length,
  passed: results.filter((item) => item.ok).length,
  failed: results.filter((item) => !item.ok).length,
  score,
  checks: results,
}

mkdirSync(REPORT_DIR, { recursive: true })
writeFileSync(join(REPORT_DIR, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

const width = Math.max(...results.map((item) => item.title.length), 10)
console.log(`桌宠自改进评测  score=${score}  (${report.passed}/${report.scenarios} 场景通过)`)
console.log('-'.repeat(64))
for (const item of results) {
  const mark = item.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${item.title.padEnd(width)}  ${item.durationMs}ms`)
  if (!item.ok) console.log(`      ↳ ${item.error}`)
}
console.log('-'.repeat(64))
console.log(`报告: ${join(REPORT_DIR, 'latest.json')}`)

if (STRICT && report.failed > 0) process.exitCode = 1
