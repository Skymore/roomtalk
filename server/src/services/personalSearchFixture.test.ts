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
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { TestContext } from "node:test";

type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };
type Reply = {
  status?: number;
  headers?: Record<string, string>;
  result?: unknown;
  error?: object;
};
export const searchSource = {
  url: "https://example.org/research",
  title: "Observed research",
  excerpts: ["Useful evidence returned by search."],
  publish_date: "2026-09-01",
};

// Exercise the real MCP client against a disposable server, without changing production config.
export async function searchFixture(t: TestContext, handle?: (rpc: Rpc) => Reply | Promise<Reply>) {
  const requests: { rpc: Rpc; headers: IncomingHttpHeaders }[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "");
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc: Rpc = JSON.parse(body);
    requests.push({ rpc, headers: request.headers });
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const supplied = await handle?.(rpc);
    const result =
      supplied?.result ??
      (rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          }
        : {
            content: [{ type: "text", text: JSON.stringify({ results: [searchSource] }) }],
            structuredContent: { results: [searchSource] },
          });
    response.writeHead(supplied?.status ?? 200, {
      "content-type": "application/json",
      ...supplied?.headers,
    });
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        ...(supplied?.error ? { error: supplied.error } : { result }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://search.parallel.ai/mcp") {
      return originalFetch(`http://127.0.0.1:${address.port}/mcp`, init);
    }
    return originalFetch(url, init);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests, paths, url: `http://127.0.0.1:${address.port}` };
}
