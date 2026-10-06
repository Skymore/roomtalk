/*
MIT License

Copyright (c) 2026 OpenMuse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Ported from CopilotKit/OpenMuse 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
*/

// Ported from OpenMuse computer.ts at 73a7149.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {MediaObjectStorage} from "../mediaObjectStorage";
import { z } from "openmuse-zod";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "./types";
import {
  type ComputerBackend,
  DesktopComputerBackend,
  DockerComputer,
} from "./computer-backend";
import {
  describeDesktopAction,
  desktopActionSchema,
  E2BDesktopComputer,
  resolution,
} from "./computer-e2b-desktop";
import type { Config } from "./config";
import type { Store } from "./store";
import { AppError } from "./errors";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const computerOutputLimit = 128 * 1024;
const fileLimit = 256 * 1024;
const leaseDuration = 180000;
export const computerCommandSchema = z.object({
  command: z.string().trim().min(1).max(16000),
  cwd: z.string().default("/workspace"),
});
export const computerPathSchema = z.object({ path: z.string().min(1).max(2048) });
export const computerWriteSchema = computerPathSchema.extend({ text: z.string().max(fileLimit) });
export type ComputerState = "missing" | "stopped" | "running";
export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  interrupted: boolean;
  truncated: boolean;
}
export type DockerRunner = (
  args: string[],
  options: { timeoutMs: number; input?: string; signal?: AbortSignal; maxOutputBytes?: number },
) => Promise<DockerResult>;

/** Shared byte cap for both providers; stdout and stderr consume one budget. */
export function computerOutput(maxOutputBytes = computerOutputLimit) {
  const limit = Math.min(maxOutputBytes, 15 * 1024 * 1024);
  const result: DockerResult = {
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    interrupted: false,
    truncated: false,
  };
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let count = 0;
  const capture = (chunks: Buffer[]) => (data: string | Buffer) => {
    const chunk = typeof data === "string" ? Buffer.from(data) : data;
    const remaining = Math.max(0, limit - count);
    if (chunk.length > remaining) result.truncated = true;
    if (remaining) chunks.push(chunk.subarray(0, remaining));
    count += Math.min(remaining, chunk.length);
  };
  return {
    result,
    limit,
    stdout: capture(stdout),
    stderr: capture(stderr),
    finish() {
      result.stdout = Buffer.concat(stdout).toString("utf8");
      result.stderr = Buffer.concat(stderr).toString("utf8");
      return result;
    },
  };
}

