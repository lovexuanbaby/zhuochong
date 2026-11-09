import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const archive = resolve(process.argv[2])
const python = process.argv[3]
assert.ok(python, 'Pass a Python interpreter with PySide6 Essentials installed')
mkdirSync(join(root, 'build'), {recursive: true})
const fixture = mkdtempSync(join(root, 'build', '中文 插件安装-'))
writeFileSync(join(fixture, 'package.json'), JSON.stringify({name: 'deskpet-install-check', private: true, type: 'module'}))
const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const install = spawnSync(process.execPath, [npm, 'install', archive, '--prefix', fixture, '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
  encoding: 'utf8', windowsHide: true, timeout: 60_000,
})
assert.equal(install.status, 0, install.stderr || install.error?.message)
const plugin = await import(pathToFileURL(join(fixture, 'node_modules/dsh-deskpet/index.js')).href)
assert.equal(typeof plugin.Config, 'function')
assert.equal(plugin.Config({}).chatMemoryEnabled, true)

process.env.QT_QPA_PLATFORM = 'offscreen'
process.env.PYTHONIOENCODING = 'utf-8'
let dispose
const listeners = new Map(), records = []
const ctx = {
  logger: Object.fromEntries(['info', 'debug', 'warn', 'error'].map(level => [level, (...args) => records.push([level, ...args])])),
  on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
  effect(run) { dispose = run(); return dispose },
}
const options = {
  pythonPath: python, pingIntervalMs: 60_000, handshakeTimeoutMs: 15_000,
  chatHistoryPath: join(fixture, 'data/history.json'), chatMemoryPath: join(fixture, 'data/memory.json'),
  chatMemoryEnabled: false,
}
try {
  await plugin.apply(ctx, options)
  assert.ok(records.some(record => record[0] === 'info' && String(record[1]).includes('ready')))
  const session = {id: 'install-smoke'}, agent = {id: session.id, session}
  listeners.get('agent/status')({agent, status: 'running'})
  listeners.get('session/event')(session, {type: 'turn/start', data: {turn: 1}})
  listeners.get('session/event')(session, {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}})
  listeners.get('agent/status')({agent, status: 'idle'})
} finally { await dispose?.() }
assert.equal(listeners.size, 0)
assert.ok(!records.some(record => record[0] === 'warn' || record[0] === 'error'), 'Packed bridge must run without warnings')

await assert.rejects(() => plugin.apply(ctx, {...options, pythonPath: join(fixture, 'missing-python.exe')}), /setup\.ps1/)
await dispose?.()
assert.equal(listeners.size, 0, 'failed startup also cleans subscriptions')

const blank = join(fixture, 'blank-runtime')
const venv = spawnSync(python, ['-m', 'venv', '--without-pip', blank], {encoding: 'utf8', windowsHide: true, timeout: 30_000})
assert.equal(venv.status, 0, venv.stderr || venv.error?.message)
records.length = 0
await assert.rejects(() => plugin.apply(ctx, {...options, pythonPath: join(blank, 'Scripts/python.exe')}), /setup\.ps1/)
await dispose?.()
assert.ok(records.some(record => record.join(' ').includes('PySide6')), 'missing dependency is explained in Python diagnostics')
assert.equal(listeners.size, 0)

const result = {ok: true, fixture, checks: ['Offline archive installation with dependencies', 'Schema exported by installed package', 'Real Python bridge under Chinese/space plugin path', 'Activity/result forwarding and cleanup', 'Missing Python guidance and cleanup', 'Missing PySide6 guidance and cleanup']}
writeFileSync(join(root, 'build/install-test-results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
