#!/usr/bin/env node
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const lockPath = resolve(repoRoot, 'ops/coco-sandbox/artifact.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

const args = process.argv.slice(2);
const options = {
  contextDir: process.env.COCO_E2B_BUILD_CONTEXT || '/tmp/roomtalk-coco-e2b-template-context',
  template: process.env.COCO_E2B_TEMPLATE_ID || lock.artifactVersion,
  dryRun: false,
  noCache: false,
  publish: false,
  clean: false,
  cpuCount: process.env.COCO_E2B_TEMPLATE_CPU_COUNT || '',
  memoryMb: process.env.COCO_E2B_TEMPLATE_MEMORY_MB || '',
  team: process.env.E2B_TEAM_ID || '',
  readyCmd: process.env.COCO_E2B_TEMPLATE_READY_CMD || [
    'codex --version >/dev/null',
    'codex-linux-sandbox --help >/dev/null',
    'roomtalk --help >/dev/null',
    'python -c "import importlib; importlib.import_module(\\"roomtalk_coco_runner.runner\\"); importlib.import_module(\\"roomtalk_coco_runner.codex_cli\\"); importlib.import_module(\\"roomtalk_coco_runner.codex_app_server\\")"',
  ].join(' && '),
};

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  switch (arg) {
    case '--context':
    case '--output':
      options.contextDir = readValue(args, ++index, arg);
      break;
    case '--template':
      options.template = readValue(args, ++index, arg);
      break;
    case '--cpu-count':
      options.cpuCount = readValue(args, ++index, arg);
      break;
    case '--memory-mb':
      options.memoryMb = readValue(args, ++index, arg);
      break;
    case '--ready-cmd':
      options.readyCmd = readValue(args, ++index, arg);
      break;
    case '--team':
      options.team = readValue(args, ++index, arg);
      break;
    case '--dry-run':
      options.dryRun = true;
      break;
    case '--no-cache':
      options.noCache = true;
      break;
    case '--publish':
      options.publish = true;
      break;
    case '--clean':
      options.clean = true;
      break;
    case '-h':
    case '--help':
      usage(0);
      break;
    default:
      console.error(`Unknown argument: ${arg}`);
      usage(1);
  }
}

if (!isValidTemplateName(options.template)) {
  console.error(`Invalid E2B template name: ${options.template}`);
  console.error('Template names must be lowercase and contain only letters, numbers, dashes, and underscores.');
  process.exit(1);
}

const contextDir = resolve(options.contextDir);
if (options.clean && existsSync(contextDir) && !options.dryRun) {
  rmSync(contextDir, { recursive: true, force: true });
}

const prepareCommand = [
  process.execPath,
  resolve(repoRoot, 'scripts/coco/prepare-sandbox-context.mjs'),
  '--output',
  contextDir,
];
run(prepareCommand);

const createCommand = [
  'npx',
  '--yes',
  '@e2b/cli',
  'template',
  'create',
  options.template,
  '--path',
  contextDir,
  '--dockerfile',
  'Dockerfile',
  '--ready-cmd',
  options.readyCmd,
];
if (options.cpuCount) {
  createCommand.push('--cpu-count', options.cpuCount);
}
if (options.memoryMb) {
  createCommand.push('--memory-mb', options.memoryMb);
}
if (options.noCache) {
  createCommand.push('--no-cache');
}
run(createCommand);

if (options.publish) {
  const publishCommand = [
    'npx',
    '--yes',
    '@e2b/cli',
    'template',
    'publish',
    options.template,
    '--yes',
  ];
  if (options.team) {
    publishCommand.push('--team', options.team);
  }
  run(publishCommand);
}

console.log(`E2B template build command completed for ${options.template}`);

function run(command) {
  console.log(formatCommand(command));
  if (options.dryRun) {
    return;
  }
  const result = spawnSync(command[0], command.slice(1), {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith('--')) {
    console.error(`${flag} requires a value`);
    usage(1);
  }
  return value;
}

function isValidTemplateName(value) {
  return /^[a-z0-9_-]+$/.test(value);
}

function formatCommand(command) {
  return command.map(part => (
    /^[a-zA-Z0-9_./:=@-]+$/.test(part)
      ? part
      : JSON.stringify(part)
  )).join(' ');
}

function usage(exitCode) {
  console.log(`Usage: node scripts/coco/build-e2b-template.mjs [options]

Options:
  --template <name>    E2B template name. Defaults to COCO_E2B_TEMPLATE_ID or artifactVersion.
  --context <dir>      Build context directory. Defaults to /tmp/roomtalk-coco-e2b-template-context.
  --clean              Remove the context directory before preparing it.
  --no-cache           Pass --no-cache to e2b template create.
  --publish            Publish the template after create/rebuild.
  --team <team-id>     Team id for e2b template publish.
  --cpu-count <n>      Pass --cpu-count to e2b template create.
  --memory-mb <mb>     Pass --memory-mb to e2b template create.
  --ready-cmd <cmd>    Ready command for E2B template create.
  --dry-run            Print commands without executing them.
`);
  process.exit(exitCode);
}
