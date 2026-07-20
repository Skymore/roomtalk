#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'

const loadKeychainEnvironment = (service) => JSON.parse(execFileSync(
  '/usr/bin/security',
  ['find-generic-password', '-a', 'roomtalk', '-s', service, '-w'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
))

const source = loadKeychainEnvironment('roomtalk-source-env')
const target = loadKeychainEnvironment('roomtalk-production-env')

const migrationEnv = {
  ...process.env,
  SOURCE_S3_ENDPOINT: source.MEDIA_STORAGE_ENDPOINT || source.AWS_ENDPOINT_URL_S3 || source.S3_ENDPOINT,
  SOURCE_S3_REGION: source.MEDIA_STORAGE_REGION || source.AWS_REGION || 'auto',
  SOURCE_S3_FORCE_PATH_STYLE: source.MEDIA_STORAGE_FORCE_PATH_STYLE || 'false',
  SOURCE_S3_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID,
  SOURCE_S3_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
  SOURCE_S3_BUCKET: source.MEDIA_BUCKET_NAME || source.S3_BUCKET || source.AWS_BUCKET_NAME || source.BUCKET_NAME,
  TARGET_S3_ENDPOINT: process.env.ROOMTALK_LOCAL_S3_URL || 'http://127.0.0.1:8333',
  TARGET_S3_REGION: target.MEDIA_STORAGE_REGION || 'us-east-1',
  TARGET_S3_FORCE_PATH_STYLE: 'true',
  TARGET_S3_ACCESS_KEY_ID: target.LOCAL_S3_ACCESS_KEY_ID,
  TARGET_S3_SECRET_ACCESS_KEY: target.LOCAL_S3_SECRET_ACCESS_KEY,
  TARGET_S3_BUCKET: target.MEDIA_BUCKET_NAME || 'roomtalk-media',
}

for (const [name, value] of Object.entries(migrationEnv)) {
  if (name.startsWith('SOURCE_S3_') || name.startsWith('TARGET_S3_')) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`${name} is not configured`)
    }
  }
}

const result = spawnSync(
  'npm',
  ['--prefix', 'server', 'run', 'migrate:s3-to-s3', '--', ...process.argv.slice(2)],
  { cwd: process.cwd(), env: migrationEnv, stdio: 'inherit' }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
