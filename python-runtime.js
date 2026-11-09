import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function resolvePythonPath(configured, { env = process.env, platform = process.platform, home = homedir(), exists = existsSync, list = readdirSync } = {}) {
  if (configured !== undefined && configured !== null && typeof configured !== 'string') {
    throw new TypeError('deskpet config: pythonPath must be a string')
  }
  if (configured?.trim()) return configured.trim()
  if (env.DSHPET_PYTHON?.trim()) return env.DSHPET_PYTHON.trim()
  const windows = platform === 'win32'
  const data = env.DSH_HOME || join(home, '.dsh')
  const managed = join(data, 'deskpet', 'runtime', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python')
  if (exists(managed)) return managed
  const names = windows ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  for (const folder of (env.PATH || env.Path || '').split(windows ? ';' : delimiter)) {
    const clean = folder.trim().replace(/^"|"$/gu, '')
    // Do not invoke the Windows Store's python alias.
    if (!clean || (windows && /(?:^|[\\/])WindowsApps(?:[\\/]|$)/iu.test(clean))) continue
    for (const name of names) {
      const candidate = join(clean, name)
      if (exists(candidate)) return candidate
    }
  }
  if (windows && env.LOCALAPPDATA) {
    const root = join(env.LOCALAPPDATA, 'Programs', 'Python')
    let versions = []
    try { versions = list(root).filter(name => /^Python\d+$/u.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) } catch {}
    for (const version of versions) {
      const candidate = join(root, version, 'python.exe')
      if (exists(candidate)) return candidate
    }
  }
  return windows ? 'python' : 'python3'
}
