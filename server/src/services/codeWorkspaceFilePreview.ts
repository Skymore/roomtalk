import path from 'path';
import { CodeWorkspaceAssetAccess, CodeWorkspaceAssetUrl, isWorkspaceBrowserPreviewPath, isWorkspaceImagePreviewPath } from './codeWorkspaceAssetAccess';
import {
  CodeAgentRunnerProcess,
  CodeAgentSandboxHandle,
  CodeAgentSandboxService,
  CodeAgentWorkspacePreviewServer,
  CodeAgentWorkspacePreviewTargetResolution,
} from './codeAgentSandboxService';

export type CodeWorkspaceFilePreview =
  | {
      kind: 'static-file';
      asset: CodeWorkspaceAssetUrl;
    }
  | {
      kind: 'dev-server';
      frameworkId: string;
      frameworkName: string;
      projectRoot: string;
      command: string;
      port: number;
      status: 'running' | 'starting' | 'stopped';
      requestedUrl: string;
      resolvedUrl?: string;
      server?: CodeAgentWorkspacePreviewServer;
    };

interface FrameworkDefinition {
  id: string;
  name: string;
  packages: string[];
  configFiles?: string[];
  excludedPackages?: string[];
  port: number;
  scriptCandidates: string[];
  scriptArgs: (port: number) => string[];
  directCommand: (port: number) => string[];
}

export interface ResolveCodeWorkspaceFilePreviewInput {
  roomId: string;
  sandboxId: string;
  handle: CodeAgentSandboxHandle;
  path: string;
  startDevServer?: boolean;
}

