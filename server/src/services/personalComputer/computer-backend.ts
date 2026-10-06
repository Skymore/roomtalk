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

// Ported from OpenMuse computer-backend.ts at 73a7149.
import { z } from "openmuse-zod";
import {
  type ComputerState,
  computerIdentity,
  type DockerResult,
  type DockerRunner,
} from "./computer";
import { desktopCommand, type E2BDesktopComputer } from "./computer-e2b-desktop";
import type { ComputerProvider, Config } from "./config";
import { AppError } from "./errors";

export interface ComputerSession {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<DockerResult>;
  file(input: string, seconds: number, maxOutputBytes: number): Promise<DockerResult>;
  stop(): Promise<void>;
}
export interface ComputerBackend {
  provider: ComputerProvider;
  receipts: string;
  network: "enabled" | "disabled";
  state(owner: string): Promise<ComputerState>;
  start(owner: string): Promise<void>;
  stop(owner: string): Promise<void>;
  running(owner: string): Promise<ComputerSession>;
}
const controlTimeout = 10000;
const stopped = () => new AppError("Start the computer before using its terminal or files", 409);
const inspectionSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Config: z.object({
    Image: z.string(),
    User: z.string(),
    Labels: z.record(z.string(), z.string()).nullable(),
    Env: z.array(z.string()),
    Entrypoint: z.array(z.string()).nullable(),
    Cmd: z.array(z.string()).nullable(),
    WorkingDir: z.string(),
  }),
  HostConfig: z.object({
    ReadonlyRootfs: z.boolean(),
    Privileged: z.boolean(),
    CapDrop: z.array(z.string()).nullable(),
    CapAdd: z.array(z.string()).nullable(),
    SecurityOpt: z.array(z.string()).nullable(),
    NetworkMode: z.string(),
    Memory: z.number(),
    MemorySwap: z.number(),
    PidsLimit: z.number().nullable(),
    NanoCpus: z.number(),
    Binds: z.array(z.string()).nullable(),
    Devices: z.array(z.unknown()).nullable(),
    DeviceRequests: z.array(z.unknown()).nullable(),
    PortBindings: z.record(z.string(), z.unknown()).nullable(),
    PidMode: z.string(),
    IpcMode: z.string(),
    Tmpfs: z.record(z.string(), z.string()).nullable(),
    RestartPolicy: z.object({ Name: z.string() }),
  }),
  Mounts: z.array(
    z.object({
      Type: z.string(),
      Name: z.string().optional(),
      Destination: z.string(),
      RW: z.boolean(),
    }),
  ),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }),
  State: z.object({ Running: z.boolean() }),
});
type Inspection = z.infer<typeof inspectionSchema>;
export class DockerComputer implements ComputerBackend {
  readonly provider = "docker";
  readonly receipts = "computer-commands";
  readonly network = "disabled";
  constructor(
    private readonly config: Config,
    private readonly docker: DockerRunner,
  ) {}
  private image() {
    const image = this.config.computerImage ?? "openmuse-computer:local";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/.test(image))
      throw new AppError("COMPUTER_IMAGE is invalid", 503);
    return image;
  }
  private async checked(args: string[]) {
    const result = await this.docker(args, { timeoutMs: controlTimeout });
    if (result.timedOut)
      throw new AppError("Docker did not respond within 10 seconds. Check the Docker engine.", 503);
    if (result.interrupted || result.exitCode !== 0 || result.truncated)
      throw new AppError(
        "Docker operation failed. Check that the engine is running and the computer image is built locally.",
        503,
      );
    return result.stdout;
  }
  private async inspect(owner: string): Promise<Inspection | undefined> {
    const identity = computerIdentity(this.config, owner);
    const found = (
      await this.checked([
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${identity.container}$`,
        "--format",
        "{{.ID}}",
      ])
    ).trim();
    if (!found) return undefined;
    const raw = JSON.parse(await this.checked(["container", "inspect", identity.container]));
    const result = z.array(inspectionSchema).length(1).safeParse(raw);
    if (!result.success)
      throw new AppError("Computer isolation inspection failed; refusing to attach", 409);
    const c = result.data[0],
      h = c.HostConfig;
    const empty = (list: unknown[] | null) => !list?.length;
    const safe =
      c.Name === `/${identity.container}` &&
      c.Config.Image === this.image() &&
      c.Config.User === "1000:1000" &&
      c.Config.WorkingDir === "/workspace" &&
      Object.entries(identity.labels).every(([key, value]) => c.Config.Labels?.[key] === value) &&
      c.Config.Env.every((value) =>
        ["PATH", "HOME", "LANG", "NODE_VERSION", "YARN_VERSION"].includes(value.split("=")[0]),
      ) &&
      JSON.stringify(c.Config.Entrypoint) === '["/usr/bin/sleep"]' &&
      JSON.stringify(c.Config.Cmd) === '["infinity"]' &&
      h.ReadonlyRootfs &&
      !h.Privileged &&
      h.CapDrop?.includes("ALL") &&
      empty(h.CapAdd) &&
      h.SecurityOpt?.length === 1 &&
      h.SecurityOpt.includes("no-new-privileges") &&
      h.NetworkMode === "none" &&
      h.Memory > 0 &&
      h.Memory <= 536870912 &&
      h.MemorySwap === h.Memory &&
      h.PidsLimit !== null &&
      h.PidsLimit > 0 &&
      h.PidsLimit <= 128 &&
      h.NanoCpus > 0 &&
      h.NanoCpus <= 1000000000 &&
      empty(h.Binds) &&
      empty(h.Devices) &&
      empty(h.DeviceRequests) &&
      !Object.keys(h.PortBindings ?? {}).length &&
      h.PidMode === "" &&
      h.IpcMode === "private" &&
      h.RestartPolicy.Name === "no" &&
      Object.keys(h.Tmpfs ?? {}).length === 1 &&
      h.Tmpfs?.["/tmp"] === "rw,nosuid,nodev,noexec,size=67108864,mode=1777" &&
      c.Mounts.length === 1 &&
      c.Mounts[0].Type === "volume" &&
      c.Mounts[0].Name === identity.volume &&
      c.Mounts[0].Destination === "/workspace" &&
      c.Mounts[0].RW &&
      Object.keys(c.NetworkSettings.Networks).every((network) => network === "none");
    if (!safe)
      throw new AppError(
        "Computer ownership or isolation does not match this deployment; refusing to attach",
        409,
      );
    await this.verifyVolume(owner);
    return c;
  }
  private async verifyVolume(owner: string) {
    const identity = computerIdentity(this.config, owner);
    const parsed = z
      .array(
        z.object({
          Name: z.string(),
          Labels: z.record(z.string(), z.string()).nullable(),
          Driver: z.string(),
          Options: z.record(z.string(), z.unknown()).nullable(),
          Scope: z.string(),
        }),
      )
      .length(1)
      .safeParse(JSON.parse(await this.checked(["volume", "inspect", identity.volume])));
    if (!parsed.success) throw new AppError("Computer workspace ownership inspection failed", 409);
    const v = parsed.data[0];
    if (
      v.Name !== identity.volume ||
      v.Driver !== "local" ||
      v.Scope !== "local" ||
      Object.keys(v.Options ?? {}).length ||
      !Object.entries(identity.labels).every(([key, value]) => v.Labels?.[key] === value)
    )
      throw new AppError("Computer workspace ownership or isolation does not match", 409);
  }

  async state(owner: string): Promise<ComputerState> {
    const info = await this.inspect(owner);
    return !info ? "missing" : info.State.Running ? "running" : "stopped";
  }
  async start(owner: string) {
    const identity = computerIdentity(this.config, owner);
    const existing = await this.inspect(owner);
    if (existing) {
      if (!existing.State.Running) await this.checked(["container", "start", identity.container]);
      return;
    }
    const labels = Object.entries(identity.labels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]);
    const volume = (
      await this.checked([
        "volume",
        "ls",
        "--filter",
        `name=^${identity.volume}$`,
        "--format",
        "{{.Name}}",
      ])
    ).trim();
    if (!volume) await this.checked(["volume", "create", ...labels, identity.volume]);
    await this.verifyVolume(owner);
    await this.checked([
      "container",
      "create",
      "--pull",
      "never",
      "--name",
      identity.container,
      ...labels,
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--network",
      "none",
      "--ipc",
      "private",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "128",
      "--restart",
      "no",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777",
      "--mount",
      `type=volume,source=${identity.volume},target=/workspace`,
      "--env",
      "HOME=/workspace",
      "--env",
      "LANG=C.UTF-8",
      "--entrypoint",
      "/usr/bin/sleep",
      this.image(),
      "infinity",
    ]);
    await this.inspect(owner);
    await this.checked(["container", "start", identity.container]);
  }
  async stop(owner: string) {
    if ((await this.inspect(owner))?.State.Running)
      await this.checked([
        "container",
        "stop",
        "--time",
        "2",
        computerIdentity(this.config, owner).container,
      ]);
  }
  async running(owner: string): Promise<ComputerSession> {
    if ((await this.state(owner)) !== "running") throw stopped();
    const container = computerIdentity(this.config, owner).container;
    return {
      exec: (command, cwd, signal) =>
        this.docker(
          [
            "exec",
            "--user",
            "1000:1000",
            "--workdir",
            cwd,
            container,
            "/usr/bin/timeout",
            "--signal=TERM",
            "--kill-after=2s",
            "30s",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            command,
          ],
          { timeoutMs: 35000, signal },
        ),
      file: (input, _seconds, maxOutputBytes) =>
        this.docker(
          [
            "exec",
            "-i",
            "--user",
            "1000:1000",
            container,
            "/usr/bin/timeout",
            "--kill-after=1s",
            "8s",
            "/usr/bin/python3",
            "-I",
            "/opt/openmuse/files.py",
          ],
          { timeoutMs: 10000, input, maxOutputBytes },
        ),
      stop: async () => {
        await this.checked(["container", "stop", "--time", "2", container]);
      },
    };
  }
}

export class DesktopComputerBackend implements ComputerBackend {
  readonly provider = "e2b-desktop";
  readonly receipts = "computer-desktop-commands";
  readonly network = "enabled";
  constructor(
    private readonly config: Config,
    private readonly desktop: E2BDesktopComputer,
  ) {}
  private labels(owner: string) {
    return computerIdentity(this.config, owner).labels;
  }
  state(owner: string) {
    return this.desktop.state(this.labels(owner));
  }
  start(owner: string) {
    return this.desktop.start(this.labels(owner));
  }
  stop(owner: string) {
    return this.desktop.stop(this.labels(owner));
  }
  async running(owner: string): Promise<ComputerSession> {
    const labels = this.labels(owner);
    const verified = await this.desktop.inspect(labels);
    if (verified?.state !== "running") throw stopped();
    return {
      exec: (command, cwd, signal) =>
        this.desktop.run(labels, desktopCommand(command), {
          cwd,
          timeoutMs: 35000,
          signal,
          verified,
        }),
      file: (input, seconds, maxOutputBytes) =>
        this.desktop.run(
          labels,
          `/usr/bin/timeout --kill-after=1s ${seconds}s /usr/bin/python3 -I /opt/openmuse/files.py`,
          {
            timeoutMs: (seconds + 2) * 1000,
            input,
            maxOutputBytes,
            propagateAttachError: true,
            verified,
          },
        ),
      stop: () => this.stop(owner),
    };
  }
}
