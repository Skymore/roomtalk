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

// Ported from OpenMuse computer-e2b-desktop.ts at 73a7149.
import { createHash } from "node:crypto";
import {filesScript} from "./filesScript";
import { z } from "openmuse-zod";
import {
  type ComputerState,
  computerOutput,
  computerOutputLimit,
  type DockerResult,
} from "./computer";
import type { Config } from "./config";
import { AppError } from "./errors";

// The SDK is imported lazily so Docker-only installs never load it at runtime.
const sdk = () => import("@e2b/desktop");

const idleMs = 15 * 60_000; // auto-pause after 15 idle minutes; each operation refreshes it
// Opening the desktop keeps it awake longer: VNC traffic does not count as activity.
const desktopIdleMs = 30 * 60_000;
const controlMs = 10_000;
const createMs = 60_000;
const user = "user"; // the desktop template's uid 1000 account
const display = ":0";
export const resolution: [number, number] = [1280, 800];
// The SDK keeps every output byte in memory, so a command that keeps writing
// past the capture limit is killed once it reaches this hard ceiling.
const outputCeiling = 1024 * 1024;
const stdinChunk = 1024 * 1024;
// In-box temp files for one command's output are capped here (see desktopCommand).
const diskCeiling = 32 * 1024 * 1024;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface DesktopInfo {
  sandboxId: string;
  templateId: string;
  name?: string;
  state: "running" | "paused";
  endAt: Date;
  metadata: Record<string, string>;
  lifecycle?: { onTimeout: string; autoResume: boolean };
}
export interface DesktopHandle {
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<boolean>;
  sendStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
}
export interface DesktopRunOptions {
  user: string;
  cwd: string;
  envs: Record<string, string>;
  stdin: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout: (data: string) => void;
  onStderr: (data: string) => void;
}
export interface DesktopBox {
  /** Start a background command and return its handle. */
  run(command: string, options: DesktopRunOptions): Promise<DesktopHandle>;
  /** Run a short setup command and return its exit code. */
  setup(command: string, asUser: string): Promise<number>;
  writeRootFile(path: string, data: string): Promise<void>;
  /** Read a file as the desktop user. */
  readFile(path: string): Promise<Uint8Array>;
  /** Return the stream URL, reusing `known` while that stream is still serving. */
  stream(known?: string): Promise<string>;
  /** Push the idle timeout out. Fails on a paused box instead of resuming it. */
  keepAlive(timeoutMs: number): Promise<void>;
}
/** The slice of the E2B Desktop SDK this provider uses; tests replace it with a fake. */
export interface DesktopDriver {
  list(metadata: Record<string, string>): Promise<string[]>;
  info(sandboxId: string): Promise<DesktopInfo>;
  create(template: string, metadata: Record<string, string>): Promise<string>;
  /** Filesystem-only pause: every process ends and the disk persists. */
  pause(sandboxId: string): Promise<void>;
  /** Connect, resuming a paused sandbox, and set its idle timeout. */
  connect(sandboxId: string, timeoutMs: number): Promise<DesktopBox>;
}

