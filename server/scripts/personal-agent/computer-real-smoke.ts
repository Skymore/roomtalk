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
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {Sandbox} from '@e2b/desktop';
import {PDFDocument} from 'pdf-lib';
import express from 'express';
import {ComputerService,computerIdentity} from '../../src/services/personalComputer/computer';
import {Store} from '../../src/services/personalComputer/store';
import {createPostgresPool} from '../../src/repositories/postgresPool';
import {PostgresStore} from '../../src/repositories/postgresStore';
import {LocalMediaObjectStorage} from '../../src/services/mediaObjectStorage';
import {PersonalAgentFileService} from '../../src/services/personalAgentFiles';
import {PersonalAgentComputerService} from '../../src/services/personalAgentComputer';
import {registerPersonalAgentRoutes} from '../../src/routes/personalAgentRoutes';
import type {Config} from '../../src/services/personalComputer/config';
// Explicit opt-in; never loaded by the ordinary test suite. Use unique E2B metadata
// and an isolated test database. All sandboxes created by this smoke are killed.
const keychain=process.env.ROOMTALK_COMPUTER_SMOKE_KEYCHAIN==='true'?JSON.parse(execFileSync('/usr/bin/security',['find-generic-password','-a','roomtalk','-s','roomtalk-production-env','-w'],{encoding:'utf8',stdio:['ignore','pipe','ignore']})):{};
const apiKey=process.env.E2B_API_KEY || keychain.E2B_API_KEY || keychain.CODE_AGENT_E2B_API_KEY;
const databaseUrl=process.env.ROOM_EVENT_TEST_DATABASE_URL;
if(!databaseUrl || !/(^|[_-])(test|e2e)([_-]|$)/i.test(new URL(databaseUrl).pathname.slice(1)))throw Error('Set an isolated test database');
test('real OpenMuse desktop source acceptance through RoomTalk HTTP APIs',{timeout:300000,skip:!apiKey},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'roomtalk-desktop-real-'));
  const logger={info(){},warn(){},error(){},debug(){}};
  const pool=createPostgresPool(databaseUrl,logger as any),records=new PostgresStore(pool,logger as any);await records.initializeSchema();
  const owner=`desktop-smoke-${randomUUID()}`,token=randomUUID();
  await records.createPasswordAccountForClient({clientId:owner,accountId:owner,now:new Date().toISOString()});await records.ensurePersonalAgentProfile(owner);
  const db=new Store(records as any),storage=new LocalMediaObjectStorage(directory,logger as any);
  const config:Config={publicUrl:'http://localhost',computerEnabled:true,computerProvider:'e2b-desktop',computerE2bTemplate:process.env.COMPUTER_E2B_TEMPLATE || 'desktop',e2bApiKey:apiKey,computerDeploymentId:`smoke-${randomUUID()}`};
  const computer=new ComputerService(db,config,storage),files=new PersonalAgentFileService(records as any,storage,logger as any);
  const app=express();app.use(express.json({limit:'14mb'}));
  registerPersonalAgentRoutes(app,{store:records as any,files,computer:new PersonalAgentComputerService(computer,files),logger:logger as any,getClientId:req=>req.header('x-client-id') || null,authorizeClientRequest:async(req,res,clientId)=>{const allowed=clientId===owner && req.header('x-client-auth-token')===token;if(!allowed)res.status(401).json({error:'Unauthorized'});return allowed;}});
  const listener=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
  const address=listener.address();assert.ok(address && typeof address!=='string');const baseURL=`http://127.0.0.1:${address.port}`;
  const server={computer,files},labels=computerIdentity(config,owner).labels;
  const sandboxIds=async()=> (await Sandbox.list({apiKey,query:{metadata:labels,state:['running','paused']}}).nextItems()).map(item=>item.sandboxId);
  try {
    const session = {token};
    const headers = {
      "x-client-id": owner, "x-client-auth-token": session.token,
      "Content-Type": "application/json",
    };
    const routes:Record<string,string>={'':'status','/start':'start','/stop':'stop','/desktop':'desktop-url','/commands':'run','/files/mkdir':'mkdir','/files/write':'write','/files/read':'read','/files/import':'copy-document','/files/export':'import-pdf'};
    const call=async(path:string,body?:unknown)=>{
      const operation=routes[path];assert.ok(operation,path);
      const input={...(body as Record<string,unknown> || {}),operation,...(operation==='run'?{operationId:randomUUID()}:{})};
      const read=body===undefined || operation==='read';
      const query=new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)]));
      const response=await fetch(`${baseURL}/api/personal-agent/computer${read?`?${query}`:''}`,{method:read?'GET':'POST',headers,...(read?{}:{body:JSON.stringify(input)})});
      const result=await response.json();assert.ok(response.ok,`${path}: ${JSON.stringify(result)}`);console.log(`computer smoke ${operation}: passed`);return operation==='import-pdf'?result.file:result;
    };
    const post = (path: string, body: unknown = {}) => call(path, body);
    // A desktop action, then the JPEG screenshot it kept for the chat card.
    const act=async(action:Record<string,unknown>)=>{
      const response=await fetch(`${baseURL}/api/personal-agent/computer`,{method:'POST',headers,body:JSON.stringify({operation:'desktop',operationId:randomUUID(),action})});
      const result=await response.json();assert.ok(response.ok,JSON.stringify(result));assert.equal(result.receipt.status,'succeeded',JSON.stringify(result));
      assert.deepEqual([result.width,result.height],[1280,800]);
      const latest=await fetch(`${baseURL}/api/personal-agent/computer?operation=screenshot&receiptId=${result.receipt.id}`,{headers});
      assert.ok(latest.ok);const shot=await latest.json();assert.equal(shot.mimeType,'image/jpeg');const bytes=Buffer.from(shot.data,'base64');
      assert.deepEqual([...bytes.subarray(0,3)],[255,216,255]);assert.ok(bytes.length>5000 && bytes.length<1024*1024,String(bytes.length));
      await writeFile('/tmp/roomtalk-openmuse-desktop-real.jpg',bytes);return bytes;
    };
    const started = await post("/start");
    assert.equal(started.status, "running");
    assert.equal(started.provider, "e2b-desktop");
    assert.equal(started.network, "enabled");
    assert.equal((await sandboxIds()).length, 1);
    const command = await post("/commands", {
      command:
        "id -u; pwd; python3 --version; git --version; printf 'persisted from bash\\n' > receipt.txt",
    });
    assert.equal(command.status, "succeeded", JSON.stringify(command));
    assert.match(command.stdout, /^1000\n\/workspace\nPython 3\./);
    await post("/files/mkdir", { path: "/workspace/notes" });
    await post("/files/write", {
      path: "/workspace/notes/hello.txt",
      text: "Hello from the API ✓",
    });
    assert.equal(
      (await post("/files/read", { path: "/workspace/notes/hello.txt" })).text,
      "Hello from the API ✓",
    );
    const missing = await post("/commands", { command: "pwd", cwd: "/workspace/missing" });
    assert.equal(missing.status, "failed");
    assert.equal(missing.exitCode, 126);
    const stdout = await post("/commands", { command: "python3 -c 'print(\"x\" * 300000)'" });
    assert.equal(stdout.status, "succeeded");
    assert.equal(stdout.truncated, true);
    assert.ok(Buffer.byteLength(stdout.stdout) <= 128 * 1024);
    await post("/commands", { command: "ln -s /etc /workspace/escape" });
    const escaped=await fetch(`${baseURL}/api/personal-agent/computer?operation=read&path=${encodeURIComponent("/workspace/escape/passwd")}`,{headers});
    assert.equal(escaped.status, 422);
    // A backgrounded GUI app must not hold the command open, and must keep running.
    const before = Date.now();
    const gui = await post("/commands", {
      command: "firefox-esr https://copilotkit.ai >/dev/null 2>&1 &",
    });
    assert.equal(gui.status, "succeeded", JSON.stringify(gui));
    assert.ok(Date.now() - before < 15000, "the GUI app held the command open");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(
      (await post("/commands", { command: "pgrep -x firefox-esr" })).status,
      "succeeded",
    );
    // Typed input reaches a focused terminal window and runs there.
    const typeIntoTerminal = async (file: string) => {
      await post("/commands", { command: "xfce4-terminal >/dev/null 2>&1 & sleep 3" });
      await act({ action: "type", text: `touch /workspace/${file}` });
      await act({ action: "key", text: "Return" });
      await act({ action: "key", text: "ctrl+shift+q" });
      const created = await post("/commands", { command: `test -e /workspace/${file}` });
      assert.equal(created.status, "succeeded", `typed input did not run: ${file}`);
    };
    // Input and screenshots on the freshly created box.
    await act({ action: "screenshot" });
    await act({ action: "left_click", coordinate: [640, 400] });
    await typeIntoTerminal("typed-fresh");
    const desktop = await call("/desktop");
    assert.match(desktop.url, /^https:\/\/6080-[^/]+\/vnc\.html\?.*password=/);
    assert.ok(!desktop.url.includes(apiKey ?? "-"));
    assert.equal((await call("/desktop")).url, desktop.url);
    assert.equal((await fetch(desktop.url)).status, 200);
    // Another process (e.g. a restarted API) cannot reuse that password, so it restarts
    // the stream; the first process then notices its cached URL went stale and never
    // returns it, restarting the stream with a password of its own.
    const other = await new ComputerService(db,config,storage).desktopUrl(owner);
    assert.notEqual(other.url, desktop.url);
    const current = await call("/desktop");
    assert.notEqual(current.url, desktop.url);
    assert.notEqual(current.url, other.url);
    assert.equal((await call("/desktop")).url, current.url);
    assert.equal((await fetch(current.url)).status, 200);
    // A runaway writer is stopped before its temporary output fills the disk.
    const runaway = await post("/commands", { command: "yes" });
    assert.match(runaway.stderr, /Output exceeded the limit/);
    assert.equal(runaway.truncated, true);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    // Close to the 10 MB import limit: about 14 MB of JSON crosses the network on stdin.
    const { randomBytes } = await import("node:crypto");
    await pdf.attach(randomBytes(9.5 * 1024 * 1024), "noise.bin", {
      mimeType: "application/octet-stream",
    });
    const original=(await server.files.import(owner,"smoke.pdf",Buffer.from(await pdf.save()),"Smoke test")).file;
    const importing = Date.now();
    await post("/files/import", { fileId: original.id, path: "/workspace/source.pdf" });
    console.log(`imported ${(await pdf.save()).length} byte PDF in ${Date.now() - importing} ms`);
    await post("/commands", { command: "cp source.pdf output.pdf" });
    const exported = await post("/files/export", { path: "/workspace/output.pdf" });
    assert.deepEqual(
      (await server.files.get(owner,exported.id)).body,
      (await server.files.get(owner,original.id)).body,
    );
    // The inner 30 second timeout reports exit 124 and leaves the computer running.
    const slow = await post("/commands", { command: "sleep 40" });
    assert.equal(slow.status, "timed_out");
    assert.equal(slow.exitCode, 124);
    assert.equal((await call("")).status, "running");
    assert.equal((await post("/stop")).status, "stopped");
    assert.equal((await post("/start")).status, "running");
    assert.equal(
      (await post("/files/read", { path: "/workspace/receipt.txt" })).text,
      "persisted from bash\n",
    );
    // Stop ends processes: the desktop session is back, the old browser is not.
    assert.equal((await post("/commands", { command: "pgrep -x firefox-esr" })).status, "failed");
    assert.equal(
      (await post("/commands", { command: "pgrep -x xfce4-session" })).status,
      "succeeded",
    );
    // After a pause and cold resume the sandbox env has no DISPLAY; actions still work.
    await act({ action: "screenshot" });
    await act({ action: "scroll", coordinate: [640, 400], scroll_direction: "down" });
    await typeIntoTerminal("typed-resumed");
    const restarted = await call("/desktop");
    assert.equal((await fetch(restarted.url)).status, 200);
    const pending = server.computer.execute(owner, {
      command: "printf ready > /workspace/.smoke-running; sleep 30",
    });
    const [id] = await sandboxIds();
    const box = await Sandbox.connect(id, { apiKey });
    const deadline = Date.now() + 15000;
    while (true) {
      const probe = await box.commands
        .run("cat /workspace/.smoke-running", { user: "root" })
        .catch(() => undefined);
      if (probe?.stdout === "ready") break;
      assert.ok(Date.now() < deadline, "command process failed to begin");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await server.computer.stop(owner);
    assert.equal((await pending).status, "interrupted");
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    // A stopped computer refuses desktop actions instead of resuming.
    const refused = await fetch(`${baseURL}/api/personal-agent/computer`, {
      method: "POST",
      headers,
      body: JSON.stringify({operation:"desktop",operationId:randomUUID(),action:{action:"screenshot"}}),
    });
    assert.equal(refused.status, 409);
    assert.equal((await server.computer.snapshot(owner)).status, "stopped");
    assert.ok(
      (await server.computer.snapshot(owner)).commands.some(
        (receipt) => receipt.id === command.id && receipt.status === "succeeded",
      ),
    );
  } finally {
    const ids = await sandboxIds();
    const killed = await Promise.all(ids.map((id) => Sandbox.kill(id, { apiKey })));
    await new Promise<void>(resolve=>listener.close(()=>resolve()));
    await pool.query("DELETE FROM rooms WHERE creator_id=$1",[owner]);await pool.query("DELETE FROM accounts WHERE id=$1",[owner]);await pool.end?.();
    await rm(directory, { recursive: true, force: true });
    assert.ok(killed.every(Boolean), "smoke sandbox cleanup failed");
  }
});
