import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })
const npm = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
const packed = spawnSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', dist, '--cache', join(root, 'build/npm-cache')], {
  cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
})
assert.equal(packed.status, 0, packed.stderr || packed.error?.message)
const [result] = JSON.parse(packed.stdout)
const files = result.files.map(file => file.path)
for (const expected of ['index.js', 'config.js', 'python-runtime.js', 'cordis.patch.yml', 'python/deskpet_bridge.py', 'python/pet_windows.py', 'requirements.txt', 'scripts/setup.ps1', 'scripts/doctor.ps1', 'scripts/python-common.ps1', 'docs/INSTALL.md']) {
  assert.ok(files.includes(expected), `Missing packed file: ${expected}`)
}
assert.ok(!files.some(file => /(?:^|\/)(?:tests|node_modules|\.git|build|dist|__pycache__)(?:\/|$)/u.test(file)), 'Development data must not be shipped')
for (const file of ['index.js', 'config.js', 'python-runtime.js', 'cordis.patch.yml', 'scripts/setup.ps1', 'scripts/doctor.ps1']) {
  assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /[A-Z]:[\\/]Users[\\/][^\\/\s]+[\\/]/iu, `Personal path in ${file}`)
}
const archive = join(dist, result.filename)
const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex')
writeFileSync(`${archive}.sha256`, `${sha256}  ${result.filename}\n`)
writeFileSync(join(dist, 'release-manifest.json'), JSON.stringify({ filename: result.filename, version: result.version, sha256, files, bytes: result.size }, null, 2))
console.log(JSON.stringify({ ok: true, archive, sha256, files: files.length, bytes: result.size }, null, 2))
