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
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { CommandExitError, InvalidArgumentError, TimeoutError } from "@e2b/desktop";
import { ComputerService, computerIdentity } from "./personalComputer/computer";
import {
  type DesktopBox,
  type DesktopDriver,
  type DesktopInfo,
  type DesktopRunOptions,
  desktopActionSchema,
  desktopCommand,
  desktopInput,
  E2BDesktopComputer,
  e2bDesktopDriver,
} from "./personalComputer/computer-e2b-desktop";
import {computerInstructions} from "./personalComputer/instructions";
import type { Config } from "./personalComputer/config";
import {Store} from "./personalComputer/store";
import {createPostgresPool} from "../repositories/postgresPool";
import {PostgresStore,type PostgresPool} from "../repositories/postgresStore";
import {LocalMediaObjectStorage} from "./mediaObjectStorage";
import {randomUUID} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type { ComputerCommand } from "./personalComputer/types";

import {PersonalAgentComputerService} from './personalAgentComputer';
import type {PersonalAgentFileService} from './personalAgentFiles';
// Compare the original desktop tool receipt fields while invoking the real RoomTalk
// API adapter. CopilotKit's agent engine is replaced by the Codex runner.
function desktopTools(computer:ComputerService,files:unknown,owner:string,scope:string){
  const api=new PersonalAgentComputerService(computer,files as PersonalAgentFileService);
  return [{name:'use_desktop',execute:async(input:unknown)=>{
    try{
      const {operationId,...action}=input as Record<string,unknown>;
      const shot=await api.write(owner,{operation:'desktop',operationId,action},{scope}) as Awaited<ReturnType<ComputerService['desktopAction']>>;
      return [{type:'text',content:JSON.stringify({status:shot.receipt.status,receiptId:shot.receipt.id,warning:shot.warning,screen:{width:shot.width,height:shot.height}})},...(shot.data?[{type:'image'}]:[])];
    }catch(error){return [{type:'text',content:JSON.stringify({error:error instanceof Error?error.message:String(error)})}];}
  }}];
}
const url=process.env.ROOM_EVENT_TEST_DATABASE_URL;
if(url && !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(url).pathname.slice(1)))throw Error('Computer tests require a test database');
describe('OpenMuse desktop provider with PostgreSQL receipts',{skip:!url},()=>{
const prefix=`desktop-${randomUUID()}`;
const base:Config={publicUrl:'http://localhost:8787',computerEnabled:true,computerDeploymentId:prefix};
let pool:PostgresPool,records:PostgresStore,storage:LocalMediaObjectStorage,storageDir:string;
const logger={info(){},warn(){},error(){},debug(){}};
const apiKey = "e2b-test-key-never-sent";
const config: Config = { ...base, computerProvider: "e2b-desktop", e2bApiKey: apiKey };
const labels = computerIdentity(config, "owner").labels;

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
type Run = (
  command: string,
  options: DesktopRunOptions,
  handle: { kills: number },
) => Promise<number> | number;

// In-memory stand-in for the E2B Desktop SDK. It records every call and scripts
// command outcomes; command failures throw the SDK's own error classes.
function fake(
  options: {
    run?: Run;
    boxes?: Partial<DesktopInfo>[];
    listFails?: boolean;
    startError?: Error;
    keepAliveError?: Error;
    /** Runs after every getInfo, e.g. to land a Stop between find() and use. */
    afterInfo?: (id: string) => void;
    /** Exit code for a setup command, e.g. a failing xdotool call. */
    setupExit?: (command: string) => number | undefined;
    /** Applies an input before simulating a failed or lost setup response. */
    setupEffect?: (command: string) => Promise<void> | void;
    /** Holds every stream (re)start until it resolves. */
    streamGate?: () => Promise<void>;
  } = {},
) {
  const boxes = new Map<string, DesktopInfo>();
  // Whether Xfce runs in each box. A filesystem-only resume cold-boots without it.
  const desktops = new Map<string, boolean>();
  const calls = {
    lists: 0,
    infos: 0,
    create: [] as { template: string; metadata: Record<string, string> }[],
    pause: [] as string[],
    connect: [] as { id: string; timeoutMs: number }[],
    keepAlive: [] as number[],
    run: [] as { command: string; options: DesktopRunOptions }[],
    setup: [] as { command: string; user: string }[],
    files: [] as string[],
    reads: [] as string[],
    stdin: [] as Uint8Array[],
    closed: 0,
    kills: 0,
    streams: [] as (string | undefined)[],
  };
  const add = (info: Partial<DesktopInfo>) => {
    const id = info.sandboxId ?? `sbx-${boxes.size + 1}`;
    boxes.set(id, {
      sandboxId: id,
      templateId: "tpl-desktop-id",
      name: "desktop",
      state: "running",
      endAt: new Date(Date.now() + 15 * 60_000),
      metadata: { ...labels },
      lifecycle: { onTimeout: "pause", autoResume: false },
      ...info,
    });
    desktops.set(id, true);
    return id;
  };
  for (const info of options.boxes ?? []) add(info);
  const boxFor = (id: string): DesktopBox => ({
    async run(command, runOptions) {
      calls.run.push({ command, options: runOptions });
      if (options.startError) throw options.startError;
      const state = { kills: 0 };
      let killed: (() => void) | undefined;
      const killedPromise = new Promise<never>((_, reject) => {
        killed = () =>
          reject(new CommandExitError({ exitCode: -1, error: "killed", stdout: "", stderr: "" }));
      });
      killedPromise.catch(() => {});
      return {
        async wait() {
          const exitCode = await Promise.race([
            (async () => {
              if (options.run) return options.run(command, runOptions, state);
              runOptions.onStdout("hello\n");
              return 0;
            })(),
            killedPromise,
          ]);
          if (exitCode !== 0)
            throw new CommandExitError({
              exitCode,
              error: `exit status ${exitCode}`,
              stdout: "",
              stderr: "",
            });
          return { exitCode };
        },
        async kill() {
          calls.kills++;
          state.kills++;
          killed?.();
          return true;
        },
        async sendStdin(data) {
          calls.stdin.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
        },
        async closeStdin() {
          calls.closed++;
        },
      };
    },
    async setup(command, user) {
      calls.setup.push({ command, user });
      await options.setupEffect?.(command);
      if (command.includes("startxfce4")) desktops.set(id, true);
      if (command === "pgrep -x xfce4-session >/dev/null")
        return options.setupExit?.(command) ?? (desktops.get(id) ? 0 : 1);
      return options.setupExit?.(command) ?? 0;
    },
    async writeRootFile(path) {
      calls.files.push(path);
    },
    async readFile(path) {
      calls.reads.push(path);
      return jpeg;
    },
    async stream(known) {
      calls.streams.push(known);
      await options.streamGate?.();
      return known ?? `https://6080-sbx.e2b.app/vnc.html?password=p${calls.streams.length}`;
    },
    async keepAlive(timeoutMs) {
      calls.keepAlive.push(timeoutMs);
      if (options.keepAliveError) throw options.keepAliveError;
      // Like the SDK: setTimeout on a paused sandbox is a not-found error, not a resume.
      if (boxes.get(id)?.state !== "running") throw new Error("Sandbox not found");
      (boxes.get(id) as DesktopInfo).endAt = new Date(Date.now() + timeoutMs);
    },
  });
  const driver: DesktopDriver = {
    async list(metadata) {
      calls.lists++;
      if (options.listFails) throw new Error("network down");
      return [...boxes.values()]
        .filter((b) => Object.entries(metadata).every(([k, v]) => b.metadata[k] === v))
        .map((b) => b.sandboxId);
    },
    async info(id) {
      calls.infos++;
      const info = structuredClone(boxes.get(id) as DesktopInfo);
      options.afterInfo?.(id);
      return info;
    },
    async create(template, metadata) {
      calls.create.push({ template, metadata });
      return add({ name: template, metadata: { ...metadata } });
    },
    async pause(id) {
      calls.pause.push(id);
      (boxes.get(id) as DesktopInfo).state = "paused";
      desktops.set(id, false);
    },
    async connect(id, timeoutMs) {
      calls.connect.push({ id, timeoutMs });
      // Sandbox.connect resumes a paused box.
      (boxes.get(id) as DesktopInfo).state = "running";
      (boxes.get(id) as DesktopInfo).endAt = new Date(Date.now() + timeoutMs);
      return boxFor(id);
    },
  };
  return { driver, calls, boxes };
}

let db: Store;
let owners = 0;
before(async()=>{
  pool=createPostgresPool(url!,logger as any);records=new PostgresStore(pool,logger as any);await records.initializeSchema();
  db=new Store(records as any);storageDir=await mkdtemp(join(tmpdir(),'roomtalk-desktop-test-'));storage=new LocalMediaObjectStorage(storageDir,logger as any);
  for(let index=1;index<=100;index++){const clientId=`${prefix}-${index}`;await records.createPasswordAccountForClient({clientId,accountId:clientId,now:new Date().toISOString()});await records.ensurePersonalAgentProfile(clientId);}
});
after(async()=>{if(pool){const owners=Array.from({length:100},(_,index)=>`${prefix}-${index+1}`);await pool.query('DELETE FROM rooms WHERE creator_id=ANY($1::text[])',[owners]);await pool.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[owners]);await pool.end?.();}if(storageDir)await rm(storageDir,{recursive:true,force:true});});
// Each test gets a fresh owner so leases and receipts never leak between tests.
function service(f: ReturnType<typeof fake>) {
  const owner = `${prefix}-${++owners}`;
  const ownerLabels = computerIdentity(config, owner).labels;
  for (const info of f.boxes.values())
    if (info.metadata["dev.openmuse.owner"] === labels["dev.openmuse.owner"])
      info.metadata = { ...info.metadata, ...ownerLabels };
  const desktop = new E2BDesktopComputer(config, f.driver);
  return {
    owner,
    labels: ownerLabels,
    desktop,
    computer: new ComputerService(db, config, storage, undefined, desktop),
    // A second API process (or a restarted one) with no cached sandbox handle.
    restarted: () =>
      new ComputerService(db, config, storage, undefined, new E2BDesktopComputer(config, f.driver)),
  };
}

test("start creates one desktop per owner with pause-on-idle and prepares /workspace", async () => {
  const f = fake();
  const { computer, owner, labels: own } = service(f);
  const before = await computer.snapshot(owner);
  assert.equal(before.status, "stopped");
  assert.equal(before.provider, "e2b-desktop");
  assert.equal(before.network, "enabled");
  const started = await computer.start(owner);
  assert.equal(started.status, "running");
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.create[0].template, "desktop");
  assert.deepEqual(f.calls.create[0].metadata, own);
  assert.ok(f.calls.setup.some((s) => s.user === "root" && s.command.includes("/workspace")));
  assert.deepEqual(f.calls.files, ["/opt/openmuse/files.py"]);
  assert.ok(f.calls.setup.some((s) => s.user === "user" && s.command.includes("startxfce4")));
  await computer.execute(owner, { command: "pwd" });
  assert.ok(!JSON.stringify(f.calls).includes(apiKey), "the API key never enters the sandbox");
});

