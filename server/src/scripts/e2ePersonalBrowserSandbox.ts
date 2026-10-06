// The existing E2E runner remains simulated. Browser actions use real local
// Chromium so its screenshots, form input and login restoration are testable.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { FakeCodeAgentSandboxService } from '../services/fakeCodeAgentSandboxService';
import { CodeAgentRunnerProcess, StartCodeAgentWorkspaceCommandInput } from '../services/codeAgentSandboxService';

export class E2EPersonalBrowserSandbox extends FakeCodeAgentSandboxService {
  private readonly browsers = new Map<string, { directory: string; daemon: ChildProcess }>();
  constructor() {
    super();
    process.once('exit', () => { for (const browser of this.browsers.values()) browser.daemon.kill('SIGTERM'); });
  }
  async startWorkspaceCommand(input: StartCodeAgentWorkspaceCommandInput): Promise<CodeAgentRunnerProcess> {
    const match = input.command.match(/^node \/opt\/roomtalk_code_agent_runner\/roomtalk_code_agent_runner\/personal_browser\.cjs request-file (\/tmp\/roomtalk-codex\/browser-[a-f0-9-]+\.json)$/);
    if (!match) return super.startWorkspaceCommand(input);
    const modulePath = path.resolve('roomtalk_code_agent_runner/roomtalk_code_agent_runner/personal_browser.cjs');
    let instance = this.browsers.get(input.handle.id);
    if (!instance) {
      const directory = fs.mkdtempSync('/tmp/roomtalk-e2e-browser-');
      const daemon = spawn(process.execPath, [modulePath, 'serve'], { stdio: 'ignore', env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: path.resolve('../client-heroui/node_modules'),
        ROOMTALK_BROWSER_SOCKET: path.join(directory, 'browser.sock'), E2E_CHROMIUM_EXECUTABLE_PATH: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
      } });
      instance = { directory, daemon }; this.browsers.set(input.handle.id, instance);
      for (let attempt = 0; !fs.existsSync(path.join(directory, 'browser.sock')); attempt++) {
        if (attempt > 50 || daemon.exitCode !== null) throw new Error('E2E browser did not start');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const requestPath = path.join(instance.directory, path.basename(match[1]));
    fs.writeFileSync(requestPath, await this.readSecretFile(input.handle, match[1], { maxBytes: 2 * 1024 * 1024 }), { mode: 0o600 });
    const child = spawn(process.execPath, [modulePath, 'request-file', requestPath], { stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: path.resolve('../client-heroui/node_modules'), ROOMTALK_BROWSER_SOCKET: path.join(instance.directory, 'browser.sock'),
    } });
    const completed = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => { fs.rmSync(requestPath, { force: true }); resolve({ exitCode, signal }); });
    });
    return { command: input.command, stdout: child.stdout!, stderr: child.stderr!, completed, stop: async () => { child.kill('SIGTERM'); } };
  }
  async destroy(sandboxId: string) {
    const browser = this.browsers.get(sandboxId);
    if (browser) {
      const stopped = new Promise<void>(resolve => { if (browser.daemon.exitCode !== null) resolve(); else browser.daemon.once('exit', () => resolve()); });
      browser.daemon.kill('SIGTERM'); await stopped;
      fs.rmSync(browser.directory, { recursive: true, force: true }); this.browsers.delete(sandboxId);
    }
    await super.destroy(sandboxId);
  }
}
