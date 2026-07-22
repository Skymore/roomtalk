#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const formatGiB = bytes => `${(bytes / (1024 ** 3)).toFixed(1)} GiB`

const reportHostCapacity = () => {
  const filesystem = statfsSync(process.cwd())
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize)
  const minimumFreeBytes = Number(process.env.ROOMTALK_MIN_HOST_FREE_GB || 20) * (1024 ** 3)
  console.log(`RoomTalk host disk: ${formatGiB(freeBytes)} free of ${formatGiB(totalBytes)}`)
  if (Number.isFinite(minimumFreeBytes) && freeBytes < minimumFreeBytes) {
    console.warn(`WARNING: host free space is below ${formatGiB(minimumFreeBytes)}`)
  }

  const dockerRawPath = process.env.ROOMTALK_DOCKER_RAW_PATH || path.join(
    homedir(),
    'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw',
  )
  if (!existsSync(dockerRawPath)) return
  const stats = statSync(dockerRawPath)
  const allocatedBytes = Number(stats.blocks || 0) * 512
  const warningBytes = Number(process.env.ROOMTALK_DOCKER_RAW_WARN_GB || 50) * (1024 ** 3)
  console.log(`Docker.raw: ${formatGiB(allocatedBytes)} allocated (${formatGiB(stats.size)} virtual)`)
  if (Number.isFinite(warningBytes) && allocatedBytes >= warningBytes) {
    console.warn(`WARNING: Docker.raw allocated space is at least ${formatGiB(warningBytes)}`)
  }
}

const parseComposePs = output => {
  const trimmed = output.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return trimmed.split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
}

const verifyReadinessUrl = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  const payload = await response.json()
  if (!response.ok || payload?.status !== 'online' || payload?.ready !== true) {
    throw new Error(`${url} is not ready (HTTP ${response.status}, status ${String(payload?.status)})`)
  }
}

const verifyProduction = async ({ composePrefix, composeEnv, edgeEnabled, roomtalkPort }) => {
  const expectedServices = ['app', 'postgres', 'redis', 'object-storage']
  if (edgeEnabled) expectedServices.push('cloudflared')
  const publicStatusUrl = process.env.ROOMTALK_PUBLIC_STATUS_URL || 'https://room.ruit.me/api/status'
  let lastError

  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      const output = execFileSync('docker', [...composePrefix, 'ps', '--format', 'json'], {
        cwd: process.cwd(),
        env: composeEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const services = parseComposePs(output)
      const byName = new Map(services.map(service => [service.Service, service]))
      for (const serviceName of expectedServices) {
        const service = byName.get(serviceName)
        if (!service) throw new Error(`${serviceName} has not started`)
        if (String(service.State).toLowerCase() !== 'running') {
          throw new Error(`${serviceName} state is ${String(service.State)}`)
        }
        if (service.Health && String(service.Health).toLowerCase() !== 'healthy') {
          throw new Error(`${serviceName} health is ${String(service.Health)}`)
        }
      }

      await verifyReadinessUrl(`http://127.0.0.1:${roomtalkPort}/api/health/ready`)
      if (edgeEnabled) await verifyReadinessUrl(publicStatusUrl)
      console.log(`RoomTalk production verified: ${expectedServices.join(', ')}`)
      reportHostCapacity()
      return
    } catch (error) {
      lastError = error
      if (attempt < 60) await wait(2_000)
    }
  }
  throw new Error(`RoomTalk production did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

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
const composePrefix = ['compose', '--env-file', '.env.compose', '--env-file', generatedEnvPath]
const composeEnv = { ...process.env, ROOMTALK_APP_ENV_FILE: generatedEnvPath }

try {
  const result = spawnSync(
    'docker',
    [...composePrefix, ...composeArguments],
    {
      cwd: process.cwd(),
      env: composeEnv,
      stdio: 'inherit',
    }
  )
  if (result.error) {
    throw result.error
  }
  process.exitCode = result.status ?? 1
  const detachedUp = result.status === 0 && composeArguments.includes('up') && composeArguments.includes('-d')
  if (detachedUp) {
    await verifyProduction({
      composePrefix,
      composeEnv,
      edgeEnabled: composeArguments.includes('edge'),
      roomtalkPort: storedEnv.ROOMTALK_PORT || process.env.ROOMTALK_PORT || '3012',
    })
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}