test("a paused desktop reports stopped and start resumes it without creating another", async () => {
  const f = fake({ boxes: [{ state: "paused" }] });
  const { computer, owner } = service(f);
  assert.equal((await computer.snapshot(owner)).status, "stopped");
  assert.equal((await computer.start(owner)).status, "running");
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.connect.length, 1);
  // The cold-booted VM lost its desktop session, so start relaunches it.
  assert.ok(f.calls.setup.some((s) => s.command.includes("startxfce4")));
});

test("stop pauses without connecting, which would resume the box", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  assert.equal((await computer.stop(owner)).status, "stopped");
  assert.deepEqual(f.calls.pause, ["sbx-1"]);
  assert.equal(f.calls.connect.length, 0);
  await assert.rejects(computer.execute(owner, { command: "pwd" }), /Start the computer/);
});

test("attaching fails closed on duplicates, foreign metadata, template or lifecycle", async () => {
  for (const boxes of [
    [{}, { sandboxId: "second" }],
    [{ name: "other-template", templateId: "other-id" }],
    [{ metadataExtra: true }],
    [{ lifecycle: { onTimeout: "kill", autoResume: false } }],
    [{ lifecycle: { onTimeout: "pause", autoResume: true } }],
  ] as Partial<DesktopInfo & { metadataExtra: boolean }>[][]) {
    const f = fake({ boxes });
    const { computer, owner } = service(f);
    for (const info of f.boxes.values())
      if ((info as { metadataExtra?: boolean }).metadataExtra)
        info.metadata = { ...info.metadata, extra: "x" };
    const snapshot = await computer.snapshot(owner);
    assert.equal(snapshot.status, "error");
    assert.match(snapshot.message ?? "", /refusing to attach/);
    await assert.rejects(computer.execute(owner, { command: "pwd" }), /refusing to attach/);
    await assert.rejects(computer.start(owner), /refusing to attach/);
    assert.equal(f.calls.run.length, 0);
    assert.equal(f.calls.create.length, 0);
  }
});