export interface CodeWorkspaceFilePreviewServiceOptions {
  sandboxService: CodeAgentSandboxService;
  assetAccess: CodeWorkspaceAssetAccess;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface ProjectInfo {
  root: string;
  packageJson: WorkspacePackageJson;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  configFiles: Set<string>;
}

interface WorkspacePackageJson {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

const DEFAULT_PREVIEW_START_TIMEOUT_MS = 20_000;
const DEFAULT_PREVIEW_POLL_INTERVAL_MS = 750;

const BUILD_OUTPUT_SEGMENTS = new Set([
  'dist',
  'build',
  'out',
  '_site',
  'storybook-static',
]);

const FRAMEWORKS: FrameworkDefinition[] = [
  nodeFramework('next', 'Next.js', ['next'], ['next.config.js', 'next.config.mjs', 'next.config.ts'], 3000, ['dev'], ['next', 'dev'], (port) => ['-H', '0.0.0.0', '-p', String(port)]),
  nodeFramework('nuxt', 'Nuxt', ['nuxt', 'nuxt3'], ['nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.ts'], 3000, ['dev'], ['nuxt', 'dev'], hostPortArgs),
  nodeFramework('astro', 'Astro', ['astro'], ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'], 4321, ['dev'], ['astro', 'dev'], hostPortArgs),
  nodeFramework('sveltekit', 'SvelteKit', ['@sveltejs/kit'], ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts'], 5173, ['dev'], ['vite'], hostPortArgs),
  nodeFramework('remix', 'Remix', ['@remix-run/dev'], ['remix.config.js', 'remix.config.ts', 'vite.config.js', 'vite.config.ts'], 3000, ['dev'], ['remix', 'vite:dev'], hostPortArgs),
  nodeFramework('angular', 'Angular', ['@angular/cli'], ['angular.json'], 4200, ['start', 'dev'], ['ng', 'serve'], hostPortArgs),
  nodeFramework('gatsby', 'Gatsby', ['gatsby'], ['gatsby-config.js', 'gatsby-config.ts'], 8000, ['develop', 'dev'], ['gatsby', 'develop'], (port) => ['-H', '0.0.0.0', '-p', String(port)]),
  nodeFramework('docusaurus', 'Docusaurus', ['@docusaurus/core'], ['docusaurus.config.js', 'docusaurus.config.ts'], 3000, ['start', 'dev'], ['docusaurus', 'start'], hostPortArgs),
  nodeFramework('qwik', 'Qwik', ['@builder.io/qwik', '@builder.io/qwik-city'], ['vite.config.js', 'vite.config.ts'], 5173, ['dev'], ['vite'], hostPortArgs),
  nodeFramework('solidstart', 'SolidStart', ['@solidjs/start'], ['app.config.ts', 'vite.config.ts', 'vite.config.js'], 3000, ['dev'], ['vinxi', 'dev'], hostPortArgs),
  nodeFramework('react-scripts', 'Create React App', ['react-scripts'], [], 3000, ['start'], ['react-scripts', 'start'], () => []),
  nodeFramework('vue-cli', 'Vue CLI', ['@vue/cli-service'], ['vue.config.js'], 8080, ['serve', 'dev'], ['vue-cli-service', 'serve'], hostPortArgs),
  nodeFramework('vite', 'Vite', ['vite'], ['vite.config.js', 'vite.config.mjs', 'vite.config.ts'], 5173, ['dev'], ['vite'], hostPortArgs),
  nodeFramework('parcel', 'Parcel', ['parcel'], [], 1234, ['dev', 'start'], ['parcel', 'index.html'], hostPortArgs),
  nodeFramework('eleventy', 'Eleventy', ['@11ty/eleventy'], ['.eleventy.js', 'eleventy.config.js'], 8080, ['start', 'dev'], ['eleventy', '--serve'], (port) => ['--port', String(port)]),
  nodeFramework('ember', 'Ember', ['ember-cli'], ['ember-cli-build.js'], 4200, ['start', 'dev'], ['ember', 'serve'], hostPortArgs),
];

function nodeFramework(
  id: string,
  name: string,
  packages: string[],
  configFiles: string[],
  port: number,
  scriptCandidates: string[],
  directPrefix: string[],
  args: (port: number) => string[],
): FrameworkDefinition {
  return {
    id,
    name,
    packages,
    configFiles,
    port,
    scriptCandidates,
    scriptArgs: args,
    directCommand: (selectedPort) => [...directPrefix, ...args(selectedPort)],
  };
}

function hostPortArgs(port: number) {
  return ['--host', '0.0.0.0', '--port', String(port)];
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const parentWorkspacePath = (workspacePath: string) => {
  const index = workspacePath.lastIndexOf('/');
  return index > 0 ? workspacePath.slice(0, index) : '';
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const commandLine = (tokens: string[]) => tokens.map(shellQuote).join(' ');

const workspacePathJoin = (...parts: string[]) => (
  path.posix.join(...parts.filter(part => part.length > 0))
);

const normalizedWorkspacePath = (value: string) => value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

function parsePackageJson(content: string): WorkspacePackageJson | null {
  try {
    const parsed = JSON.parse(content) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    return {
      scripts: Object.fromEntries(Object.entries(parsed.scripts || {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
      dependencies: Object.fromEntries([
        ...Object.entries(parsed.dependencies || {}),
        ...Object.entries(parsed.devDependencies || {}),
        ...Object.entries(parsed.peerDependencies || {}),
      ].filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    };
  } catch {
    return null;
  }
}

function projectAncestors(workspacePath: string) {
  const ancestors: string[] = [];
  let current = parentWorkspacePath(workspacePath);
  while (true) {
    ancestors.push(current);
    if (!current) {
      return ancestors;
    }
    current = parentWorkspacePath(current);
  }
}

function relativeFromProject(root: string, workspacePath: string) {
  return root ? path.posix.relative(root, workspacePath) : workspacePath;
}

function isBuildOutputPath(projectRoot: string, workspacePath: string) {
  const relative = relativeFromProject(projectRoot, workspacePath);
  const first = relative.split('/')[0] || '';
  return BUILD_OUTPUT_SEGMENTS.has(first) || relative.startsWith('.output/public/');
}

function isSourceHtmlEntry(projectRoot: string, workspacePath: string, html: string, frameworkId: string) {
  const relative = relativeFromProject(projectRoot, workspacePath);
  if (isBuildOutputPath(projectRoot, workspacePath)) {
    return false;
  }
  if (relative === 'index.html') {
    return true;
  }
  if (relative === 'public/index.html' && frameworkId === 'react-scripts') {
    return true;
  }
  return /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']\/src\//i.test(html)
    || /\bsrc=["']\/(?:src|@vite)\//i.test(html);
}

function detectFramework(project: ProjectInfo): FrameworkDefinition | null {
  for (const framework of FRAMEWORKS) {
    if (framework.excludedPackages?.some(packageName => project.packageJson.dependencies[packageName])) {
      continue;
    }
    const packageMatched = framework.packages.some(packageName => project.packageJson.dependencies[packageName]);
    const configMatched = framework.configFiles?.some(configFile => project.configFiles.has(configFile)) ?? false;
    if (packageMatched || configMatched) {
      return framework;
    }
  }
  return null;
}

function choosePackageManager(project: ProjectInfo) {
  return project.packageManager;
}

function packageManagerCommand(packageManager: ProjectInfo['packageManager'], script: string, args: string[]) {
  if (packageManager === 'yarn') {
    return ['yarn', script, ...args];
  }
  if (packageManager === 'bun') {
    return ['bun', 'run', script, ...args];
  }
  return [packageManager, 'run', script, '--', ...args];
}

function buildDevServerCommand(handle: CodeAgentSandboxHandle, project: ProjectInfo, framework: FrameworkDefinition) {
  const scripts = project.packageJson.scripts;
  const script = framework.scriptCandidates.find(candidate => scripts[candidate]);
  const args = framework.scriptArgs(framework.port);
  const executable = script
    ? packageManagerCommand(choosePackageManager(project), script, args)
    : ['npx', '--no-install', ...framework.directCommand(framework.port)];
  const workspaceRoot = handle.workspace.replace(/\/+$/, '');
  const projectDirectory = project.root ? `${workspaceRoot}/${project.root}` : workspaceRoot;
  const envPrefix = [
    `PORT=${shellQuote(String(framework.port))}`,
    `HOST=${shellQuote('0.0.0.0')}`,
  ].join(' ');
  return `cd ${shellQuote(projectDirectory)} && ${envPrefix} ${commandLine(executable)}`;
}

export class CodeWorkspaceFilePreviewService {
  private readonly startTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly startingByKey = new Map<string, Promise<CodeWorkspaceFilePreview>>();
  private readonly processesByKey = new Map<string, CodeAgentRunnerProcess>();

  constructor(private readonly options: CodeWorkspaceFilePreviewServiceOptions) {
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_PREVIEW_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PREVIEW_POLL_INTERVAL_MS;
  }

  async resolve(input: ResolveCodeWorkspaceFilePreviewInput): Promise<CodeWorkspaceFilePreview> {
    const requestedPath = normalizedWorkspacePath(input.path);
    const previewFile = await this.options.sandboxService.readWorkspaceFile?.(input.handle, input.path, { maxBytes: 256 * 1024 });
    const workspacePath = previewFile?.path || requestedPath;
    if (!isWorkspaceBrowserPreviewPath(workspacePath) || isWorkspaceImagePreviewPath(workspacePath)) {
      return this.staticPreview(input, workspacePath);
    }

    const htmlFile = previewFile || await this.options.sandboxService.readWorkspaceFile?.(input.handle, workspacePath, { maxBytes: 256 * 1024 });
    if (!htmlFile || htmlFile.encoding !== 'utf-8') {
      return this.staticPreview(input, workspacePath);
    }

    const project = await this.findProject(input.handle, htmlFile.path);
    const framework = project ? detectFramework(project) : null;
    if (!project || !framework || !isSourceHtmlEntry(project.root, htmlFile.path, htmlFile.content, framework.id)) {
      return this.staticPreview(input, htmlFile.path);
    }

    return this.devServerPreview(input, htmlFile.path, project, framework);
  }

  private staticPreview(input: ResolveCodeWorkspaceFilePreviewInput, workspacePath: string): CodeWorkspaceFilePreview {
    return {
      kind: 'static-file',
      asset: this.options.assetAccess.issueAssetUrl({
        roomId: input.roomId,
        sandboxId: input.sandboxId,
        path: workspacePath,
      }),
    };
  }

  private async findProject(handle: CodeAgentSandboxHandle, workspacePath: string): Promise<ProjectInfo | null> {
    for (const root of projectAncestors(workspacePath)) {
      const packageFile = await this.readTextFile(handle, workspacePathJoin(root, 'package.json'));
      if (!packageFile) {
        continue;
      }
      const packageJson = parsePackageJson(packageFile.content);
      if (!packageJson) {
        continue;
      }
      const configFiles = new Set<string>();
      const configCandidates = new Set(FRAMEWORKS.flatMap(framework => framework.configFiles || []));
      for (const configFile of configCandidates) {
        const file = await this.readTextFile(handle, workspacePathJoin(root, configFile), 1);
        if (file !== null) {
          configFiles.add(configFile);
        }
      }
      return {
        root,
        packageJson,
        packageManager: await this.detectPackageManager(handle, root),
        configFiles,
      };
    }
    return null;
  }

  private async detectPackageManager(handle: CodeAgentSandboxHandle, root: string): Promise<ProjectInfo['packageManager']> {
    if (await this.readTextFile(handle, workspacePathJoin(root, 'bun.lockb'), 1)) return 'bun';
    if (await this.readTextFile(handle, workspacePathJoin(root, 'pnpm-lock.yaml'), 1)) return 'pnpm';
    if (await this.readTextFile(handle, workspacePathJoin(root, 'yarn.lock'), 1)) return 'yarn';
    return 'npm';
  }

  private async readTextFile(handle: CodeAgentSandboxHandle, workspacePath: string, maxBytes = 128 * 1024) {
    try {
      const file = await this.options.sandboxService.readWorkspaceFile?.(handle, workspacePath, { maxBytes });
      if (!file || file.encoding !== 'utf-8') {
        return null;
      }
      if (file.byteSize === 0 && file.content === '') {
        return null;
      }
      return file;
    } catch {
      return null;
    }
  }

  private async devServerPreview(
    input: ResolveCodeWorkspaceFilePreviewInput,
    workspacePath: string,
    project: ProjectInfo,
    framework: FrameworkDefinition,
  ): Promise<CodeWorkspaceFilePreview> {
    const key = `${input.sandboxId}\0${project.root}\0${framework.id}\0${framework.port}`;
    const existing = this.startingByKey.get(key);
    if (existing) {
      return existing;
    }
    const starting = this.startDevServerPreview(input, workspacePath, project, framework)
      .finally(() => this.startingByKey.delete(key));
    this.startingByKey.set(key, starting);
    return starting;
  }

  private async startDevServerPreview(
    input: ResolveCodeWorkspaceFilePreviewInput,
    workspacePath: string,
    project: ProjectInfo,
    framework: FrameworkDefinition,
  ): Promise<CodeWorkspaceFilePreview> {
    const command = buildDevServerCommand(input.handle, project, framework);
    const existing = await this.findListeningServer(input.handle, framework.port);
    if (existing) {
      return this.devServerResult(input.handle, project, framework, command, existing, 'running');
    }

    if (!input.startDevServer && !this.processesByKey.has(this.previewProcessKey(input, project, framework))) {
      return this.devServerResult(input.handle, project, framework, command, null, 'stopped', workspacePath);
    }

    await this.ensureDevServerProcess(input, project, framework, command);

    const deadline = Date.now() + this.startTimeoutMs;
    do {
      const server = await this.findListeningServer(input.handle, framework.port);
      if (server) {
        return this.devServerResult(input.handle, project, framework, command, server, 'running');
      }
      if (this.pollIntervalMs <= 0) {
        break;
      }
      await sleep(this.pollIntervalMs);
    } while (Date.now() < deadline);

    return this.devServerResult(input.handle, project, framework, command, null, 'starting', workspacePath);
  }

  private async ensureDevServerProcess(
    input: ResolveCodeWorkspaceFilePreviewInput,
    project: ProjectInfo,
    framework: FrameworkDefinition,
    command: string,
  ) {
    const key = this.previewProcessKey(input, project, framework);
    if (this.processesByKey.has(key) || !this.options.sandboxService.startWorkspaceCommand) {
      return;
    }
    const process = await this.options.sandboxService.startWorkspaceCommand({
      handle: input.handle,
      command,
      env: {
        PORT: String(framework.port),
        HOST: '0.0.0.0',
      },
      timeoutMs: 0,
    });
    process.stdout?.resume();
    process.stderr?.resume();
    this.processesByKey.set(key, process);
    process.completed?.finally(() => {
      if (this.processesByKey.get(key) === process) {
        this.processesByKey.delete(key);
      }
    }).catch(() => undefined);
  }

  private previewProcessKey(
    input: ResolveCodeWorkspaceFilePreviewInput,
    project: ProjectInfo,
    framework: FrameworkDefinition,
  ) {
    return `${input.sandboxId}\0${project.root}\0${framework.id}\0${framework.port}`;
  }

  private async findListeningServer(handle: CodeAgentSandboxHandle, port: number) {
    if (!this.options.sandboxService.listWorkspacePreviewServers) {
      return null;
    }
    const servers = await this.options.sandboxService.listWorkspacePreviewServers(handle);
    return servers.find(server => server.port === port) || null;
  }

  private async devServerResult(
    handle: CodeAgentSandboxHandle,
    project: ProjectInfo,
    framework: FrameworkDefinition,
    command: string,
    server: CodeAgentWorkspacePreviewServer | null,
    status: 'running' | 'starting' | 'stopped',
    _workspacePath?: string,
  ): Promise<CodeWorkspaceFilePreview> {
    let resolved: CodeAgentWorkspacePreviewTargetResolution | null = null;
    if (server && this.options.sandboxService.resolveWorkspacePreviewTarget) {
      resolved = await this.options.sandboxService.resolveWorkspacePreviewTarget(handle, {
        kind: 'environment-port',
        port: framework.port,
        protocol: 'http',
        path: '/',
      });
    }
    return {
      kind: 'dev-server',
      frameworkId: framework.id,
      frameworkName: framework.name,
      projectRoot: project.root || '.',
      command,
      port: framework.port,
      status,
      requestedUrl: resolved?.requestedUrl ?? `http://localhost:${framework.port}/`,
      ...(resolved?.resolvedUrl ? { resolvedUrl: resolved.resolvedUrl } : {}),
      ...(server ? { server } : {}),
    };
  }
}
