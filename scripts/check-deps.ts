#!/usr/bin/env bun
// Assert every bare-module import in the deployed sources is declared in the
// installed plugin's package.json. Catches the silent-transitive trap (e.g.,
// `import { z } from 'zod'` resolving via @modelcontextprotocol/sdk@1.27's
// node_modules — works today, breaks the moment upstream drops the dep).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'

const REPO_DIR = join(import.meta.dir, '..')
const PLUGIN_VERSION = process.env.PLUGIN_VERSION ?? '0.0.4'
const PLUGIN_DIR =
  process.env.PLUGIN_DIR ??
  join(homedir(), '.claude/plugins/cache/claude-plugins-official/discord', PLUGIN_VERSION)

const pluginPkgPath = join(PLUGIN_DIR, 'package.json')
if (!existsSync(pluginPkgPath)) {
  console.error(`error: ${pluginPkgPath} not found`)
  process.exit(2)
}

const pluginPkg = JSON.parse(readFileSync(pluginPkgPath, 'utf8')) as {
  dependencies?: Record<string, string>
}
const pluginDeps = new Set(Object.keys(pluginPkg.dependencies ?? {}))

const manifest = spawnSync('bash', [join(REPO_DIR, 'scripts/deploy-manifest.sh')], {
  encoding: 'utf8',
}).stdout.trim().split('\n').filter(Boolean)

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
])

const importRe = /(?:from|import\s*\(?|require\s*\()\s*['"]([^'"]+)['"]/g

function pkgRoot(spec: string): string {
  if (spec.startsWith('@')) {
    const [scope, name] = spec.split('/')
    return `${scope}/${name}`
  }
  return spec.split('/')[0]!
}

const missing: { mod: string; from: string }[] = []
const seen = new Set<string>()

for (const rel of manifest) {
  if (!rel.endsWith('.ts')) continue
  const src = readFileSync(join(REPO_DIR, rel), 'utf8')
  for (const m of src.matchAll(importRe)) {
    const spec = m[1]!
    if (spec.startsWith('.')) continue
    if (spec.startsWith('node:')) continue
    const pkg = pkgRoot(spec)
    if (NODE_BUILTINS.has(pkg)) continue
    if (seen.has(pkg)) continue
    seen.add(pkg)
    if (!pluginDeps.has(pkg)) {
      missing.push({ mod: pkg, from: rel })
    }
  }
}

if (missing.length === 0) {
  console.log(`deps ok: every bare-module import resolves against ${pluginPkgPath}`)
  process.exit(0)
}

console.error(`drift: ${missing.length} import(s) not declared in ${pluginPkgPath}:`)
for (const { mod, from } of missing) {
  console.error(`  ${mod}  (imported in ${from})`)
}
console.error('these resolve today only via transitive deps — fragile. add to plugin package.json or vendor differently.')
process.exit(1)
