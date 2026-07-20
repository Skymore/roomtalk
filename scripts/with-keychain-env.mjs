#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'

const [keychainItem, separator, command, ...args] = process.argv.slice(2)

if (!keychainItem || separator !== '--' || !command) {
  console.error('Usage: node scripts/with-keychain-env.mjs <keychain-item> -- <command> [args...]')
  process.exit(2)
}

const raw = execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-a', 'roomtalk', '-s', keychainItem, '-w'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
)
const storedEnv = JSON.parse(raw)

if (!storedEnv || Array.isArray(storedEnv) || typeof storedEnv !== 'object') {
  throw new Error(`Keychain item ${keychainItem} does not contain an environment object`)
}

for (const [name, value] of Object.entries(storedEnv)) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== 'string') {
    throw new Error(`Keychain item ${keychainItem} contains an invalid environment entry`)
  }
}

const childEnv = { ...process.env, ...storedEnv }
if (typeof storedEnv.DATABASE_URL === 'string') {
  const databaseUrl = new URL(storedEnv.DATABASE_URL)
  childEnv.PGHOST = databaseUrl.hostname
  childEnv.PGPORT = databaseUrl.port || '5432'
  childEnv.PGUSER = decodeURIComponent(databaseUrl.username)
  childEnv.PGPASSWORD = decodeURIComponent(databaseUrl.password)
  childEnv.PGDATABASE = databaseUrl.pathname.replace(/^\//, '')
  childEnv.PGSSLMODE = databaseUrl.searchParams.get('sslmode') || 'require'
}

const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: childEnv,
  stdio: 'inherit',
})

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
