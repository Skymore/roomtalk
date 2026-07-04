import { spawn } from 'child_process';
import { constants } from 'fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  CodexConnectionError,
  CodexDeviceAuthDriver,
  CodexDeviceAuthInfo,
  CodexDeviceAuthResult,
} from './codexConnection';
import { sanitizeCodexChildEnv } from './codexConnectionConfig';

export interface CodexCliDeviceAuthDriverOptions {
  cliBin?: string;
  loginTimeoutMs?: number;
  scriptBin?: string;
  tmpDir?: string;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const DEVICE_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device/;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

export class CodexCliDeviceAuthDriver implements CodexDeviceAuthDriver {
  private readonly cliBin: string;
  private readonly loginTimeoutMs: number;
  private readonly scriptBin: string;
  private readonly tmpDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: CodexCliDeviceAuthDriverOptions = {}) {
    this.cliBin = options.cliBin || 'codex';
    this.loginTimeoutMs = options.loginTimeoutMs || DEFAULT_LOGIN_TIMEOUT_MS;
    this.scriptBin = options.scriptBin || '/usr/bin/script';
    this.tmpDir = options.tmpDir || tmpdir();
    this.env = options.env || process.env;
  }

  async runDeviceAuth(input: {
    clientId: string;
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>;
    signal?: AbortSignal;
  }): Promise<CodexDeviceAuthResult> {
    await access(this.scriptBin, constants.X_OK);
    const codexHome = await mkdtemp(path.join(this.tmpDir, 'roomtalk-codex-device-auth-'));
    try {
      await writeCodexConfig(codexHome);
      assertNotAborted(input.signal);
      await this.runLogin(codexHome, input.onDeviceCode, input.signal);
      assertNotAborted(input.signal);
      const loginStatus = await this.runLoginStatus(codexHome);
      if (!/ChatGPT/i.test(loginStatus)) {
        throw new Error(`Codex login did not validate as ChatGPT auth: ${loginStatus}`);
      }
      const authJson = await readFile(path.join(codexHome, 'auth.json'), 'utf8');
      return { authJson, loginStatus };
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  }

  private runLogin(
    codexHome: string,
    onDeviceCode?: (info: CodexDeviceAuthInfo) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(deviceAuthCancelledError());
        return;
      }
      const child = spawn(this.scriptBin, this.buildScriptArgs(codexHome), {
        env: buildCodexChildEnv(this.env, codexHome),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let deviceCodeSent = false;
      let settled = false;
      let timedOut = false;

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortLogin);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const maybeEmitDeviceCode = (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        output += text;
        if (deviceCodeSent) {
          return;
        }
        const plain = stripAnsi(output);
        const url = plain.match(DEVICE_URL_PATTERN)?.[0];
        const code = plain.match(DEVICE_CODE_PATTERN)?.[0];
        if (!url || !code) {
          return;
        }

        deviceCodeSent = true;
        Promise.resolve(onDeviceCode?.({
          url,
          code,
          expiresAt: new Date(Date.now() + this.loginTimeoutMs).toISOString(),
        })).catch(error => {
          child.kill('SIGTERM');
          finish(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, this.loginTimeoutMs);
      const abortLogin = () => {
        child.kill('SIGTERM');
        finish(deviceAuthCancelledError());
      };

      signal?.addEventListener('abort', abortLogin, { once: true });
      child.stdout.on('data', maybeEmitDeviceCode);
      child.stderr.on('data', maybeEmitDeviceCode);
      child.on('error', error => finish(error));
      child.on('close', (exitCode, signal) => {
        if (timedOut) {
          finish(new Error(`codex login --device-auth timed out after ${this.loginTimeoutMs}ms`));
          return;
        }
        if (exitCode !== 0) {
          finish(new Error(`codex login --device-auth failed with exit ${exitCode ?? 'null'}${signal ? ` signal ${signal}` : ''}`));
          return;
        }
        finish();
      });
    });
  }

  private async runLoginStatus(codexHome: string): Promise<string> {
    const result = await runProcess(this.cliBin, ['login', 'status'], {
      env: buildCodexChildEnv(this.env, codexHome),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`codex login status failed with exit ${result.exitCode ?? 'null'}${result.signal ? ` signal ${result.signal}` : ''}`);
    }
    return `${result.stdout}\n${result.stderr}`.trim();
  }

  private buildScriptArgs(codexHome: string): string[] {
    if (process.platform === 'darwin') {
      return [
        '-q',
        '/dev/null',
        'env',
        `CODEX_HOME=${codexHome}`,
        this.cliBin,
        'login',
        '--device-auth',
      ];
    }

    return [
      '-q',
      '-c',
      `env CODEX_HOME=${shellQuote(codexHome)} ${shellQuote(this.cliBin)} login --device-auth`,
      '/dev/null',
    ];
  }
}

export const writeCodexConfig = async (codexHome: string): Promise<void> => {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(codexHome, 'config.toml'),
    buildCodexConfigToml(),
    { encoding: 'utf8', mode: 0o600 }
  );
};

export const buildCodexConfigToml = (): string => [
  'cli_auth_credentials_store = "file"',
  'sandbox_mode = "workspace-write"',
  '',
  '[shell_environment_policy]',
  'inherit = "core"',
  'ignore_default_excludes = false',
  'exclude = ["CODEX_HOME", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "*_TOKEN", "*_SECRET", "*_KEY"]',
  '',
].join('\n');

const buildCodexChildEnv = (env: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv => ({
  ...sanitizeCodexChildEnv(env),
  CODEX_HOME: codexHome,
});

const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const assertNotAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw deviceAuthCancelledError();
  }
};

const deviceAuthCancelledError = () => new CodexConnectionError(
  'Codex device auth was cancelled.',
  'device_auth_cancelled'
);

type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

const runProcess = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, options.timeoutMs);

  child.stdout.on('data', chunk => {
    stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });
  child.stderr.on('data', chunk => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  });
  child.on('error', error => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (exitCode, signal) => {
    clearTimeout(timer);
    if (timedOut) {
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
      return;
    }
    resolve({ stdout, stderr, exitCode, signal });
  });
});
