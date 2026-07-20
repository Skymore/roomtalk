#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const keychainItem = process.env.ROOMTALK_PRODUCTION_KEYCHAIN_ITEM || 'roomtalk-production-env'
const raw = execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-a', 'roomtalk', '-s', keychainItem, '-w'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
)
const storedEnv = JSON.parse(raw)

if (!storedEnv || Array.isArray(storedEnv) || typeof storedEnv !== 'object') {
  throw new Error(`Keychain item ${keychainItem} does not contain an environment object`)
}

const entries = Object.entries(storedEnv).sort(([left], [right]) => left.localeCompare(right))
for (const [name, value] of entries) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof value !== 'string') {
    throw new Error(`Keychain item ${keychainItem} contains an invalid environment entry`)
  }
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'roomtalk-production-env-'))
const generatedEnvPath = path.join(temporaryDirectory, 'app.env')
writeFileSync(
  generatedEnvPath,
  `${entries.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n')}\n`,
  { mode: 0o600 }
)

const composeArguments = process.argv.length > 2
  ? process.argv.slice(2)
  : ['--profile', 'edge', 'up', '-d', '--build']

try {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', '.env.compose', '--env-file', generatedEnvPath, ...composeArguments],
    {
      cwd: process.cwd(),
      env: { ...process.env, ROOMTALK_APP_ENV_FILE: generatedEnvPath },
      stdio: 'inherit',
    }
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
