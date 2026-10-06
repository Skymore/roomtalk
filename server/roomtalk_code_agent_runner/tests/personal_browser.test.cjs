'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

test('real browser shares page actions and restores saved login state in a fresh context', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roomtalk-browser-test-'));
  const socketPath = path.join(directory, 'browser.sock');
  process.env.ROOMTALK_BROWSER_SOCKET = socketPath;
  const modulePath = path.resolve(__dirname, '../roomtalk_code_agent_runner/personal_browser.cjs');
  const { request } = require(modulePath);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (new URL(req.url, 'http://localhost').pathname === '/login') { res.setHeader('Set-Cookie', 'session=confirmed; HttpOnly; Path=/'); res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.end(`<!doctype html><title>Actual browser fixture</title><h1>Real page</h1><button id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><form action="/login"><input id="name" name="name"><button id="login">Sign in</button></form><p id="session">${req.headers.cookie?.includes('session=confirmed') ? 'Signed in' : 'Signed out'}</p><script>localStorage.setItem('visited','confirmed')</script><div style="height:1400px"></div><p>End of page</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const daemon = spawn(process.execPath, [modulePath, 'serve'], { env: process.env, stdio: 'pipe' });
  let diagnostics = ''; daemon.stderr.on('data', chunk => { diagnostics += chunk; });
  try {
    for (let n = 0; !fs.existsSync(socketPath); n++) { assert.ok(n < 100, diagnostics); await new Promise(resolve => setTimeout(resolve, 50)); }
    const first = await request({ action: 'open', url });
    assert.equal(first.success, true, first.error); assert.equal(first.title, 'Actual browser fixture');
    assert.match(first.text, /Real page/); assert.match(first.text, /Signed out/);
    assert.equal(Buffer.from(first.screenshot, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
    const clicked = await request({ action: 'click', selector: '#counter' });
    assert.equal(clicked.success, true, clicked.error); assert.match(clicked.text, /Real page\n1/);
    await request({ action: 'fill', selector: '#name', text: 'Actual input' });
    const loggedIn = await request({ action: 'click', selector: '#login' });
    assert.equal(loggedIn.success, true, loggedIn.error);
    const confirmed = await request({ action: 'read' });
    assert.match(confirmed.text, /Signed in/); assert.equal(confirmed.storageState.cookies[0].value, 'confirmed');
    assert.equal(confirmed.storageState.origins[0].localStorage[0].value, 'confirmed');
    assert.equal((await request({ action: 'close' })).closed, true);
    const restored = await request({ action: 'open', url, storageState: confirmed.storageState });
    assert.equal(restored.success, true, restored.error); assert.match(restored.text, /Signed in/);
    const invalid = await request({ action: 'open', url: 'javascript:alert(1)' });
    assert.equal(invalid.success, false); assert.match(invalid.error, /URL/);
    assert.equal((await request({ action: 'read' })).success, true);
    await request({ action: 'close' });
  } finally {
    daemon.kill('SIGTERM'); await new Promise(resolve => daemon.once('exit', resolve));
    await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  }
});