// The only host process this provider can launch is Docker. User input is an argv
// element or stdin, never a host shell program. Do not add a shell fallback here.
export const runDocker: DockerRunner = (args, options) =>
  new Promise((resolve) => {
    const output = computerOutput(options.maxOutputBytes);
    const { result } = output;
    let settled = false;
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "HOME",
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "DOCKER_CONFIG",
      "DOCKER_TLS_VERIFY",
      "DOCKER_CERT_PATH",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn("docker", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(output.finish());
    };
    const abort = () => {
      result.interrupted = true;
      child.kill("SIGKILL");
      finish();
    };
    const timer = setTimeout(() => {
      result.timedOut = true;
      child.kill("SIGKILL");
      finish();
    }, options.timeoutMs);
    child.stdout.on("data", output.stdout);
    child.stderr.on("data", output.stderr);
    child.on("error", () => {
      output.stderr("Docker CLI could not be started. Install Docker and start its engine.");
      finish();
    });
    child.on("close", (code) => {
      result.exitCode = code;
      finish();
    });
    child.stdin.on("error", () => {
      /* A failed Docker process may close stdin before consuming it. Its exit is retained. */
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(options.input ?? "");
  });

export function computerIdentity(config: Config, owner: string) {
  const deployment = hash(config.computerDeploymentId ?? config.publicUrl).slice(0, 16);
  const ownerHash = hash(owner).slice(0, 24);
  const name = `openmuse-${deployment}-${ownerHash}`;
  return {
    container: `${name}-computer`,
    volume: `${name}-workspace`,
    labels: {
      "dev.openmuse.managed": "computer-v1",
      "dev.openmuse.deployment": deployment,
      "dev.openmuse.owner": ownerHash,
    } as Record<string, string>,
  };
}
export function workspacePath(path: string): string {
  if (
    path.includes("\0") ||
    path.length > 2048 ||
    !path.startsWith("/workspace") ||
    path.split("/").includes("..")
  )
    throw new AppError("Choose an absolute path inside /workspace", 422);
  const normalized = posix.normalize(path);
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/"))
    throw new AppError("Choose an absolute path inside /workspace", 422);
  return normalized;
}
/** Metadata for the latest screenshot blob, using the same shared data directory as Files. */
interface Screen {
  id: "latest";
  receiptId: string;
  mimeType: string;
  blob?: string;
  data?: string; // Older deployments stored base64; accepted until the next screenshot.
  takenAt?: string;
}
type Lease = {
  id: string;
  token: string;
  expiresAt: number;
  stopping: boolean;
  stopInFlight: boolean;
  stopAttempt: string;
  stopConfirmed: boolean;
  executorDone: boolean;
  operation: "command" | "operation";
};
export class ComputerService {
  private readonly backend: ComputerBackend;
  constructor(
    readonly db: Store,
    readonly config: Config,
    private readonly storage: MediaObjectStorage,
    docker: DockerRunner = runDocker,
    // Set only for COMPUTER_PROVIDER=e2b-desktop; the Docker paths below never use it.
    private readonly desktop: E2BDesktopComputer | undefined = config.computerProvider ===
    "e2b-desktop"
      ? new E2BDesktopComputer(config)
      : undefined,
  ) {
    this.backend = desktop
      ? new DesktopComputerBackend(config, desktop)
      : new DockerComputer(config, docker);
  }
  // Receipts are kept per provider, so Docker history never shows up on the desktop.
  private get receipts() {
    return this.backend.receipts;
  }
  get provider() {
    return this.backend.provider;
  }
  private labels(owner: string) {
    return computerIdentity(this.config, owner).labels;
  }
  /** Whether the owner's computer runs, on whichever provider is configured. */
  private async isRunning(owner: string) {
    return (await this.backend.state(owner)) === "running";
  }
  private enabled() {
    if (!this.config.computerEnabled)
      throw new AppError(
        this.provider === "docker"
          ? "Computer is not configured. Enable COMPUTER_ENABLED and build the local computer image."
          : "Computer is not configured. Enable COMPUTER_ENABLED and configure the desktop provider.",
        503,
      );
  }
  private async acquire(owner: string, operation: Lease["operation"] = "operation") {
    this.enabled();
    const previous = await this.db.get<Lease>(owner, "computer-state", "lease");
    const lease = {
      id: "lease",
      token: randomUUID(),
      expiresAt: Date.now() + leaseDuration,
      stopping: false,
      stopInFlight: false,
      stopAttempt: "",
      stopConfirmed: false,
      executorDone: operation !== "command",
      operation,
    };
    if (previous && previous.expiresAt > Date.now())
      throw new AppError("Computer is busy. Wait for the current operation to finish.", 409);
    const claimed = previous
      ? await this.db.compareAndSwap<Lease>(
          owner,
          "computer-state",
          "lease",
          { token: previous.token, expiresAt: previous.expiresAt },
          lease,
        )
      : await this.db.insertIfAbsent(owner, "computer-state", lease);
    if (!claimed)
      throw new AppError("Computer is busy. Wait for the current operation to finish.", 409);
    return lease;
  }
  private async exclusive<T>(
    owner: string,
    operation: (lease: Lease) => Promise<T>,
    kind: Lease["operation"] = "operation",
  ) {
    const lease = await this.acquire(owner, kind);
    try {
      return await operation(lease);
    } finally {
      // A stopped command must acknowledge completion before a new lifecycle can
      // begin. A delayed Docker client can otherwise exec into a restarted box.
      if (kind === "command")
        await this.db.compareAndSwap(
          owner,
          "computer-state",
          "lease",
          { token: lease.token },
          { executorDone: true },
        );
      await this.db.compareAndSwap(
        owner,
        "computer-state",
        "lease",
        { token: lease.token, stopping: false },
        { expiresAt: 0 },
      );
      await this.releaseStopped(owner, lease.token);
    }
  }
  private async releaseStopped(owner: string, token: string) {
    await this.db.compareAndSwap(
      owner,
      "computer-state",
      "lease",
      { token, stopping: true, stopConfirmed: true, executorDone: true, stopInFlight: false },
      { expiresAt: 0 },
    );
  }
  private async commands(owner: string) {
    const commands = await this.db.list<ComputerCommand>(owner, this.receipts);
    const lease = await this.db.get<Lease>(owner, "computer-state", "lease");
    if (!lease || lease.expiresAt <= Date.now()) {
      for (const command of commands)
        if (command.status === "running") {
          const saved = await this.db.compareAndSwap<ComputerCommand>(
            owner,
            this.receipts,
            command.id,
            { status: "running" },
            {
              status: "interrupted",
              completedAt: new Date().toISOString(),
              stderr:
                "Execution was interrupted. Its outcome is unknown; inspect files before running it again.",
            },
          );
          if (saved) Object.assign(command, saved);
        }
    }
    return commands.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
  }
  async snapshot(owner: string): Promise<ComputerSnapshot> {
    const base = {
      enabled: Boolean(this.config.computerEnabled),
      provider: this.provider,
      workspacePath: "/workspace" as const,
      network: this.backend.network,
      commands: await this.commands(owner),
    };
    if (!base.enabled)
      return {
        ...base,
        status: "unconfigured",
        message:
          this.provider === "e2b-desktop"
            ? "Enable the E2B desktop computer on the server to use its desktop, terminal and workspace files."
            : "Enable the Docker computer on the server to use its terminal and workspace files.",
      };
    try {
      return { ...base, status: (await this.isRunning(owner)) ? "running" : "stopped" };
    } catch (error) {
      return {
        ...base,
        status: "error",
        message:
          error instanceof AppError
            ? error.message
            : "Computer inspection failed. Check the computer provider setup.",
      };
    }
  }
  async start(owner: string) {
    await this.exclusive(owner, () => this.backend.start(owner));
    return this.snapshot(owner);
  }
  async stop(owner: string) {
    this.enabled();
    let lease = await this.db.get<Lease>(owner, "computer-state", "lease");
    if (!lease || lease.expiresAt <= Date.now()) lease = await this.acquire(owner);
    else if ((lease.operation !== "command" && !lease.stopping) || lease.stopInFlight)
      throw new AppError("Computer is busy with another operation. Try Stop again shortly.", 409);
    const attempt = randomUUID();
    const stopping = await this.db.compareAndSwap<Lease>(
      owner,
      "computer-state",
      "lease",
      {
        token: lease.token,
        stopping: lease.stopping,
        ...(lease.stopAttempt !== undefined ? { stopAttempt: lease.stopAttempt } : {}),
      },
      {
        stopping: true,
        stopInFlight: true,
        stopAttempt: attempt,
        stopConfirmed: false,
        expiresAt: Date.now() + leaseDuration,
      },
    );
    if (!stopping) throw new AppError("Computer is busy with another Stop request", 409);
    try {
      // Record intent before Docker Stop so a concurrently exiting command
      // cannot report success over the user's interruption.
      for (const command of await this.db.list<ComputerCommand>(owner, this.receipts))
        if (command.status === "running")
          await this.db.compareAndSwap(
            owner,
            this.receipts,
            command.id,
            { status: "running" },
            {
              status: "interrupted",
              completedAt: new Date().toISOString(),
              stderr: "Stopped by the user. Inspect the workspace before repeating this command.",
            },
          );
      await this.backend.stop(owner);
      await this.db.compareAndSwap(
        owner,
        "computer-state",
        "lease",
        { token: lease.token, stopAttempt: attempt },
        { stopInFlight: false, stopConfirmed: true },
      );
      await this.releaseStopped(owner, lease.token);
    } catch (error) {
      // Keep the command quarantine, but allow an explicit retry after a
      // transient Docker failure. Only an in-flight Stop excludes another Stop.
      await this.db.compareAndSwap(
        owner,
        "computer-state",
        "lease",
        { token: lease.token, stopAttempt: attempt },
        { stopInFlight: false, stopConfirmed: false },
      );
      throw error;
    }
    return this.snapshot(owner);
  }
  private async running(owner: string) {
    this.enabled();
    return this.backend.running(owner);
  }
  async execute(
    owner: string,
    raw: unknown,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<ComputerCommand> {
    this.enabled();
    const args = computerCommandSchema.parse(raw),
      cwd = workspacePath(args.cwd);
    const id = options.idempotencyKey
      ? hash(`computer-command:${options.idempotencyKey}`)
      : randomUUID();
    const previous = await this.db.get<ComputerCommand>(owner, this.receipts, id);
    if (previous) {
      if (previous.command !== args.command || previous.cwd !== cwd)
        throw new AppError("This operation ID already belongs to a different command", 409);
      await this.commands(owner);
      return (await this.db.get<ComputerCommand>(owner, this.receipts, id)) ?? previous;
    }
    return this.exclusive(
      owner,
      async (lease) => {
        const session = await this.running(owner);
        if (options.signal?.aborted)
          throw new AppError("Computer command was interrupted before execution", 409);
        const command: ComputerCommand = {
          id,
          command: args.command,
          cwd,
          status: "running",
          stdout: "",
          stderr: "",
          truncated: false,
          startedAt: new Date().toISOString(),
        };
        const saved = await this.db.insertIfAbsent(owner, this.receipts, command);
        if (!saved) {
          const existing = await this.db.get<ComputerCommand>(owner, this.receipts, id);
          if (existing) return existing;
          throw new AppError("Computer receipt could not be saved", 500);
        }
        const active = await this.db.get<Lease>(owner, "computer-state", "lease");
        if (
          !active ||
          active.token !== lease.token ||
          active.stopping ||
          active.expiresAt <= Date.now()
        )
          return this.db.put(owner, this.receipts, {
            ...command,
            status: "interrupted",
            stderr: "Stopped before execution",
            completedAt: new Date().toISOString(),
          });
        let result: DockerResult;
        try {
          result = await session.exec(args.command, cwd, options.signal);
        } catch {
          result = {
            stdout: "",
            stderr: "Execution was interrupted; inspect the workspace before retrying.",
            exitCode: null,
            interrupted: true,
            timedOut: false,
            truncated: false,
          };
        }
        const timedOut = result.timedOut || result.exitCode === 124;
        // A lost Docker client cannot cancel exec reliably. Stop the whole sandbox
        // to ensure no unknown command continues after the lease is released.
        if (result.timedOut || result.interrupted) {
          const attempt = randomUUID();
          const cleanup = await this.db.compareAndSwap<Lease>(
            owner,
            "computer-state",
            "lease",
            { token: lease.token, stopping: false },
            {
              stopping: true,
              stopInFlight: true,
              stopAttempt: attempt,
              stopConfirmed: false,
              expiresAt: Date.now() + leaseDuration,
            },
          );
          // An explicit Stop may already own cleanup. In either case the lease
          // cannot release until cleanup is confirmed and this executor is done.
          if (cleanup) {
            try {
              await session.stop();
              await this.db.compareAndSwap(
                owner,
                "computer-state",
                "lease",
                { token: lease.token, stopAttempt: attempt },
                { stopInFlight: false, stopConfirmed: true },
              );
            } catch {
              await this.db.compareAndSwap(
                owner,
                "computer-state",
                "lease",
                { token: lease.token, stopAttempt: attempt },
                { stopInFlight: false, stopConfirmed: false },
              );
              result.stderr +=
                "\nCould not confirm the computer stopped. It remains locked; retry Stop after checking the computer provider.";
            }
          }
        }
        const final: ComputerCommand = {
          ...command,
          status: result.interrupted
            ? "interrupted"
            : timedOut
              ? "timed_out"
              : result.exitCode === 0
                ? "succeeded"
                : "failed",
          ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          completedAt: new Date().toISOString(),
        };
        const finished = await this.db.compareAndSwap<ComputerCommand>(
          owner,
          this.receipts,
          id,
          { status: "running" },
          { ...final },
        );
        if (finished) return finished;
        const interrupted = await this.db.get<ComputerCommand>(owner, this.receipts, id);
        return this.db.put(owner, this.receipts, {
          ...final,
          status: "interrupted",
          stderr: [result.stderr, interrupted?.stderr].filter(Boolean).join("\n"),
        });
      },
      "command",
    );
  }
  private async file<T>(
    owner: string,
    operation: string,
    rawPath: string,
    text?: string,
    base64?: string,
  ): Promise<T> {
    const path = workspacePath(rawPath);
    if (text !== undefined && Buffer.byteLength(text) > fileLimit)
      throw new AppError("Text files must be 256 KB or smaller", 413);
    return this.exclusive(owner, async () => {
      const session = await this.running(owner);
      const input = JSON.stringify({ operation, path, text, base64 });
      const maxOutputBytes = operation === "read_pdf" ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
      // On E2B the request crosses the network on stdin after the process starts, so
      // the limit accounts for upload and expected download (PDF JSON can reach 14 MB).
      const expectedOutput = operation === "read_pdf" ? maxOutputBytes : 0;
      const seconds = 8 + Math.ceil(Math.max(input.length, expectedOutput) / (1024 * 1024));
      const result = await session.file(input, seconds, maxOutputBytes);
      if (result.exitCode !== 0 || result.timedOut || result.interrupted || result.truncated)
        throw new AppError(
          "Computer file operation failed. Check the path, permissions and file size; symlinks cannot be opened.",
          422,
        );
      try {
        return JSON.parse(result.stdout) as T;
      } catch {
        throw new AppError("Computer returned an invalid file response", 502);
      }
    });
  }
  private desktopOnly() {
    this.enabled();
    if (!this.desktop)
      throw new AppError("This computer has no desktop. Set COMPUTER_PROVIDER=e2b-desktop.", 404);
    return this.desktop;
  }
  /** Desktop stream URL for the owner's running E2B desktop (e2b-desktop provider only).
   * The first connection takes the lifecycle lease so it cannot race startup or Stop.
   * Cached viewers only check the stream and never block commands or actions. */
  async desktopUrl(owner: string) {
    const desktop = this.desktopOnly();
    return {
      url: await desktop.desktopUrl(this.labels(owner), (work) => this.exclusive(owner, work)),
    };
  }
  /** One screenshot, click, key or typing action on the running desktop, recorded as a
   * receipt in a separate action history. A stopped computer fails; it is never resumed here. */
  async desktopAction(owner: string, raw: unknown, options: { idempotencyKey?: string } = {}) {
    const desktop = this.desktopOnly();
    const action = desktopActionSchema.parse(raw);
    const id = options.idempotencyKey
      ? hash(`computer-desktop-action:${options.idempotencyKey}`)
      : randomUUID();
    // The display label truncates typed text, so bind the complete validated input.
    const actionHash = hash(JSON.stringify(action));
    return this.exclusive(owner, async () => {
      const previous = options.idempotencyKey
        ? await this.db.get<ComputerCommand>(owner, "computer-desktop-actions", id)
        : null;
      if (previous) {
        if (previous.actionHash !== actionHash)
          throw new AppError(
            "This operation ID already belongs to a different desktop action",
            409,
          );
        // Only the latest image is retained. Never dispatch again just to refresh it.
        const screen = await this.latestScreenshot(owner, id).catch(() => null);
        const image = screen?.bytes ?? Buffer.alloc(0);
        return {
          receipt: previous,
          width: resolution[0],
          height: resolution[1],
          image,
          mimeType: screen?.mimeType ?? "image/jpeg",
          data: image.toString("base64"),
          uncertain: previous.status === "interrupted",
          warning:
            "This operation ID already has a receipt; no new desktop input was sent. " +
            (screen
              ? "The saved screenshot is attached."
              : "Take a fresh screenshot before deciding what to do next."),
        };
      }
      const receipt: ComputerCommand = {
        id,
        command: describeDesktopAction(action),
        ...(options.idempotencyKey ? { actionHash } : {}),
        cwd: "/workspace",
        status: "succeeded",
        stdout: "",
        stderr: "",
        truncated: false,
        startedAt: new Date().toISOString(),
      };
      let shot: Awaited<ReturnType<typeof desktop.act>>;
      try {
        shot = await desktop.act(this.labels(owner), action, async () => {
          // Save intent before dispatch: a process crash must not erase uncertain input.
          await this.db.put(owner, "computer-desktop-actions", {
            ...receipt,
            status: "interrupted",
            stderr:
              "Desktop input is being dispatched; its outcome is unknown until confirmed. Inspect a fresh screenshot before repeating the action; do not automatically retry it.",
          });
        });
      } catch (error) {
        if (!(error instanceof AppError && error.status === 409))
          await this.db.put(owner, "computer-desktop-actions", {
            ...receipt,
            status: "failed",
            stderr: error instanceof Error ? error.message : "Desktop action failed",
            completedAt: new Date().toISOString(),
          });
        throw error;
      }
      const saved: ComputerCommand = {
        ...receipt,
        status: shot.uncertain ? "interrupted" : "succeeded",
        ...(shot.uncertain ? {} : { exitCode: 0 }),
        stdout: shot.warning ?? `Screenshot ${shot.width}x${shot.height}`,
        stderr: shot.uncertain ? (shot.warning ?? "Desktop input outcome is unknown") : "",
        completedAt: new Date().toISOString(),
      };
      const data = Buffer.from(shot.image).toString("base64");
      let warning = shot.warning;
      try {
        await this.db.put(owner, "computer-desktop-actions", saved);
        if (data) {
          const blob = `personal-agent-computer-screens/${owner}/latest.jpg`;
          await this.storage.putMediaObject({objectKey:blob,body:Buffer.from(shot.image),mimeType:shot.mimeType,byteSize:shot.image.length});
          await this.db.put<Screen>(owner, "computer-desktop-screens", {
            id: "latest",
            receiptId: saved.id,
            mimeType: shot.mimeType,
            blob,
            takenAt: saved.completedAt,
          });
        }
      } catch {
        warning = shot.uncertain
          ? `${shot.warning} Its final receipt or screenshot could not be saved.`
          : "Action performed; its receipt or screenshot could not be saved. Take a screenshot before retrying the action.";
      }
      return { receipt: saved, ...shot, data, warning };
    });
  }
  /** The latest desktop screenshot, or the one `receiptId` took if it is still the latest. */
  async latestScreenshot(owner: string, receiptId?: string) {
    this.desktopOnly();
    const shot = await this.db.get<Screen>(owner, "computer-desktop-screens", "latest");
    if (!shot || (receiptId && shot.receiptId !== receiptId))
      throw new AppError("No desktop screenshot yet", 404);
    return {
      mimeType: shot.mimeType,
      bytes:
        shot.blob === `personal-agent-computer-screens/${owner}/latest.jpg`
          ? (await this.storage.getMediaObject!(shot.blob)).body
          : Buffer.from(shot.data ?? "", "base64"),
    };
  }
  list(owner: string, path = "/workspace") {
    return this.file<ComputerDirectory>(owner, "list", path);
  }
  read(owner: string, path: string) {
    return this.file<{ path: string; text: string }>(owner, "read", path);
  }
  write(owner: string, path: string, text: string) {
    return this.file<{ path: string }>(owner, "write", path, text);
  }
  mkdir(owner: string, path: string) {
    return this.file<{ path: string }>(owner, "mkdir", path);
  }
  async writePdf(owner: string, path: string, bytes: Uint8Array) {
    if (bytes.length > 10 * 1024 * 1024 || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new AppError("Choose a PDF of 10 MB or smaller", 422);
    return this.file<{ path: string }>(
      owner,
      "write_pdf",
      path,
      undefined,
      Buffer.from(bytes).toString("base64"),
    );
  }
  async pdfBytes(owner: string, path: string) {
    const result = await this.file<{ path: string; base64: string }>(owner, "read_pdf", path);
    return { name: posix.basename(path), bytes: Buffer.from(result.base64, "base64") };
  }
}