// `load` is the SDK module; tests pass a fake one.
export function e2bDesktopDriver(config: Config, load = sdk): DesktopDriver {
  const opts = () => ({ apiKey: config.e2bApiKey, requestTimeoutMs: controlMs });
  return {
    async list(metadata) {
      const { Sandbox } = await load();
      const items = await Sandbox.list({
        ...opts(),
        query: { metadata, state: ["running", "paused"] },
      }).nextItems();
      return items.map((item) => item.sandboxId);
    },
    async info(sandboxId) {
      const { Sandbox } = await load();
      const info = await Sandbox.getInfo(sandboxId, opts());
      return { ...info, state: info.state === "running" ? "running" : "paused" };
    },
    async create(template, metadata) {
      const { Sandbox } = await load();
      const box = await Sandbox.create(template, {
        ...opts(),
        requestTimeoutMs: createMs,
        metadata,
        timeoutMs: idleMs,
        resolution,
        lifecycle: { onTimeout: { action: "pause", keepMemory: false }, autoResume: false },
      });
      return box.sandboxId;
    },
    async pause(sandboxId) {
      const { Sandbox } = await load();
      // Static pause: connect() would resume a box that is already paused.
      await Sandbox.pause(sandboxId, { ...opts(), keepMemory: false });
    },
    async connect(sandboxId, timeoutMs) {
      const { CommandExitError, Sandbox } = await load();
      const box = await Sandbox.connect(sandboxId, { ...opts(), timeoutMs });
      const setup = async (command: string, asUser: string) => {
        try {
          return (
            await box.commands.run(command, {
              user: asUser,
              envs: { DISPLAY: display },
              timeoutMs: 45_000,
            })
          ).exitCode;
        } catch (error) {
          if (error instanceof CommandExitError) return error.exitCode;
          throw error;
        }
      };
      return {
        async run(command, options) {
          return box.commands.run(command, { ...options, background: true });
        },
        setup,
        async writeRootFile(path, data) {
          await box.files.write(path, data, { user: "root" });
        },
        async readFile(path) {
          return box.files.read(path, { format: "bytes", user });
        },
        async keepAlive(timeoutMs) {
          await box.setTimeout(timeoutMs);
        },
        async stream(known) {
          // Exit bits: 1 = x11vnc runs, 2 = noVNC listens, 4 = `known` started it.
          const up = await setup(streamState(known ? streamTag(known) : "-"), user);
          if (up === 7 && known) return known;
          // The auth key lives only in the SDK object that started the stream, so a
          // stream this process did not start, or a half-started one, is restarted.
          // The SDK refuses to start while any x11vnc runs.
          if (up !== 0 && (await setup(streamStop, user)) !== 0)
            throw new Error("Previous desktop stream did not stop");
          await box.stream.start({ requireAuth: true });
          const url = box.stream.getUrl({ authKey: box.stream.getAuthKey() });
          await setup(`printf %s ${streamTag(url)} > ${streamTagFile}`, user);
          return url;
        },
      };
    },
  };
}

const stopped = () => new AppError("Start the computer before using its terminal or files", 409);

// Marks which URL the running stream belongs to, so a URL cached by this process is
// never returned after another process restarted the stream with a new password.
const streamTagFile = "/tmp/openmuse-stream";
const streamTag = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 16);
const streamState = (tag: string) =>
  [
    "v=0",
    "pgrep -x x11vnc >/dev/null && v=$((v | 1))",
    "netstat -tln | grep -q ':6080 ' && v=$((v | 2))",
    `[ "$(cat ${streamTagFile} 2>/dev/null)" = ${tag} ] && v=$((v | 4))`,
    "exit $v",
  ].join("; ");
// Brackets keep pkill -f from matching this script's own command line.
const streamStop = [
  "pkill -x x11vnc; pkill -f '[n]ovnc_proxy'; pkill -f '[w]ebsockify'",
  "for i in $(seq 50); do pgrep -x x11vnc >/dev/null || netstat -tln | grep -q ':6080 ' || exit 0; sleep 0.1; done",
  "pkill -9 -x x11vnc; pkill -9 -f '[w]ebsockify'; sleep 0.5",
  "pgrep -x x11vnc >/dev/null || netstat -tln | grep -q ':6080 ' || exit 0",
  "exit 1",
].join("\n");

/** In-box wrapper for one terminal command, with the same 30 second limit as Docker.
 * Output goes to temporary files, so a background GUI app (`firefox-esr URL &`)
 * cannot hold the output stream open after the shell exits. A watchdog stops the
 * command once those files pass `ceiling` bytes, so a runaway writer cannot fill the disk. */
export function desktopCommand(
  command: string,
  limit = computerOutputLimit,
  ceiling = diskCeiling,
) {
  const script = [
    // fd 3 is the real stderr; bash's own job notices go to /dev/null.
    "exec 3>&2 2>/dev/null",
    "o=$(mktemp -d) || exit 125",
    `/usr/bin/timeout --signal=TERM --kill-after=2s 30s /bin/bash --noprofile --norc -c "$1" >"$o/out" 2>"$o/err" </dev/null 3>&- &`,
    "p=$!",
    `{ while kill -0 $p 2>/dev/null; do [ $(( $(wc -c <"$o/out") + $(wc -c <"$o/err") )) -gt ${ceiling} ] && { : >"$o/big"; kill $p; break; }; sleep 0.1; done; } </dev/null >/dev/null 2>&1 3>&- &`,
    "w=$!",
    "wait $p",
    "s=$?",
    "kill $w 2>/dev/null",
    // Sent first: the server's output cap is shared, and stdout alone can fill it.
    `[ -e "$o/big" ] && printf 'Output exceeded the limit; the command was stopped.\\n' >&3`,
    `head -c ${limit + 1} "$o/out"`,
    `head -c ${limit + 1} "$o/err" >&3`,
    'rm -rf "$o"',
    "exit $s",
  ].join("\n");
  return `/bin/bash --noprofile --norc -c ${quote(script)} openmuse ${quote(command)}`;
}

