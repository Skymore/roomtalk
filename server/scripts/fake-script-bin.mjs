#!/usr/bin/env node
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)

const main = async () => {
  if (args[0] === '-q' && args[1] === '-c') {
    await forward('/bin/sh', ['-c', args[2] || ''])
    return
  }

  if (args[0] === '-q' && args.length >= 3) {
    await forward(args[2], args.slice(3))
    return
  }

  console.error(`Unsupported fake script invocation: ${args.join(' ')}`)
  process.exitCode = 64
}

const forward = (command, commandArgs) => new Promise(resolve => {
  const child = spawn(command, commandArgs, {
    env: process.env,
    stdio: 'inherit',
  })
  const relaySignal = signal => {
    if (!child.killed) {
      child.kill(signal)
    }
  }
  process.once('SIGTERM', relaySignal)
  process.once('SIGINT', relaySignal)
  process.once('SIGHUP', relaySignal)
  child.on('error', error => {
    console.error(error)
    process.exitCode = 1
    resolve()
  })
  child.on('close', (code, signal) => {
    process.removeListener('SIGTERM', relaySignal)
    process.removeListener('SIGINT', relaySignal)
    process.removeListener('SIGHUP', relaySignal)
    if (signal) {
      process.exitCode = 128
    } else {
      process.exitCode = code ?? 0
    }
    resolve()
  })
})

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
