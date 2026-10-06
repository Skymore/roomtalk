'use strict';
// One real Chromium context per RoomTalk sandbox. The control plane owns
// authorization, durable observations and saved login state; this process owns
// the live page. Remote page code never executes in the RoomTalk client.
const net = require('node:net');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const socketPath = process.env.ROOMTALK_BROWSER_SOCKET || '/tmp/roomtalk-personal-browser.sock';
const viewport = { width: 1280, height: 800 };

async function serve() {
  const { chromium } = require('playwright');
  let browser, context, page, sessionId;
  let queue = Promise.resolve();
  const statuses = new WeakMap();
  const downloads = new Map();
  const pendingDownloads = new Set();
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomtalk-personal-pdf-'));
  function watch(opened) {
    opened.setDefaultTimeout(10_000);
    opened.on('dialog', dialog => void dialog.dismiss());
    opened.on('download', download => {
      const task = (async () => {
        const id = randomUUID(), name = path.basename(download.suggestedFilename());
        const target = path.join(downloadDir, id);
        await download.saveAs(target);
        const size = fs.statSync(target).size;
        if (!name.toLowerCase().endsWith('.pdf') || !size || size > 10 * 1024 * 1024) { fs.rmSync(target, {force:true}); return; }
        downloads.set(id, {id, name, byteSize:size, url:download.url(), path:target});
      })().catch(() => {});
      pendingDownloads.add(task); task.finally(() => pendingDownloads.delete(task));
    });
  }
  async function start(storageState) {
    if (context) return;
    browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'],
      ...(process.env.E2E_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE_PATH } : {}), env: {
      HOME: process.env.HOME || '/tmp', PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8',
    } });
    context = await browser.newContext({ viewport, storageState, acceptDownloads: true });
    context.on('response', response => {
      if (!response.request().isNavigationRequest()) return;
      const frame = response.frame();
      if (frame === frame.page().mainFrame()) statuses.set(frame.page(), response.status());
    });
    context.on('page', opened => { page = opened; watch(opened); });
    page = await context.newPage();
  }
  async function observe() {
    if (!page || page.isClosed()) page = context.pages().findLast(candidate => !candidate.isClosed()) || await context.newPage();
    await Promise.all([...pendingDownloads]);
    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const screenshot = (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 10_000 })).toString('base64');
    await Promise.all([...pendingDownloads]);
    return { downloads: [...downloads.values()].map(({path: _path,...metadata}) => metadata), httpStatus: statuses.get(page), url: page.url(), title: (await page.title()).slice(0, 300), text: text.slice(0, 30_000), truncated: text.length > 30_000,
      viewport, screenshot,
      storageState: await context.storageState({ indexedDB: true }) };
  }
  async function execute(input) {
    if (context && input.sessionId !== sessionId) { await browser.close(); browser = context = page = undefined; }
    if (sessionId && sessionId !== input.sessionId) { for (const file of downloads.values()) fs.rmSync(file.path,{force:true}); downloads.clear(); }
    sessionId = input.sessionId;
    if (input.action === 'close') {
      const storageState = context ? await context.storageState({ indexedDB: true }) : input.storageState;
      if (browser) await browser.close();
      browser = context = page = undefined;
      return { closed: true, storageState };
    }
    const fresh = !context;
    await start(input.storageState);
    if (fresh && input.action !== 'open' && input.initialUrl && input.initialUrl !== 'about:blank') {
      await page.goto(input.initialUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    }
    if (input.action === 'open') {
      const url = new URL(input.url);
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new Error('Use an HTTP, HTTPS or local file URL');
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    } else if (input.action === 'click') {
      if (typeof input.selector === 'string') await page.locator(input.selector).click();
      else await page.mouse.click(input.x, input.y);
    } else if (input.action === 'fill') await page.locator(input.selector).fill(input.text);
    else if (input.action === 'text') await page.keyboard.insertText(input.text);
    else if (input.action === 'key') await page.keyboard.press(input.key);
    else if (input.action === 'scroll') await page.mouse.wheel(0, input.deltaY);
    else if (input.action === 'import_pdf') {
      await Promise.all([...pendingDownloads]);
      const file = downloads.get(input.id);
      if (!file) throw new Error('Downloaded PDF is no longer available');
      return {...await observe(), download: {id:file.id, name:file.name, url:file.url, content:fs.readFileSync(file.path).toString('base64')}};
    }
    else if (input.action !== 'read') throw new Error('Unknown browser action');
    return observe();
  }
  const server = net.createServer(connection => {
    let data = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => {
      data += chunk;
      if (data.length > 4 * 1024 * 1024) { connection.destroy(); return; }
      if (!data.includes('\n')) return;
      connection.removeAllListeners('data');
      const task = queue.catch(() => {}).then(async () => {
        try { const result = await execute(JSON.parse(data.split('\n', 1)[0])); connection.end(JSON.stringify({ success: true, ...result }) + '\n'); }
        catch (error) { connection.end(JSON.stringify({ success: false, error: error.message }) + '\n'); }
      });
      queue = task;
    });
  });
  server.on('error', error => { if (error.code !== 'EADDRINUSE') console.error('Browser service could not listen'); process.exit(1); });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  async function stop() { server.close(); if (browser) await browser.close().catch(() => {}); fs.rmSync(socketPath, { force: true }); fs.rmSync(downloadDir,{recursive:true,force:true}); process.exit(0); }
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

function send(input) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(socketPath);
    let data = '';
    connection.setTimeout(40_000, () => connection.destroy(new Error('Browser action timed out')));
    connection.setEncoding('utf8');
    connection.on('connect', () => connection.write(JSON.stringify(input) + '\n'));
    connection.on('data', chunk => { data += chunk; if (data.length > 18 * 1024 * 1024) connection.destroy(new Error('Browser response exceeds its limit')); });
    connection.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Browser returned no observation')); } });
    connection.on('error', reject);
  });
}
async function request(input) {
  try { return await send(input); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (error.code === 'ECONNREFUSED') fs.rmSync(socketPath, { force: true });
    const child = spawn(process.execPath, [__filename, 'serve'], { detached: true, stdio: 'ignore', env: {
      HOME: process.env.HOME || '/tmp', PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, ROOMTALK_BROWSER_SOCKET: socketPath,
      E2E_CHROMIUM_EXECUTABLE_PATH: process.env.E2E_CHROMIUM_EXECUTABLE_PATH,
    } });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { return await send(input); } catch (pending) { if (!['ENOENT', 'ECONNREFUSED'].includes(pending.code)) throw pending; }
    }
    throw new Error('Browser service did not start');
  }
}
if (require.main === module) {
  if (process.argv[2] === 'serve') serve().catch(() => process.exit(1));
  else if (process.argv[2] === 'request-file') {
    (async () => {
      try { process.stdout.write(JSON.stringify(await request(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')))) + '\n'); }
      catch (error) { process.stdout.write(JSON.stringify({ success: false, error: error.message }) + '\n'); process.exitCode = 1; }
    })();
  }
  else {
    let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', async () => { try { process.stdout.write(JSON.stringify(await request(JSON.parse(input))) + '\n'); } catch (error) { process.stdout.write(JSON.stringify({ success: false, error: error.message }) + '\n'); process.exitCode = 1; } });
  }
}
module.exports = { request, viewport };
