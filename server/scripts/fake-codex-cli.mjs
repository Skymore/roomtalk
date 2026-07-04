#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DEVICE_URL = 'https://auth.openai.com/codex/device'
const DEVICE_CODE = 'ABCD-EFGH'
const FAKE_ACCESS_VALUE = 'roomtalk-e2e-fake-access-value-0123456789'
const FAKE_REFRESH_VALUE = 'roomtalk-e2e-fake-refresh-value-0123456789'

const [command, subcommand] = process.argv.slice(2)

const main = async () => {
  if (command === 'login' && subcommand === '--device-auth') {
    await runDeviceAuth()
    return
  }
  if (command === 'login' && subcommand === 'status') {
    await runLoginStatus()
    return
  }
  console.error(`Unsupported fake Codex invocation: ${process.argv.slice(2).join(' ')}`)
  process.exitCode = 64
}

const runDeviceAuth = async () => {
  console.log(`Open ${DEVICE_URL}`)
  console.log(`Code: ${DEVICE_CODE}`)

  if (await shouldHoldAfterCode()) {
    await new Promise(resolve => {
      const timer = setInterval(() => undefined, 1000)
      const finish = () => {
        clearInterval(timer)
        resolve(undefined)
      }
      process.once('SIGTERM', finish)
      process.once('SIGINT', finish)
      process.once('SIGHUP', finish)
    })
    process.exitCode = 130
    return
  }

  if (!process.env.CODEX_HOME) {
    console.error('CODEX_HOME is required')
    process.exitCode = 64
    return
  }

  await mkdir(process.env.CODEX_HOME, { recursive: true })
  await writeFile(
    path.join(process.env.CODEX_HOME, 'auth.json'),
    JSON.stringify({
      OPENAI_AUTH: {
        access_token: FAKE_ACCESS_VALUE,
        refresh_token: FAKE_REFRESH_VALUE,
      },
    }, null, 2),
    'utf8'
  )
}

const runLoginStatus = async () => {
  if (!process.env.CODEX_HOME) {
    console.error('CODEX_HOME is required')
    process.exitCode = 64
    return
  }
  try {
    await readFile(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8')
    console.log('Logged in using ChatGPT')
  } catch {
    console.error('Not logged in')
    process.exitCode = 1
  }
}

const shouldHoldAfterCode = async () => {
  if (process.env.ROOMTALK_FAKE_CODEX_HOLD_AFTER_CODE === 'true') {
    return true
  }
  if (process.env.ROOMTALK_FAKE_CODEX_LOGIN_PLAN === 'never-hold') {
    return false
  }

  const stateDir = process.env.ROOMTALK_FAKE_CODEX_STATE_DIR
  if (!stateDir) {
    return process.env.ROOMTALK_FAKE_CODEX_LOGIN_PLAN === 'first-hold-then-success'
  }
  await mkdir(stateDir, { recursive: true })
  const attemptsPath = path.join(stateDir, 'device-auth-attempts.txt')
  const previous = Number.parseInt(await readFile(attemptsPath, 'utf8').catch(() => '0'), 10)
  const next = Number.isFinite(previous) ? previous + 1 : 1
  await writeFile(attemptsPath, `${next}\n`, 'utf8')
  return next === 1
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