// One GUI action, shaped like Anthropic's computer-use tool. Coordinates are native
// screenshot pixels; the screen is `resolution` wide and high.
export const desktopActionSchema = z
  .object({
    action: z.enum([
      "screenshot",
      "left_click",
      "double_click",
      "right_click",
      "mouse_move",
      "type",
      "key",
      "scroll",
      "wait",
    ]),
    coordinate: z
      .array(z.number().int().min(0))
      .length(2)
      .optional()
      .describe("[x, y] in screenshot pixels. Clicks and scroll without it use the pointer"),
    text: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe("Text for type; for key, xdotool key names or combos such as Return or ctrl+l"),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().int().min(1).max(15).optional().describe("Wheel clicks, default 3"),
    duration: z.number().min(0.1).max(10).optional().describe("Seconds to wait, default 1"),
  })
  .superRefine((value, ctx) => {
    const need = (field: "coordinate" | "text" | "scroll_direction", present: boolean) => {
      if (!present)
        ctx.addIssue({ code: "custom", path: [field], message: `${value.action} needs ${field}` });
    };
    if (value.action === "mouse_move") need("coordinate", !!value.coordinate);
    if (value.action === "type" || value.action === "key") need("text", !!value.text);
    if (value.action === "scroll") need("scroll_direction", !!value.scroll_direction);
    if (value.action === "key" && value.text && !/^[A-Za-z0-9_+ -]+$/.test(value.text))
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: "Use xdotool key names, e.g. ctrl+l",
      });
    const [x = 0, y = 0] = value.coordinate ?? [];
    if (x >= resolution[0] || y >= resolution[1])
      ctx.addIssue({
        code: "custom",
        path: ["coordinate"],
        message: `The screen is ${resolution.join("x")}`,
      });
  });
export type DesktopAction = z.infer<typeof desktopActionSchema>;