test("commands run as the desktop user in /workspace with DISPLAY and the 30 second wrapper", async () => {
  const f = fake({
    boxes: [{}],
    run: (_command, options) => {
      options.onStdout("partial");
      options.onStderr("bad input");
      return 3;
    },
  });
  const { computer, owner } = service(f);
  const command = "printf '$HOME'; exit 3; $(touch /x) '; touch /y #";
  const result = await computer.execute(owner, { command, cwd: "/workspace/notes" });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "partial");
  assert.equal(result.stderr, "bad input");
  const call = f.calls.run[0];
  assert.equal(call.command, desktopCommand(command));
  assert.equal(call.options.user, "user");
  assert.equal(call.options.cwd, "/workspace/notes");
  assert.equal(call.options.envs.DISPLAY, ":0");
  assert.equal(call.options.timeoutMs, 35000);
  assert.equal(f.calls.pause.length, 0);
});

test("the in-box wrapper keeps quoting, exit codes and does not wait for background apps", {
  skip: process.platform === "win32" && "needs /bin/bash",
}, () => {
  // Drop the GNU timeout prefix so the wrapper runs on any POSIX host.
  const local = (command: string) =>
    desktopCommand(command, 16).replace("/usr/bin/timeout --signal=TERM --kill-after=2s 30s ", "");
  const quoted = spawnSync(
    "/bin/bash",
    ["-c", local(`printf '%s' "it's"; echo oops >&2; exit 3`)],
    {
      encoding: "utf8",
    },
  );
  assert.equal(quoted.status, 3);
  assert.equal(quoted.stdout, "it's");
  assert.equal(quoted.stderr, "oops\n");
  const started = Date.now();
  const background = spawnSync("/bin/bash", ["-c", local("sleep 5 & echo started")], {
    encoding: "utf8",
  });
  assert.equal(background.stdout, "started\n");
  assert.ok(Date.now() - started < 3000, "a background process kept the command open");
  const big = spawnSync("/bin/bash", ["-c", local("printf '%040d' 0")], { encoding: "utf8" });
  assert.equal(big.stdout.length, 17, "output is capped in the box at limit + 1 bytes");
  // A runaway writer is stopped once its temporary files pass the disk ceiling.
  const runaway = spawnSync(
    "/bin/bash",
    ["-c", desktopCommand("yes", 16, 1024 * 1024).replace(/\/usr\/bin\/timeout \S+ \S+ 30s /, "")],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(runaway.status, 143);
  assert.equal(runaway.stdout.length, 17);
  assert.match(runaway.stderr, /Output exceeded the limit/);
});

test("exit 124 is timed_out and leaves the box running, like Docker", async () => {
  const f = fake({ boxes: [{}], run: () => 124 });
  const { computer, owner } = service(f);
  assert.equal((await computer.execute(owner, { command: "sleep 40" })).status, "timed_out");
  assert.equal(f.calls.pause.length, 0);
  assert.equal((await computer.snapshot(owner)).status, "running");
});

test("only a deadline TimeoutError is timed_out; any other stream loss is interrupted", async () => {
  for (const [error, status] of [
    [new TimeoutError("[deadline_exceeded] the operation timed out"), "timed_out"],
    [new TimeoutError("[unavailable] connection reset"), "interrupted"],
    [new Error("socket hang up"), "interrupted"],
  ] as const) {
    const f = fake({
      boxes: [{}],
      run: () => {
        throw error;
      },
    });
    const { computer, owner } = service(f);
    assert.equal((await computer.execute(owner, { command: "sleep 99" })).status, status);
    // An unknown command may still run: the whole sandbox is paused.
    assert.deepEqual(f.calls.pause, ["sbx-1"]);
    assert.equal((await computer.snapshot(owner)).status, "stopped");
  }
});

test("a missing working directory fails the command without stopping the computer", async () => {
  const f = fake({
    boxes: [{}],
    startError: new InvalidArgumentError(
      "[invalid_argument] cwd '/workspace/missing' does not exist",
    ),
  });
  const { computer, owner } = service(f);
  const result = await computer.execute(owner, { command: "pwd", cwd: "/workspace/missing" });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 126);
  assert.match(result.stderr, /working directory/);
  assert.equal(f.calls.pause.length, 0);
});

