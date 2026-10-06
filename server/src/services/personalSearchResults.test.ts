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
import {randomUUID} from "node:crypto";
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { createStore } from "./personalChoices/testStore.test";
import { SearchService, searchDescription, searchInstructions } from "./personalSearch";
import { searchFixture, searchSource } from "./personalSearchFixture.test";

const input = { objective: "Find public sources", search_queries: ["public sources"] };
async function searchPayload(t: TestContext, payload: object) {
  await searchFixture(t, (rpc) =>
    rpc.method === "tools/call" ? { result: { content: [], structuredContent: payload } } : {},
  );
  const db = await createStore({dataDir:`/tmp/search-${randomUUID()}/data`});
  t.after(() => db.close());
  return new SearchService(db).search("owner", "chat:results", input);
}

test("search tool guidance is provider-neutral and retains disclosure and citation instructions", () => {
  assert.doesNotMatch(searchDescription + searchInstructions, /parallel/i);
  assert.match(searchDescription, /Queries and objective are sent to an external search service/);
  assert.match(searchDescription, /untrusted data/);
  assert.match(searchInstructions, /cite source URLs/);
});

test("search accepts HTTP and HTTPS source URLs", async (t) => {
  const sources = [searchSource, { ...searchSource, url: "http://example.org/research" }];
  assert.deepEqual(await searchPayload(t, { results: sources }), {
    provider: "parallel",
    results: sources,
    warnings: [],
    truncated: false,
  });
});

test("search drops unsafe URLs and malformed entries without discarding valid sources", async (t) => {
  const invalid = [
    { ...searchSource, url: "not a URL" },
    { ...searchSource, url: "javascript:alert(1)" },
    { ...searchSource, url: "file:///etc/passwd" },
    { ...searchSource, url: "data:text/plain,source" },
    { ...searchSource, url: "ftp://example.org/research" },
    { title: "Missing URL" },
    { ...searchSource, excerpts: [123] },
    null,
  ];
  assert.deepEqual(
    await searchPayload(t, {
      results: [...invalid.slice(0, 4), searchSource, ...invalid.slice(4)],
    }),
    {
      provider: "parallel",
      results: [searchSource],
      warnings: [`Dropped ${invalid.length} invalid search result entries`],
      truncated: true,
    },
  );
});

test("search reports all-invalid entries with bounded warnings", async (t) => {
  const result = await searchPayload(t, {
    results: [{ ...searchSource, url: "javascript:alert(1)" }, { title: "Missing URL" }],
    warnings: Array.from({ length: 12 }, () => "w".repeat(600)),
  });
  assert.deepEqual(result.results, []);
  assert.equal(result.truncated, true);
  assert.equal(result.warnings[0], "Dropped 2 invalid search result entries");
  assert.equal(result.warnings.length, 10);
  assert.ok(result.warnings.every((warning) => warning.length <= 500));
});

for (const [name, payload] of [
  ["missing results", {}],
  ["non-array results", { results: {} }],
  ["malformed warnings", { results: [searchSource], warnings: [123] }],
] as const) {
  test(`search rejects a structurally invalid payload with ${name}`, async (t) => {
    await assert.rejects(searchPayload(t, payload), /invalid search result/);
  });
}