/** Receipt line for an action, e.g. `desktop left_click (640, 400)`. */
export function describeDesktopAction(action: DesktopAction) {
  return [
    "desktop",
    action.action,
    action.coordinate && `(${action.coordinate.join(", ")})`,
    action.text && JSON.stringify(action.text.slice(0, 200)),
    action.scroll_direction && `${action.scroll_direction} ${action.scroll_amount ?? 3}`,
    action.action === "wait" && `${action.duration ?? 1}s`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The xdotool (or sleep) command for one action; undefined for a plain screenshot. */
export function desktopInput(action: DesktopAction) {
  const [x, y] = action.coordinate ?? [];
  const at = action.coordinate ? `mousemove --sync ${x} ${y} ` : "";
  switch (action.action) {
    case "screenshot":
      return undefined;
    case "left_click":
      return `xdotool ${at}click 1`;
    case "double_click":
      return `xdotool ${at}click --repeat 2 --delay 120 1`;
    case "right_click":
      return `xdotool ${at}click 3`;
    case "mouse_move":
      return `xdotool ${at.trim()}`;
    case "type":
      return `xdotool type --delay 12 -- ${quote(action.text ?? "")}`;
    case "key":
      return `xdotool key -- ${(action.text ?? "").trim().split(/\s+/).map(quote).join(" ")}`;
    case "scroll": {
      const button = { up: 4, down: 5, left: 6, right: 7 }[action.scroll_direction ?? "down"];
      return `xdotool ${at}click --repeat ${action.scroll_amount ?? 3} ${button}`;
    }
    case "wait":
      return `sleep ${action.duration ?? 1}`;
  }
}

// One fixed path: actions on a computer are serialized by the service's lease.
const screenshotFile = "/tmp/openmuse-screenshot.jpg";
// A VNC viewer that loses focus mid-shortcut (e.g. Alt+Tab in the user's browser)
// leaves that modifier held, and every later click, key and wheel event then becomes
// a shortcut. Input actions release all modifiers first.
const releaseModifiers =
  "xdotool keyup Shift_L Shift_R Control_L Control_R Alt_L Alt_R Super_L Super_R Meta_L Meta_R ISO_Level3_Shift";
// Input, a short settle so the screen shows its effect, then a JPEG screenshot (about
// 40 to 200 KB at 1280x800, small enough to send to the model on every action).
// Exit 3 means the input failed, 4 the screenshot.
const actionScript = (input: string | undefined) =>
  [
    ...(input?.startsWith("xdotool ") ? [releaseModifiers] : []),
    ...(input ? [`${input} || exit 3`, "sleep 0.5"] : []),
    `scrot --pointer --quality 80 --overwrite ${screenshotFile} || exit 4`,
  ].join("\n");

// Starts Xvfb and Xfce when they are not running. A filesystem-only resume
// cold-boots the VM, which drops both and the DISPLAY set at creation.
const sessionScript = [
  "pgrep -x xfce4-session >/dev/null && exit 0",
  // Braces keep `&` on the app alone; a backgrounded `a || b` subshell would hold the output pipe.
  `pgrep -x Xvfb >/dev/null || { setsid Xvfb ${display} -ac -screen 0 ${resolution.join("x")}x24 -retro -dpi 96 -nolisten tcp -nolisten unix </dev/null >/dev/null 2>&1 & }`,
  `for i in $(seq 50); do xdpyinfo -display ${display} >/dev/null 2>&1 && break; sleep 0.2; done`,
  "setsid startxfce4 </dev/null >/dev/null 2>&1 &",
  "for i in $(seq 100); do pgrep -x xfce4-session >/dev/null && pgrep -x xfdesktop >/dev/null && exit 0; sleep 0.3; done",
  "exit 1",
].join("\n");

const loadFilesScript = async()=>filesScript;

// Runs each owner's computer in one E2B Desktop sandbox, matched by metadata.
// Paused means stopped: /workspace lives on the sandbox disk and processes end.
// Sandbox.connect resumes a paused box, so only start() and the first attach in a
// process connect. Later operations reuse the cached handle, which fails on a
// paused box instead of resuming it after a Stop.
// One cached connection per sandbox. `url` is the stream this process started and
// `streaming` the stream check or restart in flight, shared by concurrent viewers.
interface Handle {
  box: DesktopBox;
  url?: string;
  streaming?: Promise<string>;
}
export class E2BDesktopComputer {
  private readonly handles = new Map<string, Handle>();
  private readonly connecting = new Map<string, Promise<Handle>>();
  constructor(
    private readonly config: Config,
    private readonly driver: DesktopDriver = e2bDesktopDriver(config),
  ) {}
  template() {
    const template = this.config.computerE2bTemplate ?? "desktop";
    if (!/^[a-z0-9][a-z0-9_./-]{0,250}$/.test(template))
      throw new AppError("COMPUTER_E2B_TEMPLATE is invalid", 503);
    return template;
  }
  private async control<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "E2B desktop operation failed. Check E2B_API_KEY and COMPUTER_E2B_TEMPLATE.",
        503,
      );
    }
  }
  // Fail-closed analog of the Docker inspection: refuse to attach to anything this
  // deployment did not create. Sandbox.list omits lifecycle, so getInfo checks it.
  async inspect(labels: Record<string, string>) {
    const ids = await this.control(() => this.driver.list(labels));
    if (!ids.length) return undefined;
    const refuse = () =>
      new AppError(
        "Computer ownership or isolation does not match this deployment; refusing to attach",
        409,
      );
    if (ids.length > 1) throw refuse();
    const info = await this.control(() => this.driver.info(ids[0]));
    const template = this.template();
    const same = (a: Record<string, string>, b: Record<string, string>) =>
      Object.keys(a).length === Object.keys(b).length &&
      Object.entries(b).every(([key, value]) => a[key] === value);
    if (
      !same(info.metadata, labels) ||
      !(
        info.name === template ||
        info.templateId === template ||
        (!!info.name && template.endsWith(`/${info.name}`))
      ) ||
      info.lifecycle?.onTimeout !== "pause" ||
      info.lifecycle.autoResume
    )
      throw refuse();
    return info;
  }
  async state(labels: Record<string, string>): Promise<ComputerState> {
    const info = await this.inspect(labels);
    return !info ? "missing" : info.state === "running" ? "running" : "stopped";
  }
  // The service lease serializes timeout updates across API and worker processes.
  // Read E2B's current deadline so another process's refresh is never shortened.
  private awake(info: DesktopInfo | undefined, ms: number) {
    return Math.max(ms, info?.state === "running" ? info.endAt.getTime() - Date.now() : 0);
  }
  private forget(id: string) {
    this.handles.delete(id);
  }
  async start(labels: Record<string, string>) {
    const existing = await this.inspect(labels);
    const id = existing
      ? existing.sandboxId
      : await this.control(() => this.driver.create(this.template(), labels));
    const info = await this.inspect(labels); // re-check before start, including the shared deadline
    if (existing?.state !== "running") this.forget(id);
    const cached = this.handles.get(id);
    const box =
      cached?.box ?? (await this.control(() => this.driver.connect(id, this.awake(info, idleMs))));
    if (cached) await this.control(() => box.keepAlive(this.awake(info, idleMs)));
    if (!cached) this.handles.set(id, { box });
    const script = await loadFilesScript();
    await this.control(async () => {
      if (
        (await box.setup(
          `mkdir -p /workspace /opt/openmuse && chown ${user}:${user} /workspace`,
          "root",
        )) !== 0
      )
        throw new AppError("Computer workspace could not be prepared", 503);
      await box.writeRootFile("/opt/openmuse/files.py", script);
      if ((await box.setup(sessionScript, user)) !== 0)
        throw new AppError("Computer desktop session did not start", 503);
    });
  }
  async stop(labels: Record<string, string>) {
    const info = await this.inspect(labels);
    if (info?.state === "running") {
      this.forget(info.sandboxId);
      await this.control(() => this.driver.pause(info.sandboxId));
    }
  }
  private async attach(
    labels: Record<string, string>,
    keepMs = idleMs,
    firstConnect?: (work: () => Promise<Handle>) => Promise<Handle>,
    verified?: DesktopInfo,
  ) {
    const info = verified ?? (await this.inspect(labels));
    if (info?.state !== "running") throw stopped();
    const id = info.sandboxId;
    const cached = this.handles.get(id);
    if (cached) {
      try {
        await cached.box.keepAlive(this.awake(info, keepMs));
      } catch (error) {
        const current = await this.inspect(labels);
        if (current?.state !== "running") {
          this.forget(id);
          throw stopped();
        }
        await this.control(() => Promise.reject(error));
      }
      return cached;
    }
    // First use in this process, e.g. after an API restart. Concurrent first uses (two
    // desktop viewers) share one connect, so the box never gets two stream starts.
    const pending =
      this.connecting.get(id) ??
      (firstConnect
        ? firstConnect(async () => {
            const current = await this.inspect(labels);
            if (current?.state !== "running") throw stopped();
            return this.connect(id, current, keepMs);
          })
        : this.connect(id, info, keepMs)
      ).finally(() => this.connecting.delete(id));
    this.connecting.set(id, pending);
    return pending;
  }
  // Missing Xfce can mean startup or logout; never pause a VM based on that probe.
  private async connect(id: string, info: DesktopInfo, keepMs: number): Promise<Handle> {
    const box = await this.control(() => this.driver.connect(id, this.awake(info, keepMs)));
    if ((await this.control(() => box.setup("pgrep -x xfce4-session >/dev/null", user))) !== 0) {
      this.forget(id);
      throw new AppError(
        "The desktop session is unavailable. Start the computer to restore it.",
        409,
      );
    }
    const handle: Handle = { box };
    this.handles.set(id, handle);
    return handle;
  }
  /** The stream URL, shared by every viewer: concurrent requests join one stream check
   * or restart, so two viewers never race to restart it with different passwords. */
  async desktopUrl(
    labels: Record<string, string>,
    firstConnect?: (work: () => Promise<Handle>) => Promise<Handle>,
  ) {
    const handle = await this.attach(labels, desktopIdleMs, firstConnect);
    handle.streaming ??= this.control(() => handle.box.stream(handle.url))
      .then((url) => (handle.url = url))
      .finally(() => (handle.streaming = undefined));
    return handle.streaming;
  }
  /** Perform one GUI action and return the screenshot taken after it. Every X11 call
   * sets DISPLAY itself: the SDK's screenshot and input helpers rely on the DISPLAY
   * that Sandbox.create puts in the sandbox env, and a resumed box no longer has it. */
  async act(
    labels: Record<string, string>,
    action: DesktopAction,
    beforeInput?: () => Promise<void>,
  ) {
    const { box } = await this.attach(labels);
    const input = desktopInput(action);
    let uncertain = false;
    if (input) {
      await beforeInput?.();
      const script = [
        ...(input.startsWith("xdotool ") ? [releaseModifiers] : []),
        `${input} || exit 3`,
      ].join("\n");
      try {
        // xdotool dispatches sequentially: a later failure can follow a delivered
        // click or Return. A nonzero exit cannot confirm that no input occurred.
        uncertain = (await box.setup(script, user)) !== 0;
      } catch {
        // A lost response cannot tell us whether xdotool delivered the input.
        // Capture a screenshot if possible, but never replay the input here.
        uncertain = true;
      }
    }
    const warning = uncertain
      ? "The desktop input outcome is unknown: it may already have been performed. Inspect a fresh screenshot before repeating the action; do not automatically retry it."
      : undefined;
    const screen = { mimeType: "image/jpeg" as const, width: resolution[0], height: resolution[1] };
    try {
      const code = await this.control(() =>
        box.setup(actionScript(input ? "sleep 0.5" : undefined), user),
      );
      if (code !== 0) throw new AppError("The desktop screenshot failed", 502);
      const image = await this.control(() => box.readFile(screenshotFile));
      return { ...screen, image, uncertain, warning };
    } catch (error) {
      if (!input) throw error;
      return {
        ...screen,
        image: new Uint8Array(),
        uncertain,
        warning:
          warning ??
          "Action performed; the screenshot could not be taken. Take a screenshot before retrying the action.",
      };
    }
  }

  /** Same contract as DockerRunner: command outcomes are results, never exceptions. */
  async run(
    labels: Record<string, string>,
    command: string,
    options: {
      cwd?: string;
      input?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      propagateAttachError?: boolean;
      verified?: DesktopInfo;
    },
  ): Promise<DockerResult> {
    const output = computerOutput(options.maxOutputBytes);
    const { result, limit, finish } = output;
    let received = 0,
      handle: DesktopHandle | undefined,
      overflowed = false;
    // Terminal output is also capped in the VM; this guards filesystem responses
    // and any unexpected output outside that wrapper.
    const capture = (write: (data: string | Buffer) => void) => (data: string) => {
      write(data);
      received += Buffer.byteLength(data);
      if (received > limit + outputCeiling && !overflowed) {
        overflowed = true;
        void handle?.kill().catch(() => {});
      }
    };
    const { CommandExitError, InvalidArgumentError, TimeoutError } = await sdk();
    let box: DesktopBox;
    try {
      ({ box } = await this.attach(labels, idleMs, undefined, options.verified));
    } catch (error) {
      if (options.propagateAttachError) throw error;
      // Nothing started, so this is a plain failure and the box keeps running.
      result.stderr =
        error instanceof AppError ? error.message : "The computer could not be reached.";
      return result;
    }
    const abort = () => {
      result.interrupted = true;
      void handle?.kill().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      if (result.interrupted) return finish();
      try {
        handle = await box.run(command, {
          user,
          cwd: options.cwd ?? "/workspace",
          envs: { DISPLAY: display },
          stdin: options.input !== undefined,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          onStdout: capture(output.stdout),
          onStderr: capture(output.stderr),
        });
      } catch (error) {
        if (error instanceof InvalidArgumentError) {
          // A missing working directory is rejected before the command starts.
          result.exitCode = 126;
          output.stderr("The working directory does not exist.");
          return finish();
        }
        throw error;
      }
      if (options.signal?.aborted) abort();
      if (options.input !== undefined && !result.interrupted) {
        // Encode once: separate string slices can split a surrogate pair, and
        // the SDK encodes each send independently, replacing both halves.
        const input = Buffer.from(options.input, "utf8");
        for (let i = 0; i < input.length; i += stdinChunk)
          await handle.sendStdin(input.subarray(i, i + stdinChunk));
        await handle.closeStdin();
      }
      result.exitCode = (await handle.wait()).exitCode;
    } catch (error) {
      if (error instanceof CommandExitError) result.exitCode = error.exitCode;
      else if (error instanceof TimeoutError && error.message.includes("[deadline_exceeded]"))
        result.timedOut = true;
      // Any other stream loss leaves the outcome unknown; the service stops the box.
      else result.interrupted = true;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    finish();
    if (overflowed) result.stderr += "\nOutput exceeded the limit; the command was stopped.";
    return result;
  }
}
