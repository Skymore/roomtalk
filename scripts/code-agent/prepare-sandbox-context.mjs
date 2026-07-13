#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = resolve(repoRoot, 'ops/code-agent-sandbox/artifact.lock.json');

const outputFlagIndex = process.argv.indexOf('--output');
const outputPath = outputFlagIndex === -1 ? '' : process.argv[outputFlagIndex + 1];
const engineRepoFlagIndex = process.argv.indexOf('--engine-repo');
const engineRepoPath = engineRepoFlagIndex === -1 ? '' : process.argv[engineRepoFlagIndex + 1];

if (!outputPath || outputPath.startsWith('--')) {
  console.error('Usage: node scripts/code-agent/prepare-sandbox-context.mjs --output <context-dir> [--engine-repo <path>]');
  process.exit(2);
}
if (engineRepoFlagIndex !== -1 && (!engineRepoPath || engineRepoPath.startsWith('--'))) {
  console.error('Usage: node scripts/code-agent/prepare-sandbox-context.mjs --output <context-dir> [--engine-repo <path>]');
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputDir = resolve(outputPath);
const localEngineRepo = engineRepoPath || process.env.CODE_AGENT_ENGINE_LOCAL_PATH || '';
const engineSource = lock.codeAgentEngine;
const engineRef = engineSource.sourceRef;
const engineSourceRepo = engineSource.sourceRepo;
const codeAgentCliBackend = lock.runner?.backends?.code_agent_cli;
const codexCliBackend = lock.runner?.backends?.codex_cli;
const codexAppServerBackend = lock.runner?.backends?.codex_app_server;
const daemonBackend = lock.runner?.backends?.daemon;
const runnerPyprojectPath = resolve(repoRoot, lock.runner?.sourcePath || '', 'pyproject.toml');
const runnerPyproject = readFileSync(runnerPyprojectPath, 'utf8');
const runnerName = runnerPyproject.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] || '';
const runnerVersion = runnerPyproject.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] || '';

if (!/^[0-9a-f]{40}$/i.test(engineRef)) {
  throw new Error(`Code-agent engine sourceRef must be a pinned 40-character commit SHA, got: ${engineRef}`);
}
if (!codeAgentCliBackend || codeAgentCliBackend.command !== 'python -m roomtalk_code_agent_runner') {
  throw new Error('Code-agent artifact lock must declare runner.backends.code_agent_cli.command');
}
if (runnerName !== lock.runner?.packageName) {
  throw new Error(`Runner package name mismatch: artifact lock has ${lock.runner?.packageName || ''}, pyproject has ${runnerName}`);
}
if (runnerVersion !== lock.runner?.packageVersion) {
  throw new Error(`Runner package version mismatch: artifact lock has ${lock.runner?.packageVersion || ''}, pyproject has ${runnerVersion}`);
}
if (!codexCliBackend || codexCliBackend.command !== 'python -m roomtalk_code_agent_runner.codex_cli') {
  throw new Error('Code-agent artifact lock must declare runner.backends.codex_cli.command');
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(codexCliBackend.codexCliVersion || '')) {
  throw new Error(`Codex CLI version must be pinned, got: ${codexCliBackend.codexCliVersion || ''}`);
}
if (!codexAppServerBackend || codexAppServerBackend.command !== 'python -m roomtalk_code_agent_runner.codex_app_server') {
  throw new Error('Code-agent artifact lock must declare runner.backends.codex_app_server.command');
}
if (codexAppServerBackend.codexCliVersion !== codexCliBackend.codexCliVersion) {
  throw new Error('Codex app-server backend must pin the same Codex CLI version as codex_cli');
}
if (codexAppServerBackend.pythonSdkVersion !== '0.1.0b3') {
  throw new Error(`Codex app-server backend must pin openai-codex 0.1.0b3, got: ${codexAppServerBackend.pythonSdkVersion || ''}`);
}
if (!daemonBackend || daemonBackend.command !== 'python -m roomtalk_code_agent_runner.daemon') {
  throw new Error('Code-agent artifact lock must declare runner.backends.daemon.command');
}

const isInside = (child, parent) => {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
};

