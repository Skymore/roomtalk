#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'

const storedEnv = JSON.parse(execFileSync('/usr/bin/security', [
  'find-generic-password', '-a', 'roomtalk', '-s',
  process.env.ROOMTALK_PRODUCTION_KEYCHAIN_ITEM || 'roomtalk-production-env', '-w',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
const localObjectStorage = !storedEnv.MEDIA_STORAGE_ENDPOINT || storedEnv.MEDIA_STORAGE_ENDPOINT === 'http://object-storage:8333'
const stoppedServices = ['cloudflared', 'cloudflared-wenlin', 'app', 'ai-worker']
if (localObjectStorage) stoppedServices.push('object-storage')

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

const run = (args, tolerateFailure = false) => {
  const result = spawnSync('node', ['scripts/local-production.mjs', ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (!tolerateFailure && result.status !== 0) {
    throw new Error(`Local production command failed: ${args.join(' ')}`)
  }
  return result.status ?? 1
}

let backupSucceeded = false
try {
  run(['stop', ...stoppedServices])
  run([
    '--profile',
    'ops',
    'run',
    '--rm',
    '-e',
    `ROOMTALK_BACKUP_TIMESTAMP=${timestamp}`,
    'postgres-backup',
  ])
  backupSucceeded = true
} finally {
  // Restore the exact containers that were running before the maintenance
  // window. `compose up` may reconcile a newer Compose file against the old
  // application image (for example, a newly added migration command that the
  // old image does not contain), turning a backup into an accidental deploy.
  run(['--profile', 'edge', 'start', ...stoppedServices.toReversed()], true)
}

if (!backupSucceeded) {
  process.exit(1)
}

console.log(JSON.stringify({
  timestamp,
  database: `backups/roomtalk-${timestamp}.dump`,
  objectStorage: localObjectStorage ? `backups/roomtalk-object-storage-${timestamp}.tar.gz` : null,
  ...(!localObjectStorage ? { objectStorageEndpoint: storedEnv.MEDIA_STORAGE_ENDPOINT } : {}),
}))
