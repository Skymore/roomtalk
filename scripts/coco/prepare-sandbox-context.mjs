#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = resolve(repoRoot, 'ops/coco-sandbox/artifact.lock.json');

const outputFlagIndex = process.argv.indexOf('--output');
const outputPath = outputFlagIndex === -1 ? '' : process.argv[outputFlagIndex + 1];
const cocoRepoFlagIndex = process.argv.indexOf('--coco-repo');
const cocoRepoPath = cocoRepoFlagIndex === -1 ? '' : process.argv[cocoRepoFlagIndex + 1];

if (!outputPath || outputPath.startsWith('--')) {
  console.error('Usage: node scripts/coco/prepare-sandbox-context.mjs --output <context-dir> [--coco-repo <path>]');
  process.exit(2);
}
if (cocoRepoFlagIndex !== -1 && (!cocoRepoPath || cocoRepoPath.startsWith('--'))) {
  console.error('Usage: node scripts/coco/prepare-sandbox-context.mjs --output <context-dir> [--coco-repo <path>]');
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputDir = resolve(outputPath);
const localCocoRepo = cocoRepoPath || process.env.COCO_LOCAL_PATH || '';
const cocoRef = lock.coco.sourceRef;
const cocoSourceRepo = lock.coco.sourceRepo;
const codexCliBackend = lock.runner?.backends?.codex_cli;
const codexAppServerBackend = lock.runner?.backends?.codex_app_server;

if (!/^[0-9a-f]{40}$/i.test(cocoRef)) {
  throw new Error(`Coco sourceRef must be a pinned 40-character commit SHA, got: ${cocoRef}`);
}
if (!codexCliBackend || codexCliBackend.command !== 'python -m roomtalk_coco_runner.codex_cli') {
  throw new Error('Coco artifact lock must declare runner.backends.codex_cli.command');
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(codexCliBackend.codexCliVersion || '')) {
  throw new Error(`Codex CLI version must be pinned, got: ${codexCliBackend.codexCliVersion || ''}`);
}
if (!codexAppServerBackend || codexAppServerBackend.command !== 'python -m roomtalk_coco_runner.codex_app_server') {
  throw new Error('Coco artifact lock must declare runner.backends.codex_app_server.command');
}
if (codexAppServerBackend.codexCliVersion !== codexCliBackend.codexCliVersion) {
  throw new Error('Codex app-server backend must pin the same Codex CLI version as codex_cli');
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

const createCocoArchive = archivePath => {
  if (localCocoRepo) {
    const cocoRepo = resolve(localCocoRepo);
    const currentCocoHead = execFileSync('git', ['-C', cocoRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (currentCocoHead !== cocoRef) {
      throw new Error(`Coco local checkout is ${currentCocoHead}, expected pinned ref ${cocoRef}`);
    }
    execFileSync('git', ['-C', cocoRepo, 'archive', '--format=tar', '--output', archivePath, cocoRef]);
    return { sourceRepo: cocoRepo, sourceMode: 'local' };
  }

  if (!cocoSourceRepo) {
    throw new Error('Coco sourceRepo is required when no local Coco checkout is supplied.');
  }

  const sourceCheckout = mkdtempSync(resolve(tmpdir(), 'roomtalk-coco-source-'));
  try {
    execFileSync('git', ['init', '--quiet', sourceCheckout]);
    execFileSync('git', ['-C', sourceCheckout, 'fetch', '--quiet', '--depth=1', cocoSourceRepo, cocoRef]);
    const fetchedRef = execFileSync('git', ['-C', sourceCheckout, 'rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
    if (fetchedRef !== cocoRef) {
      throw new Error(`Fetched Coco ref ${fetchedRef}, expected pinned ref ${cocoRef}`);
    }
    execFileSync('git', ['-C', sourceCheckout, 'archive', '--format=tar', '--output', archivePath, 'FETCH_HEAD']);
    return { sourceRepo: cocoSourceRepo, sourceMode: 'remote' };
  } finally {
    rmSync(sourceCheckout, { recursive: true, force: true });
  }
};

const sourceArchiveDir = mkdtempSync(resolve(tmpdir(), 'roomtalk-coco-archive-'));
const archivePath = resolve(sourceArchiveDir, 'coco-source.tar');
try {
  const cocoSource = createCocoArchive(archivePath);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(resolve(outputDir, 'coco'), { recursive: true });

  execFileSync('tar', ['-xf', archivePath, '-C', resolve(outputDir, 'coco')]);

  cpSync(resolve(repoRoot, lock.runner.sourcePath), resolve(outputDir, 'roomtalk_coco_runner'), {
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
  cpSync(lockPath, resolve(outputDir, 'artifact.lock.json'));

  writeFileSync(resolve(outputDir, 'BUILD-METADATA.json'), JSON.stringify({
    artifactName: lock.artifactName,
    artifactVersion: lock.artifactVersion,
    cocoSourceRef: cocoRef,
    cocoSourceRepo: cocoSource.sourceRepo,
    cocoSourceMode: cocoSource.sourceMode,
    runnerBackends: lock.runner.backends,
    preparedAt: new Date().toISOString(),
  }, null, 2) + '\n');
} finally {
  rmSync(sourceArchiveDir, { recursive: true, force: true });
}

console.log(`Prepared Coco sandbox build context at ${outputDir}`);