test("output is capped like Docker and a runaway writer is killed past the hard ceiling", async () => {
  const capped = fake({
    boxes: [{}],
    run: (_c, o) => {
      o.onStdout("x".repeat(200 * 1024));
      return 0;
    },
  });
  const first = service(capped);
  const receipt = await first.computer.execute(first.owner, { command: "yes | head" });
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.truncated, true);
  assert.ok(Buffer.byteLength(receipt.stdout) <= 128 * 1024);
  assert.equal(capped.calls.kills, 0);
  const runaway = fake({
    boxes: [{}],
    run: async (_c, o, handle) => {
      while (!handle.kills) {
        o.onStdout("y".repeat(256 * 1024));
        await new Promise((resolve) => setImmediate(resolve));
      }
      return -1;
    },
  });
  const second = service(runaway);
  const killed = await second.computer.execute(second.owner, { command: "yes" });
  assert.equal(killed.truncated, true);
  assert.equal(killed.status, "failed");
  assert.match(killed.stderr, /Output exceeded the limit/);
  assert.ok(runaway.calls.kills >= 1);
});

test("abort is honoured even when it fired before the listener was registered", async () => {
  const f = fake({ boxes: [{}] });
  const desktop = new E2BDesktopComputer(config, f.driver);
  const result = await desktop.run(labels, "true", {
    timeoutMs: 1000,
    signal: AbortSignal.abort(),
  });
  assert.equal(result.interrupted, true);
  assert.equal(f.calls.run.length, 0);
  const controller = new AbortController();
  const g = fake({
    boxes: [{}],
    run: () => new Promise<number>(() => controller.abort()),
  });
  const { computer, owner } = service(g);
  const receipt = await computer.execute(
    owner,
    { command: "sleep 30" },
    { signal: controller.signal },
  );
  assert.equal(receipt.status, "interrupted");
  assert.equal(g.calls.run[0].options.signal, controller.signal);
  assert.equal(g.calls.kills, 1);
  assert.deepEqual(g.calls.pause, ["sbx-1"]);
});

test("file operations send their request on stdin in chunks, never in argv or /workspace", async () => {
  const f = fake({
    boxes: [{}],
    run: (_c, o) => {
      o.onStdout(JSON.stringify({ path: "/workspace/doc.pdf" }));
      return 0;
    },
  });
  const { computer, owner } = service(f);
  const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(3 * 1024 * 1024)]);
  assert.deepEqual(await computer.writePdf(owner, "/workspace/doc.pdf", pdf), {
    path: "/workspace/doc.pdf",
  });
  const call = f.calls.run[0];
  // About 4 MB of JSON: the in-box limit grows by a second per MB sent over stdin.
  assert.equal(
    call.command,
    "/usr/bin/timeout --kill-after=1s 13s /usr/bin/python3 -I /opt/openmuse/files.py",
  );
  assert.equal(call.options.timeoutMs, 15000);
  assert.equal(call.options.stdin, true);
  assert.ok(f.calls.stdin.length > 1);
  assert.equal(
    JSON.parse(Buffer.concat(f.calls.stdin).toString("utf8")).path,
    "/workspace/doc.pdf",
  );
  assert.equal(f.calls.closed, 1);
});

test("chunked file writes preserve Unicode across stdin boundaries", async () => {
  const path = "/workspace/report.txt";
  const f = fake({
    boxes: [{}],
    run: (_command, options) => {
      options.onStdout(JSON.stringify({ path }));
      return 0;
    },
  });
  const { computer, owner } = service(f);
  // JSON escaping can make a valid sub-256 KiB text file span multiple stdin chunks.
  const boundary = 1024 * 1024;
  const prefix = JSON.stringify({ operation: "write", path, text: "" }).length - 2;
  const padding = boundary - 1 - prefix;
  const text = `${"\u0001".repeat(Math.floor(padding / 6))}${"a".repeat(padding % 6)}😀中文`;
  assert.ok(Buffer.byteLength(text) < 256 * 1024);
  await computer.write(owner, path, text);
  const request = JSON.parse(Buffer.concat(f.calls.stdin).toString("utf8"));
  assert.ok(request.text === text, "stdin encoding corrupted the file's Unicode content");
  assert.equal(f.calls.stdin.length, 2);
  assert.ok(f.calls.stdin.every((chunk) => chunk.byteLength <= boundary));
  assert.equal(f.calls.closed, 1);
});

test("provider failures surface as the app's own 503, not SDK errors", async () => {
  const f = fake({ listFails: true });
  const { computer, owner } = service(f);
  const snapshot = await computer.snapshot(owner);
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.message ?? "", /E2B desktop operation failed/);
  await assert.rejects(computer.start(owner), { status: 503 });
});

test("the desktop stream URL is reused while serving and needs a running computer", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  const first = await computer.desktopUrl(owner);
  const second = await computer.desktopUrl(owner);
  assert.equal(second.url, first.url);
  assert.deepEqual(f.calls.streams, [undefined, first.url]);
  await computer.stop(owner);
  await assert.rejects(computer.desktopUrl(owner), /Start the computer/);
  const docker = new ComputerService(db, base, storage);
  await assert.rejects(docker.desktopUrl(owner), /no desktop/);
});

test("agent instructions stay provider-neutral and mention the desktop only when it exists", () => {
  assert.match(computerInstructions(), /Docker Linux container/);
  assert.doesNotMatch(computerInstructions(), /desktop tab/i);
  const desktop = computerInstructions("e2b-desktop");
  assert.match(desktop, /graphical Xfce desktop/);
  assert.match(desktop, /Desktop tab/);
  assert.doesNotMatch(desktop, /E2B|Docker/);
});

