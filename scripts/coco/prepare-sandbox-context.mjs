#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = resolve(repoRoot, 'ops/coco-sandbox/artifact.lock.json');

const outputFlagIndex = process.argv.indexOf('--output');
const outputPath = outputFlagIndex === -1 ? '' : process.argv[outputFlagIndex + 1];
const cocoRepoFlagIndex = process.argv.indexOf('--coco-repo');
const cocoRepoPath = cocoRepoFlagIndex === -1 ? '' : process.argv[cocoRepoFlagIndex + 1];

if (!outputPath) {
  console.error('Usage: node scripts/coco/prepare-sandbox-context.mjs --output <context-dir> [--coco-repo <path>]');
  process.exit(2);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputDir = resolve(outputPath);
const cocoRepo = resolve(cocoRepoPath || process.env.COCO_LOCAL_PATH || lock.coco.developmentLocalPath);
const cocoRef = lock.coco.sourceRef;

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

const currentCocoHead = execFileSync('git', ['-C', cocoRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (currentCocoHead !== cocoRef) {
  throw new Error(`Coco local checkout is ${currentCocoHead}, expected pinned ref ${cocoRef}`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
mkdirSync(resolve(outputDir, 'coco'), { recursive: true });

const archivePath = resolve(outputDir, 'coco-source.tar');
execFileSync('git', ['-C', cocoRepo, 'archive', '--format=tar', '--output', archivePath, cocoRef]);
execFileSync('tar', ['-xf', archivePath, '-C', resolve(outputDir, 'coco')]);
rmSync(archivePath, { force: true });

cpSync(resolve(repoRoot, lock.runner.sourcePath), resolve(outputDir, 'roomtalk_coco_runner'), {
  recursive: true,
  filter: source => !source.includes('__pycache__') && !source.endsWith('.pyc'),
});
cpSync(resolve(repoRoot, lock.image.dockerfile), resolve(outputDir, 'Dockerfile'));
cpSync(resolve(repoRoot, lock.image.requirementsLock), resolve(outputDir, 'requirements.lock'));
cpSync(lockPath, resolve(outputDir, 'artifact.lock.json'));

writeFileSync(resolve(outputDir, 'BUILD-METADATA.json'), JSON.stringify({
  artifactName: lock.artifactName,
  artifactVersion: lock.artifactVersion,
  cocoSourceRef: cocoRef,
  preparedAt: new Date().toISOString(),
}, null, 2) + '\n');

console.log(`Prepared Coco sandbox build context at ${outputDir}`);