const safeTmpRoots = ['/tmp', '/private/tmp'].map(path => resolve(path));
const allowOutsideTmp = process.env.ROOMTALK_ALLOW_ARTIFACT_OUTPUT_OUTSIDE_TMP === 'true';
if (outputDir === '/' || outputDir === repoRoot || isInside(repoRoot, outputDir) || isInside(outputDir, repoRoot)) {
  throw new Error(`Refusing to remove unsafe output directory: ${outputDir}`);
}
if (safeTmpRoots.some(root => outputDir === root)) {
  throw new Error(`Refusing to remove temporary root directory itself: ${outputDir}`);
}
if (!allowOutsideTmp && !safeTmpRoots.some(root => isInside(outputDir, root))) {
  throw new Error('Refusing to remove output outside /tmp. Set ROOMTALK_ALLOW_ARTIFACT_OUTPUT_OUTSIDE_TMP=true to override.');
}

const createEngineArchive = archivePath => {
  if (localEngineRepo) {
    const engineRepo = resolve(localEngineRepo);
    const currentEngineHead = execFileSync('git', ['-C', engineRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (currentEngineHead !== engineRef) {
      throw new Error(`Code-agent engine local checkout is ${currentEngineHead}, expected pinned ref ${engineRef}`);
    }
    execFileSync('git', ['-C', engineRepo, 'archive', '--format=tar', '--output', archivePath, engineRef]);
    return { sourceRepo: engineRepo, sourceMode: 'local' };
  }

  if (!engineSourceRepo) {
    throw new Error('Code-agent engine sourceRepo is required when no local checkout is supplied.');
  }

  const sourceCheckout = mkdtempSync(resolve(tmpdir(), 'roomtalk-code-agent-source-'));
  try {
    execFileSync('git', ['init', '--quiet', sourceCheckout]);
    execFileSync('git', ['-C', sourceCheckout, 'fetch', '--quiet', '--depth=1', engineSourceRepo, engineRef]);
    const fetchedRef = execFileSync('git', ['-C', sourceCheckout, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
    if (fetchedRef !== engineRef) {
      throw new Error(`Fetched code-agent engine ref ${fetchedRef}, expected pinned ref ${engineRef}`);
    }
    execFileSync('git', ['-C', sourceCheckout, 'archive', '--format=tar', '--output', archivePath, 'FETCH_HEAD']);
    return { sourceRepo: engineSourceRepo, sourceMode: 'remote' };
  } finally {
    rmSync(sourceCheckout, { recursive: true, force: true });
  }
};

const sourceArchiveDir = mkdtempSync(resolve(tmpdir(), 'roomtalk-code-agent-archive-'));
const archivePath = resolve(sourceArchiveDir, 'code-agent-engine-source.tar');
try {
  const engineArchive = createEngineArchive(archivePath);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(resolve(outputDir, 'code-agent-engine'), { recursive: true });

  execFileSync('tar', ['-xf', archivePath, '-C', resolve(outputDir, 'code-agent-engine')]);

  cpSync(resolve(repoRoot, lock.runner.sourcePath), resolve(outputDir, 'roomtalk_code_agent_runner'), {
    recursive: true,
    filter: source => {
      const normalized = source.split('\\').join('/');
      return !normalized.includes('/__pycache__') &&
        !normalized.includes('/.pytest_cache') &&
        !normalized.includes('/.venv') &&
        !normalized.endsWith('.egg-info') &&
        !normalized.includes('.egg-info/') &&
        !normalized.endsWith('/uv.lock') &&
        !normalized.endsWith('.pyc');
    },
  });
  cpSync(resolve(repoRoot, lock.image.dockerfile), resolve(outputDir, 'Dockerfile'));
  cpSync(resolve(repoRoot, lock.image.requirementsLock), resolve(outputDir, 'requirements.lock'));
  if (lock.image.codexSdkRequirementsLock) {
    cpSync(resolve(repoRoot, lock.image.codexSdkRequirementsLock), resolve(outputDir, 'codex-sdk.requirements.lock'));
  }
  cpSync(lockPath, resolve(outputDir, 'artifact.lock.json'));

  writeFileSync(resolve(outputDir, 'BUILD-METADATA.json'), JSON.stringify({
    artifactName: lock.artifactName,
    artifactVersion: lock.artifactVersion,
    codeAgentEngineSourceRef: engineRef,
    codeAgentEngineSourceRepo: engineArchive.sourceRepo,
    codeAgentEngineSourceMode: engineArchive.sourceMode,
    runnerBackends: lock.runner.backends,
    preparedAt: new Date().toISOString(),
  }, null, 2) + '\n');
} finally {
  rmSync(sourceArchiveDir, { recursive: true, force: true });
}

console.log(`Prepared code-agent sandbox build context at ${outputDir}`);