test("a Stop between find and use fails the operation instead of resuming the box", async () => {
  let pauseNext = false;
  const f = fake({
    boxes: [{}],
    afterInfo: (id) => {
      if (!pauseNext) return;
      pauseNext = false;
      void f.driver.pause(id);
    },
  });
  const { computer, owner } = service(f);
  await computer.start(owner);
  assert.equal(f.calls.connect.length, 1);
  for (const operation of [
    () => computer.execute(owner, { command: "pwd" }),
    () => computer.desktopUrl(owner),
  ]) {
    await computer.start(owner);
    pauseNext = true;
    const outcome = await operation().catch((error: Error) => error);
    assert.match(
      JSON.stringify(outcome, Object.getOwnPropertyNames(outcome)),
      /Start the computer/,
    );
    // The cached handle refreshes the timeout, which fails on a paused box; no connect.
    assert.equal(f.boxes.get("sbx-1")?.state, "paused");
    assert.equal((await computer.snapshot(owner)).status, "stopped");
  }
  // Connects: the first start, then the start that resumed the paused box. A start on
  // a running box reuses its handle.
  assert.equal(f.calls.connect.length, 2);
});

test("a fresh process connects once and never pauses a missing desktop session", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner, restarted } = service(f);
  await computer.start(owner);
  const second = restarted();
  await second.execute(owner, { command: "pwd" });
  await second.execute(owner, { command: "pwd" });
  assert.equal(f.calls.connect.length, 2, "the second process connected once, then reused it");
  assert.equal(f.calls.connect[1].timeoutMs, 15 * 60_000);
  // Paused right after getInfo: connect resumes it cold, without Xfce, so it is paused again.
  let once = true;
  const g = fake({
    boxes: [{}],
    afterInfo: (id) => {
      if (once) void g.driver.pause(id);
      once = false;
    },
  });
  const raced = service(g);
  await assert.rejects(raced.computer.desktopUrl(raced.owner), /Start the computer/);
  assert.equal(g.calls.connect.length, 0);
  assert.deepEqual(g.calls.pause, ["sbx-1"]);
  assert.equal(g.boxes.get("sbx-1")?.state, "paused");
});

test("opening the desktop keeps the box awake longer and commands never shorten it", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  await computer.start(owner);
  await computer.desktopUrl(owner);
  await computer.execute(owner, { command: "pwd" });
  const [desktop, command] = f.calls.keepAlive;
  assert.ok(desktop > 29 * 60_000 && desktop <= 30 * 60_000, String(desktop));
  assert.ok(command > 29 * 60_000, "a command must not cut the desktop's timeout to 15 minutes");
});

test("fresh and cached workers preserve the desktop deadline set by the API", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner, restarted } = service(f);
  const worker = restarted();
  await worker.execute(owner, { command: "pwd" });
  await computer.desktopUrl(owner);
  const deadline = (f.boxes.get("sbx-1") as DesktopInfo).endAt.getTime();

  // A new process must preserve the deadline when connecting for the first time.
  await restarted().execute(owner, { command: "id" });
  assert.ok((f.calls.connect.at(-1)?.timeoutMs ?? 0) > 29 * 60_000);
  assert.ok((f.boxes.get("sbx-1") as DesktopInfo).endAt.getTime() >= deadline);

  // A worker with an older cached handle must also use the API's latest deadline.
  await worker.execute(owner, { command: "id" });
  assert.ok((f.calls.keepAlive.at(-1) ?? 0) > 29 * 60_000);
  assert.ok((f.boxes.get("sbx-1") as DesktopInfo).endAt.getTime() >= deadline);
  await worker.start(owner);
  assert.ok((f.boxes.get("sbx-1") as DesktopInfo).endAt.getTime() >= deadline);
});

test("Stop then Start resets the timeout instead of retaining the old desktop deadline", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  await computer.desktopUrl(owner);
  await computer.stop(owner);
  await computer.start(owner);
  assert.equal(f.calls.connect.at(-1)?.timeoutMs, 15 * 60_000);
});

test("the desktop URL is served while a command runs and never takes the lease", async () => {
  let release: (() => void) | undefined;
  const f = fake({
    boxes: [{}],
    run: () =>
      new Promise<number>((resolve) => {
        release = () => resolve(0);
      }),
  });
  const { computer, owner } = service(f);
  await computer.desktopUrl(owner);
  const pending = computer.execute(owner, { command: "sleep 5" });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.match((await computer.desktopUrl(owner)).url, /password=/);
  release();
  assert.equal((await pending).status, "succeeded");
});

test("concurrent viewers share one stream start", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fake({ boxes: [{}], streamGate: () => gate });
  const { computer, owner } = service(f);
  const viewers = [computer.desktopUrl(owner), computer.desktopUrl(owner)];
  while (!f.calls.streams.length) await new Promise((resolve) => setImmediate(resolve));
  release?.();
  const [first, second] = await Promise.all(viewers);
  assert.equal(second.url, first.url);
  assert.equal(f.calls.streams.length, 1);
  // The next request checks the stream again instead of reusing the settled promise.
  await computer.desktopUrl(owner);
  assert.deepEqual(f.calls.streams, [undefined, first.url]);
});

test("desktop receipts are kept apart from Docker receipts", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  await db.put(owner, "computer-commands", {
    id: "docker-run",
    command: "id",
    cwd: "/workspace",
    status: "succeeded",
    stdout: "uid=1000(node)",
    stderr: "",
    truncated: false,
    startedAt: new Date().toISOString(),
  });
  const receipt = await computer.execute(owner, { command: "pwd" });
  assert.deepEqual(
    (await computer.snapshot(owner)).commands.map((c) => c.id),
    [receipt.id],
  );
  assert.equal(await db.get(owner, "computer-commands", receipt.id), null);
  const docker = new ComputerService(db, base, storage);
  assert.deepEqual(
    (await docker.snapshot(owner)).commands.map((c) => c.id),
    ["docker-run"],
  );
});

