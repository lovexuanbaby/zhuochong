// Run with the installed Desktop's Electron in Node mode, so imports from
// app.asar use the actual shipped Cordis implementation (no mock validator).
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { Config, normalizeConfig } from '../index.js'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the installed app.asar/dsh directory')
const { resolveConfig } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/cordis/lib/index.js')).href)
const settings = resolveConfig({ Config }, {})
assert.equal(settings.chatMemoryEnabled, true)
assert.equal(settings.chatHistoryMessages, 40)
assert.equal(settings.pythonPath, '')
assert.throws(() => resolveConfig({ Config }, { pingTimeoutMs: -1 }))
assert.throws(() => resolveConfig({ Config }, { chatMemoryEnabled: 'false' }))
assert.equal(typeof normalizeConfig(settings).pythonPath, 'string')
console.log(JSON.stringify({ok: true, checks: ['Native Cordis validates Config through Standard Schema', 'Defaults resolve', 'Invalid values reject', 'Runtime normalization accepts Host output']}))
