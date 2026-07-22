#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

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
  run(['stop', 'cloudflared', 'app', 'object-storage'])
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
  run(['--profile', 'edge', 'start', 'object-storage', 'app', 'cloudflared'], true)
}

if (!backupSucceeded) {
  process.exit(1)
}

console.log(JSON.stringify({
  timestamp,
  database: `backups/roomtalk-${timestamp}.dump`,
  objectStorage: `backups/roomtalk-object-storage-${timestamp}.tar.gz`,
}))
