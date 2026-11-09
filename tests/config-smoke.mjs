import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Config, normalizeConfig } from '../index.js'
import { resolvePythonPath } from '../python-runtime.js'

const checks = []
function check(name, fn) { fn(); checks.push(name) }
check('Config is a callable, serializable Schemastery schema', () => {
  assert.equal(typeof Config, 'function')
  const serialized = JSON.parse(JSON.stringify(Config))
  assert.equal(serialized.refs[serialized.uid].type, 'object')
})
check('schema and runtime share all numeric/boolean defaults', () => {
  const configured = Config({}), normalized = normalizeConfig({})
  for (const [key, value] of Object.entries(configured)) {
    if (typeof value === 'number' || typeof value === 'boolean') assert.equal(normalized[key], value, key)
  }
})
check('invalid timing, fractional limits and boolean strings are rejected', () => {
  for (const patch of [{pingIntervalMs: 10}, {chatTimeoutMs: 2 ** 32}, {chatMemoryMaxFacts: 1.5}, {chatMemoryEnabled: 'false'}]) {
    assert.throws(() => Config(patch))
    assert.throws(() => normalizeConfig(patch))
  }
})
check('blank optional text resets to defaults and model overrides stay paired', () => {
  assert.equal(normalizeConfig({chatModel: '', chatProvider: ''}).chatModel, undefined)
  assert.equal(normalizeConfig({chatSystemPrompt: ' ', chatMemoryPath: ''}).chatMemoryPath, undefined)
  assert.throws(() => normalizeConfig({chatProvider: 'one'}))
})

const home = join('C:', 'fixture-home')
const local = join(home, 'Local')
const managed = join(home, '.dsh', 'deskpet', 'runtime', 'Scripts', 'python.exe')
function resolve(configured, found = [], env = {}, versions = []) {
  return resolvePythonPath(configured, {platform: 'win32', home, env, exists: path => found.includes(path), list: () => versions})
}
check('explicit interpreter wins over environment and automatic discovery', () => {
  assert.equal(resolve(' custom python.exe ', [managed], {DSHPET_PYTHON: 'env.exe'}), 'custom python.exe')
  assert.throws(() => resolve(123))
})
check('environment override remains effective when settings field is blank', () => {
  assert.equal(resolve('', [managed], {DSHPET_PYTHON: ' env.exe '}), 'env.exe')
})
check('managed venv uses DSH_HOME without personal paths', () => {
  assert.equal(resolve(undefined, [managed]), managed)
  const custom = join(home, '中文 用户数据')
  const python = join(custom, 'deskpet', 'runtime', 'Scripts', 'python.exe')
  assert.equal(resolve('', [python], {DSH_HOME: custom}), python)
})
check('PATH discovery supports spaces and ignores Windows Store aliases', () => {
  const alias = join(home, 'WindowsApps'), real = join(home, 'Python With Spaces')
  const python = join(real, 'python.exe')
  assert.equal(resolve('', [join(alias, 'python.exe'), python], {PATH: `${alias};"${real}"`}), python)
})
check('standard Windows installs are discovered by version, not username', () => {
  const older = join(local, 'Programs', 'Python', 'Python39', 'python.exe')
  const newer = join(local, 'Programs', 'Python', 'Python314', 'python.exe')
  assert.equal(resolve('', [older, newer], {LOCALAPPDATA: local}, ['Python39', 'Python314']), newer)
})
check('missing Python falls back to a command for an actionable startup error', () => {
  assert.equal(resolve('', [], {}), 'python')
})
console.log(JSON.stringify({ok: true, checks}, null, 2))
