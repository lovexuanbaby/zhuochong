import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolvePythonPath } from '../python-runtime.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = process.argv[2] || process.env.DSHPET_TEST_PYTHON || resolvePythonPath()
const tests = [
  ['tests/config-smoke.mjs', process.execPath],
  ['tests/agent-status-smoke.mjs', process.execPath],
  ['tests/chat-host-smoke.mjs', process.execPath],
  ['tests/chat-ui-smoke.py', python],
  ['tests/agent-status-ui-smoke.py', python],
  ['tests/bridge-smoke.mjs', process.execPath, python],
]
const results = []
for (const [file, command, ...args] of tests) {
  const start = Date.now()
  const run = spawnSync(command, [file, ...args], {
    cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', PYTHONIOENCODING: 'utf-8' },
  })
  let checks
  try { checks = JSON.parse(run.stdout).checks?.length } catch {}
  const ok = run.status === 0 && !run.error
  results.push({ file, ok, checks, durationMs: Date.now() - start })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${file}${checks ? ` (${checks} checks)` : ''}`)
  if (!ok) { console.error(run.error?.message || run.stderr || run.stdout); process.exitCode = 1 }
}
mkdirSync(new URL('../build/', import.meta.url), { recursive: true })
writeFileSync(new URL('../build/test-results.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