test("each desktop action maps to one xdotool call; coordinates and keys are validated", () => {
  const input = (raw: unknown) => desktopInput(desktopActionSchema.parse(raw));
  assert.equal(input({ action: "screenshot" }), undefined);
  assert.equal(
    input({ action: "left_click", coordinate: [640, 400] }),
    "xdotool mousemove --sync 640 400 click 1",
  );
  assert.equal(input({ action: "left_click" }), "xdotool click 1");
  assert.equal(
    input({ action: "double_click", coordinate: [0, 0] }),
    "xdotool mousemove --sync 0 0 click --repeat 2 --delay 120 1",
  );
  assert.equal(
    input({ action: "right_click", coordinate: [5, 6] }),
    "xdotool mousemove --sync 5 6 click 3",
  );
  assert.equal(input({ action: "mouse_move", coordinate: [7, 8] }), "xdotool mousemove --sync 7 8");
  assert.equal(
    input({ action: "type", text: "it's 1" }),
    `xdotool type --delay 12 -- 'it'\\''s 1'`,
  );
  assert.equal(input({ action: "key", text: "ctrl+l Return" }), "xdotool key -- 'ctrl+l' 'Return'");
  assert.equal(
    input({ action: "scroll", coordinate: [10, 20], scroll_direction: "up", scroll_amount: 5 }),
    "xdotool mousemove --sync 10 20 click --repeat 5 4",
  );
  assert.equal(input({ action: "scroll", scroll_direction: "down" }), "xdotool click --repeat 3 5");
  assert.equal(input({ action: "wait", duration: 2 }), "sleep 2");
  for (const bad of [
    { action: "mouse_move" },
    { action: "type" },
    { action: "key", text: "ctrl+l; rm -rf /" },
    { action: "scroll" },
    { action: "left_click", coordinate: [1280, 10] },
    { action: "left_click", coordinate: [10] },
    { action: "drag" },
  ])
    assert.equal(desktopActionSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test("a desktop action runs with a screenshot after it, leaves a receipt and keeps the image", async () => {
  const f = fake({ boxes: [{}] });
  const { computer, owner } = service(f);
  const shot = await computer.desktopAction(owner, {
    action: "left_click",
    coordinate: [640, 400],
  });
  const script = f.calls.setup.find((call) => call.command.includes("click 1"));
  assert.equal(script?.user, "user");
  assert.match(
    script?.command ?? "",
    /^xdotool keyup Shift_L .*\nxdotool mousemove --sync 640 400 click 1 \|\| exit 3$/,
  );
  assert.deepEqual(f.calls.reads, ["/tmp/openmuse-screenshot.jpg"]);
  assert.equal(shot.mimeType, "image/jpeg");
  assert.equal(shot.data, Buffer.from(jpeg).toString("base64"));
  assert.deepEqual([shot.width, shot.height], [1280, 800]);
  assert.equal(shot.receipt.command, "desktop left_click (640, 400)");
  assert.equal(shot.receipt.status, "succeeded");
  assert.deepEqual((await computer.snapshot(owner)).commands, []);
  assert.deepEqual(
    (await db.list<ComputerCommand>(owner, "computer-desktop-actions")).map((c) => c.id),
    [shot.receipt.id],
  );
  assert.deepEqual((await computer.latestScreenshot(owner)).bytes, Buffer.from(jpeg));
  const stored = await db.get<{data?:string;blob:string}>(owner, "computer-desktop-screens", "latest");
  assert.equal(stored?.data, undefined);
  assert.match(String(stored?.blob), /\.jpg$/);
  // A plain screenshot sends no input.
  await computer.desktopAction(owner, { action: "screenshot" });
  assert.match(f.calls.setup.at(-1)?.command ?? "", /^scrot --pointer/);
});

test("a failed screenshot is reported and recorded; a stopped box is never resumed", async () => {
  const f = fake({ boxes: [{}], setupExit: (command) => (command.includes("scrot") ? 4 : 0) });
  const { computer, owner } = service(f);
  await assert.rejects(computer.desktopAction(owner, { action: "screenshot" }), {
    message: "The desktop screenshot failed",
  });
  assert.equal(
    (await db.list<ComputerCommand>(owner, "computer-desktop-actions"))[0]?.status,
    "failed",
  );
  const g = fake({ boxes: [{ state: "paused" }] });
  const paused = service(g);
  await assert.rejects(paused.computer.desktopAction(paused.owner, { action: "screenshot" }), {
    status: 409,
  });
  assert.equal(g.calls.connect.length, 0, "no implicit resume");
  assert.equal(g.boxes.get("sbx-1")?.state, "paused");
  assert.deepEqual((await paused.computer.snapshot(paused.owner)).commands, []);
  await assert.rejects(paused.computer.latestScreenshot(paused.owner), { status: 404 });
  await assert.rejects(new ComputerService(db, base, storage).desktopAction(owner, {}), /no desktop/);
});

// Models the root cause: Sandbox.create puts DISPLAY in the sandbox env, and a resumed
// box comes back without it, so an X11 call without its own DISPLAY fails.
test("X11 calls set DISPLAY themselves, so actions work on a resumed box", async () => {
  const sdkCalls: { command: string; envs?: Record<string, string> }[] = [];
  class Sandbox {
    commands = {
      run: async (command: string, opts: { envs?: Record<string, string> }) => {
        sdkCalls.push({ command, envs: opts.envs });
        if (opts.envs?.DISPLAY !== ":0")
          throw new CommandExitError({
            exitCode: 1,
            error: "exit status 1",
            stdout: "",
            stderr: "scrot: Can't open X display",
          });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    files = { read: async () => jpeg };
    static async connect() {
      return new Sandbox();
    }
  }
  const sdk = { Sandbox, CommandExitError } as unknown as Awaited<
    ReturnType<NonNullable<Parameters<typeof e2bDesktopDriver>[1]>>
  >;
  const f = fake({ boxes: [{}] });
  const driver = { ...f.driver, connect: e2bDesktopDriver(config, async () => sdk).connect };
  const desktop = new E2BDesktopComputer(config, driver);
  const owner = `${prefix}-${++owners}`;
  const ownerLabels = computerIdentity(config, owner).labels;
  (f.boxes.get("sbx-1") as DesktopInfo).metadata = ownerLabels;
  const shot = await desktop.act(ownerLabels, { action: "type", text: "hello" });
  assert.deepEqual(shot.image, jpeg);
  const x11 = sdkCalls.filter((call) => /xdotool|scrot/.test(call.command));
  assert.ok(x11.length > 0);
  assert.ok(x11.every((call) => call.envs?.DISPLAY === ":0"));
});

test("a desktop action runs while a stream refresh is in flight", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fake({ boxes: [{}], streamGate: () => gate });
  const { computer, owner } = service(f);
  const url = computer.desktopUrl(owner);
  while (!f.calls.streams.length) await new Promise((resolve) => setImmediate(resolve));
  // The viewer's stream start is still pending; the agent's step does not wait for it.
  const action = await computer.desktopAction(owner, { action: "screenshot" });
  assert.equal(action.receipt.status, "succeeded");
  release?.();
  assert.match((await url).url, /password=/);
});

test("a fresh desktop viewer cannot connect during another process's startup", async () => {
  const f = fake({ boxes: [{}] });
  const { owner, restarted } = service(f);
  await db.put(owner, "computer-state", {
    id: "lease",
    token: "starting",
    expiresAt: Date.now() + 60000,
    stopping: false,
    operation: "operation",
  });
  await assert.rejects(restarted().desktopUrl(owner), /Computer is busy/);
  assert.equal(f.calls.connect.length, 0);
  assert.deepEqual(f.calls.pause, []);
});

test("a logged-out desktop is unavailable without pausing running apps", async () => {
  const f = fake({
    boxes: [{}],
    setupExit: (command) => (command === "pgrep -x xfce4-session >/dev/null" ? 1 : 0),
  });
  const { computer, owner } = service(f);
  await assert.rejects(computer.desktopUrl(owner), /desktop session is unavailable/);
  assert.deepEqual(f.calls.pause, []);
  assert.equal(f.boxes.get("sbx-1")?.state, "running");
});

test("PDF exports budget for the response size as well as the small request", async () => {
  const f = fake({
    boxes: [{}],
    run: (_command, options) => {
      options.onStdout(JSON.stringify({ path: "/workspace/doc.pdf", base64: "JVBERi0=" }));
      return 0;
    },
  });
  const { computer, owner } = service(f);
  await computer.pdfBytes(owner, "/workspace/doc.pdf");
  assert.match(f.calls.run[0].command, /23s/);
  assert.equal(f.calls.run[0].options.timeoutMs, 25000);
});

test("transient keepAlive errors remain provider failures on a running computer", async () => {
  const f = fake({ boxes: [{}], keepAliveError: new Error("rate limited") });
  const { computer, owner } = service(f);
  await computer.start(owner);
  await assert.rejects(computer.desktopUrl(owner), { status: 503 });
  assert.equal((await computer.snapshot(owner)).status, "running");
  assert.equal(f.calls.connect.length, 1);
});

test("file attachment failures retain their provider error instead of a path error", async () => {
  const f = fake({ boxes: [{}], keepAliveError: new Error("network failed") });
  const { computer, owner } = service(f);
  await computer.start(owner);
  await assert.rejects(computer.read(owner, "/workspace/doc.txt"), { status: 503 });
  assert.equal(f.calls.run.length, 0);
});

test("delivered input remains succeeded when the screenshot fails", async () => {
  const f = fake({ boxes: [{}], setupExit: (command) => (command.includes("scrot") ? 4 : 0) });
  const { computer, owner } = service(f);
  const shot = await computer.desktopAction(owner, { action: "key", text: "Return" });
  assert.equal(shot.receipt.status, "succeeded");
  assert.equal(shot.data, "");
  assert.match(shot.warning ?? "", /Action performed.*before retrying/);
  assert.equal(
    (await db.list<ComputerCommand>(owner, "computer-desktop-actions"))[0].status,
    "succeeded",
  );
});

test("a delivered input with a lost response returns a durable uncertain receipt without replay", async () => {
  for (const action of [{ action: "left_click" }, { action: "key", text: "Return" }]) {
    for (const error of [
      new Error("transport disconnected"),
      new TimeoutError("deadline exceeded"),
    ]) {
      let applied = 0;
      let owner: string;
      const f = fake({
        boxes: [{}],
        setupEffect: async (command) => {
          if (!command.startsWith("xdotool ") || !command.includes("|| exit 3")) return;
          const [intent] = await db.list<ComputerCommand>(owner, "computer-desktop-actions");
          assert.equal(intent.status, "interrupted", "uncertain intent is durable before dispatch");
          applied++;
          throw error;
        },
      });
      const serviceUnderTest = service(f);
      owner = serviceUnderTest.owner;
      const tool = desktopTools(
        serviceUnderTest.computer,
        {} as Parameters<typeof desktopTools>[1],
        owner,
        "scope",
      ).find((candidate) => candidate.name === "use_desktop");
      const execute = tool?.execute as (
        args: unknown,
      ) => Promise<{ type: string; content?: string }[]>;
      const result = await execute({ ...action, operationId: "uncertain-input" });
      const text = JSON.parse(result[0].content ?? "{}");
      assert.equal(applied, 1, "the provider must never replay uncertain input");
      assert.equal(text.status, "interrupted");
      assert.equal(text.error, undefined);
      const repeated = JSON.parse(
        (await execute({ ...action, operationId: "uncertain-input" }))[0].content ?? "{}",
      );
      assert.equal(repeated.receiptId, text.receiptId);
      assert.equal(repeated.status, "interrupted");
      assert.equal(applied, 1, "a repeated tool call must not dispatch uncertain input again");
      assert.match(
        text.warning,
        /outcome is unknown.*before repeating.*do not automatically retry/,
      );
      const receipt = await db.get<ComputerCommand>(
        owner,
        "computer-desktop-actions",
        text.receiptId,
      );
      assert.equal(receipt?.status, "interrupted");
      assert.equal(receipt?.exitCode, undefined);
      assert.match(receipt?.stderr ?? "", /outcome is unknown/);
      assert.equal(f.calls.reads.length, 1, "only a fresh screenshot follows uncertain input");
    }
  }
});

test("repeating a desktop operation ID returns its receipt without sending the input twice", async () => {
  let applied = 0;
  const f = fake({
    boxes: [{}],
    setupEffect(command) {
      if (command.startsWith("xdotool ") && command.includes("|| exit 3")) applied++;
    },
  });
  const { computer, owner, restarted } = service(f);
  const action = { action: "key", text: "Return", operationId: "submit-once" };
  const tool = desktopTools(
    computer,
    {} as Parameters<typeof desktopTools>[1],
    owner,
    "chat:one",
  ).find((candidate) => candidate.name === "use_desktop");
  const execute = tool?.execute as (args: unknown) => Promise<{ type: string; content?: string }[]>;
  const first = JSON.parse((await execute(action))[0].content ?? "{}");
  const retry = desktopTools(
    restarted(),
    {} as Parameters<typeof desktopTools>[1],
    owner,
    "chat:one",
  ).find((candidate) => candidate.name === "use_desktop");
  const retryExecute = retry?.execute as (
    args: unknown,
  ) => Promise<{ type: string; content?: string }[]>;
  const second = JSON.parse((await retryExecute(action))[0].content ?? "{}");
  assert.equal(applied, 1, "a repeated model tool call must not press Return again");
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(second.status, "succeeded");

  const changed = await retryExecute({ action: "key", text: "space", operationId: "submit-once" });
  assert.match(JSON.stringify(changed), /already belongs to a different desktop action/);
  assert.equal(applied, 1);

  const common = "x".repeat(205);
  await execute({ action: "type", text: `${common}A`, operationId: "long-text" });
  const hiddenChange = await retryExecute({
    action: "type",
    text: `${common}B`,
    operationId: "long-text",
  });
  assert.match(JSON.stringify(hiddenChange), /already belongs to a different desktop action/);
  assert.equal(
    applied,
    2,
    "the full text must be bound even though the receipt label truncates it",
  );
});

test("partially delivered input with a nonzero exit stays uncertain without replay", async () => {
  for (const action of [{ action: "key", text: "Return ctrl-l" }, { action: "double_click" }]) {
    for (const screenshotFails of [false, true]) {
      let applied = 0;
      let owner: string;
      const isInput = (command: string) =>
        command.startsWith("xdotool ") && command.includes("|| exit 3");
      const f = fake({
        boxes: [{}],
        setupEffect: async (command) => {
          if (!isInput(command)) return;
          const [intent] = await db.list<ComputerCommand>(owner, "computer-desktop-actions");
          assert.equal(intent.status, "interrupted", "intent is durable before any input");
          applied++; // Return submits, or the first click lands, before xdotool fails.
        },
        setupExit: (command) =>
          isInput(command) ? 3 : screenshotFails && command.includes("scrot") ? 4 : 0,
      });
      const serviceUnderTest = service(f);
      owner = serviceUnderTest.owner;
      const tool = desktopTools(
        serviceUnderTest.computer,
        {} as Parameters<typeof desktopTools>[1],
        owner,
        "scope",
      ).find((candidate) => candidate.name === "use_desktop");
      const execute = tool?.execute as (
        args: unknown,
      ) => Promise<{ type: string; content?: string }[]>;
      const result = await execute({ ...action, operationId: "partial-input" });
      assert.equal(applied, 1, "partially delivered input must not be replayed");
      const [persisted] = await db.list<ComputerCommand>(owner, "computer-desktop-actions");
      assert.equal(persisted.status, "interrupted", "a nonzero exit cannot undo delivered input");
      assert.ok(Array.isArray(result), JSON.stringify(result));
      const text = JSON.parse(result[0].content ?? "{}");
      assert.equal(text.status, "interrupted");
      assert.equal(text.error, undefined);
      assert.match(
        text.warning,
        /outcome is unknown.*before repeating.*do not automatically retry/,
      );
      const receipt = await db.get<ComputerCommand>(
        owner,
        "computer-desktop-actions",
        text.receiptId,
      );
      assert.equal(receipt?.status, "interrupted");
      assert.equal(receipt?.exitCode, undefined);
      assert.match(receipt?.stderr ?? "", /outcome is unknown.*do not automatically retry/);
      assert.equal(f.calls.setup.filter((call) => call.command.includes("scrot")).length, 1);
      assert.equal(
        result.some((content) => content.type === "image"),
        !screenshotFails,
      );
      if (!screenshotFails)
        assert.deepEqual(
          (await serviceUnderTest.restarted().latestScreenshot(owner, text.receiptId)).bytes,
          Buffer.from(jpeg),
        );
    }
  }
});

test("commands and files reuse the verified inspection instead of finding twice", async () => {
  const f = fake({
    boxes: [{}],
    run: (_command, options) => {
      options.onStdout('{"text":"ok"}');
      return 0;
    },
  });
  const { computer, owner } = service(f);
  await computer.start(owner);
  for (const operation of [
    () => computer.execute(owner, { command: "true" }),
    () => computer.read(owner, "/workspace/doc.txt"),
  ]) {
    const lists = f.calls.lists,
      infos = f.calls.infos;
    await operation();
    assert.equal(f.calls.lists - lists, 1);
    assert.equal(f.calls.infos - infos, 1);
  }
});

});
