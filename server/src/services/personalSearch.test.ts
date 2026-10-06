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
import { randomUUID } from "node:crypto";
import { type TestContext, test } from "node:test";
import { createStore } from "./personalChoices/testStore.test";
import { SearchService } from "./personalSearch";
import { searchFixture, searchSource } from "./personalSearchFixture.test";

const input = { objective: "Find useful public research", search_queries: ["public research"] };
async function serviceFixture(t: TestContext) {
  const db = await createStore({dataDir:`/tmp/search-${randomUUID()}/data`});
  t.after(() => db.close());
  return { db, search: new SearchService(db) };
}

test("search preserves citations, reuses session IDs and sends project identity without auth", async (t) => {
  const { requests } = await searchFixture(t);
  const { db, search } = await serviceFixture(t);
  const result = await search.search("owner", "chat:one", input);
  assert.deepEqual(result, {
    provider: "parallel",
    results: [searchSource],
    warnings: [],
    truncated: false,
  });
  await new SearchService(db).search("owner", "chat:one", input);
  await search.search("owner", "task:two", input);
  const calls = requests.filter(({ rpc }) => rpc.method === "tools/call");
  const args = calls.map(
    ({ rpc }) => rpc.params?.arguments as typeof input & { session_id: string },
  );
  assert.deepEqual(args[0].search_queries, input.search_queries);
  assert.equal(args[0].objective, input.objective);
  assert.match(args[0].session_id, /^[a-f0-9-]{36}$/);
  assert.equal(args[0].session_id, args[1].session_id);
  assert.notEqual(args[0].session_id, args[2].session_id);
  assert.ok(!requests.some(({ rpc }) => rpc.method === "tools/list"));
  for (const { headers } of requests) {
    assert.equal(headers["user-agent"], "roomtalk/1.0.0");
    assert.equal(headers.authorization, undefined);
    assert.equal(headers["x-api-key"], undefined);
  }
});

test("valid empty search succeeds and JSON text is supported without structuredContent", async (t) => {
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? {
          result: {
            content: [
              {
                type: "text",
                text: '{"results":[],"warnings":[{"type":"empty","message":"No matching sources","detail":null}]}',
              },
            ],
          },
        }
      : {},
  );
  const { search } = await serviceFixture(t);
  assert.deepEqual(await search.search("owner", "chat:one", input), {
    provider: "parallel",
    results: [],
    warnings: ["empty: No matching sources"],
    truncated: false,
  });
});

for (const [name, supplied, message] of [
  ["HTTP rate limit", { status: 429 }, /Parallel search failed/],
  ["RPC failure", { error: { code: -32000, message: "Quota exceeded" } }, /Quota exceeded/],
  [
    "tool failure",
    { result: { isError: true, content: [{ type: "text", text: "Search unavailable" }] } },
    /Search unavailable/,
  ],
  [
    "malformed payload",
    { result: { content: [], structuredContent: { results: "not an array" } } },
    /invalid search result/,
  ],
] as const) {
  test(`search reports ${name} rather than empty success`, async (t) => {
    await searchFixture(t, (rpc) => (rpc.method === "tools/call" ? supplied : {}));
    const { search } = await serviceFixture(t);
    await assert.rejects(search.search("owner", "chat:one", input), message);
  });
}

test("search bounds model excerpts and network bytes while retaining citations", async (t) => {
  let huge = false;
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call"
      ? {
          result: {
            content: [],
            structuredContent: {
              results: [{ ...searchSource, excerpts: ["x".repeat(huge ? 1100000 : 31000)] }],
            },
          },
        }
      : {},
  );
  const { search } = await serviceFixture(t);
  const result = await search.search("owner", "chat:one", input);
  assert.equal(result.results[0].url, searchSource.url);
  assert.equal(result.results[0].excerpts[0].length, 30000);
  assert.equal(result.truncated, true);
  huge = true;
  await assert.rejects(search.search("owner", "chat:one", input), /exceeded 1 MiB/);
});

test("search rejects invalid input before contacting Parallel", async (t) => {
  const { requests } = await searchFixture(t);
  const { search } = await serviceFixture(t);
  await assert.rejects(search.search("owner", "chat:one", { ...input, search_queries: [" "] }));
  await assert.rejects(search.search("owner", "chat:one", input, AbortSignal.abort()));
  assert.equal(requests.length, 0);
});

test("search refuses redirects before sending queries to another destination", async (t) => {
  let destination = "";
  const fixture = await searchFixture(t, (rpc) =>
    rpc.method === "tools/call" ? { status: 307, headers: { location: destination } } : {},
  );
  destination = `${fixture.url}/redirect-target`;
  const { search } = await serviceFixture(t);
  await assert.rejects(search.search("owner", "chat:one", input), /Parallel search failed/);
  assert.ok(!fixture.paths.includes("/redirect-target"));
});

test("search aborts in-flight execution and distinguishes its deadline", async (t) => {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  let waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await searchFixture(t, async (rpc) => {
    if (rpc.method === "tools/call") {
      started();
      await waiting;
    }
    return {};
  });
  const { search } = await serviceFixture(t);
  const controller = new AbortController();
  const pending = search.search("owner", "chat:one", input, controller.signal);
  await startedPromise;
  controller.abort(new Error("User stopped search"));
  await assert.rejects(pending, /User stopped search/);
  release();
  waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", () => originalTimeout(50));
  const expired = search.search("owner", "chat:one", input);
  await assert.rejects(expired, /timed out after 45 seconds/);
  release();
});

