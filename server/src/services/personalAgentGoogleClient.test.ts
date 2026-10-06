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

Ported from pinned OpenMuse tests/google.test.ts.
*/
import assert from "node:assert/strict";
import test from "node:test";
import { emailDraftSchema, eventDraftSchema } from "./personalAgentGoogleTypes";
import {
  GoogleApiError,
  GoogleClient,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  OutcomeUnknownError,
} from "./personalAgentGoogleClient";

function clientWith(handler: (request: Request) => Response | Promise<Response>) {
  return new GoogleClient({
    getAccessToken: async () => "synthetic-access-token",
    fetch: async (input, init) => handler(new Request(input, init)),
  });
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const email = () =>
  emailDraftSchema.parse({
    to: ["reader@example.com"],
    subject: "Your visit résumé",
    body: "Hello <reader>,\nHere is your form.\nThank you.",
  });
const event = () =>
  eventDraftSchema.parse({
    title: "Community museum",
    start: "2026-10-10T10:00:00-07:00",
    end: "2026-10-10T14:00:00-07:00",
  });
const eventResponse = {
  id: "event-1",
  etag: '"revision-1"',
  summary: "Community museum",
  start: { dateTime: "2026-10-10T10:00:00-07:00", timeZone: "America/Los_Angeles" },
  end: { dateTime: "2026-10-10T14:00:00-07:00" },
};
const base64url = (text: string) => Buffer.from(text).toString("base64url");

test("mail reads nested plain text and attachment references over authenticated Gmail paths", async () => {
  const paths: URL[] = [];
  const client = clientWith((request) => {
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-access-token");
    const url = new URL(request.url);
    paths.push(url);
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "msg1" }] });
    return json({
      id: "msg1",
      threadId: "thread1",
      internalDate: "1791658800000",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        headers: [
          { name: "From", value: '"Museum, Community" <museum@example.com>' },
          { name: "To", value: "Guardian <guardian@example.com>" },
          { name: "Subject", value: "Visit form" },
        ],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/html", body: { data: base64url("<script>unsafe</script>") } },
              {
                mimeType: "text/plain",
                body: { data: base64url("Please complete the attached form.") },
              },
            ],
          },
          {
            mimeType: "application/pdf",
            filename: "Permission: form.pdf",
            body: { attachmentId: "attach1", size: 1024 },
          },
        ],
      },
    });
  });
  const [mail] = await client.listMail("from:museum@example.com");
  assert.equal(paths[0].origin, "https://gmail.googleapis.com");
  assert.equal(paths[0].searchParams.get("q"), "from:museum@example.com");
  assert.equal(paths[1].searchParams.get("format"), "full");
  assert.equal(mail.body, "Please complete the attached form.");
  assert.equal(mail.from, "museum@example.com");
  assert.equal(mail.sender, "Museum, Community");
  assert.deepEqual(mail.to, ["guardian@example.com"]);
  assert.equal(mail.unread, true);
  assert.deepEqual(mail.attachments, ["msg1:attach1:Permission%3A%20form.pdf"]);
});

test("a body charset TextDecoder does not know falls back to UTF-8 instead of failing the list", async () => {
  const charsets: Record<string, string> = { known: "utf-8", unknown: "unknown-8bit" };
  const bodies: Record<string, string> = { known: "Opening hours", unknown: "Café tickets" };
  const client = clientWith((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/messages"))
      return json({ messages: [{ id: "known" }, { id: "unknown" }] });
    const id = url.pathname.split("/").at(-1) ?? "";
    return json({
      id,
      threadId: `thread-${id}`,
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: "Museum <museum@example.com>" },
          { name: "Content-Type", value: `text/plain; charset=${charsets[id]}` },
        ],
        mimeType: "text/plain",
        body: { data: base64url(bodies[id]) },
      },
    });
  });
  const mail = await client.listMail();
  assert.deepEqual(
    mail.map((item) => item.body),
    ["Opening hours", "Café tickets"],
  );
});

test("HTML-only messages expose complete plain text while removing active and non-content elements", async () => {
  let reads = 0;
  const fullText = "Complete museum itinerary. ".repeat(4500);
  const client = clientWith((request) =>
    ++reads && new URL(request.url).pathname.endsWith("/messages")
      ? json({ messages: [{ id: "msg1" }] })
      : json({
          id: "msg1",
          threadId: "thread1",
          snippet: "Welcome &amp; thank you",
          payload: {
            mimeType: "text/html",
            body: {
              data: base64url(
                `<html><head><style>.secret{display:none}</style></head><body><h1>Welcome &amp; thank you</h1><p>${fullText}</p><p>Last details &copy; &#x1f30e;.</p><img src="https://tracker.invalid"><script>alert(1)</script><iframe src="https://tracker.invalid">hidden frame</iframe></body></html>`,
              ),
            },
          },
        }),
  );
  const body = (await client.listMail())[0].body;
  assert.ok(body.startsWith("Welcome & thank you\n"));
  assert.ok(body.includes(fullText.trim()));
  assert.ok(body.endsWith("Last details © 🌎."));
  assert.equal(/alert\(1\)|secret|hidden frame|tracker\.invalid|<h1>/.test(body), false);
  assert.equal(reads, 2);
});

test("Gmail attachments decode actual bytes and enforce declared and actual size limits", async () => {
  const original = Buffer.from([0, 255, 127, 1, 2]);
  const client = clientWith((request) => {
    assert.equal(
      new URL(request.url).pathname,
      "/gmail/v1/users/me/messages/msg1/attachments/attach1",
    );
    return json({ size: original.length, data: original.toString("base64url") });
  });
  assert.deepEqual(Buffer.from(await client.getAttachment("msg1", "attach1")), original);
  await assert.rejects(
    clientWith(() => json({ size: MAX_ATTACHMENT_BYTES + 1, data: "AA" })).getAttachment(
      "msg1",
      "attach1",
    ),
    /too large|limit/i,
  );
  await assert.rejects(
    clientWith(() => json({ data: "not valid base64!" })).getAttachment("msg1", "attach1"),
    /base64|invalid/i,
  );
  await assert.rejects(
    clientWith(() => json({ size: 2, data: original.toString("base64url") })).getAttachment(
      "msg1",
      "attach1",
    ),
    /size|length/i,
  );
});

test("mail sends correctly encoded CRLF MIME and the exact attachment bytes", async () => {
  const requests: Request[] = [];
  const attachment = Buffer.from([0, 127, 255, 10]);
  const client = clientWith(async (request) => {
    requests.push(request);
    if (new URL(request.url).pathname.endsWith("/profile"))
      return json({ emailAddress: "me@example.com" });
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url).pathname, "/gmail/v1/users/me/messages/send");
    const { raw } = await request.json();
    assert.match(raw, /^[A-Za-z0-9_-]+$/);
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.equal(/(?<!\r)\n/.test(mime), false);
    assert.match(mime, /From: me@example\.com\r\n/);
    const subjectWords = mime.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
    assert.equal(
      subjectWords
        .map((word) => Buffer.from(word.slice(10, -2), "base64").toString("utf8"))
        .join(""),
      email().subject,
    );
    assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
    assert.ok(mime.includes(Buffer.from(email().body.replace(/\n/g, "\r\n")).toString("base64")));
    assert.ok(mime.includes(attachment.toString("base64")));
    assert.match(mime, /filename\*=UTF-8''visit%20r%C3%A9sum%C3%A9\.pdf/);
    assert.equal(mime.includes("Content-Type: text/html"), false);
    return json({ id: "sent1", threadId: "thread1" });
  });
  assert.deepEqual(
    await client.sendEmail(email(), [
      { name: "visit résumé.pdf", mimeType: "application/pdf", bytes: attachment },
    ]),
    { id: "sent1", threadId: "thread1" },
  );
  assert.equal(requests.length, 2);
});

test("header injection and oversized outgoing attachments fail before credential access", async () => {
  let tokenReads = 0;
  const client = new GoogleClient({
    getAccessToken: async () => {
      tokenReads++;
      return "synthetic";
    },
    fetch: async () => {
      throw new Error("Unexpected fetch");
    },
  });
  await assert.rejects(
    client.sendEmail({ ...email(), subject: "Hello\r\nBcc: intruder@example.com" }, []),
  );
  await assert.rejects(
    client.sendEmail({ ...email(), to: ["reader@example.com\r\nBcc: intruder@example.com"] }, []),
  );
  await assert.rejects(
    client.sendEmail(email(), [
      { name: "a\r\nX-Injection: yes.pdf", mimeType: "application/pdf", bytes: new Uint8Array() },
    ]),
    /header|name|control/i,
  );
  await assert.rejects(
    client.sendEmail(email(), [
      { name: "a.pdf", mimeType: "application/pdf\r\nX-Injection: yes", bytes: new Uint8Array() },
    ]),
    /mime|type|header/i,
  );
  await assert.rejects(
    client.sendEmail(email(), [
      {
        name: "big.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
      },
    ]),
    /large|limit/i,
  );
  const count = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES) + 1;
  await assert.rejects(
    client.sendEmail(
      email(),
      Array.from({ length: count }, (_, i) => ({
        name: `${i}.pdf`,
        mimeType: "application/pdf",
        bytes: new Uint8Array(MAX_ATTACHMENT_BYTES),
      })),
    ),
    /large|limit/i,
  );
  assert.equal(tokenReads, 0);
});

test("replies resolve source metadata and preserve thread and message references", async () => {
  let writes = 0;
  const client = clientWith(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/profile")) return json({ emailAddress: "me@example.com" });
    if (url.pathname.endsWith("/messages/source1")) {
      assert.equal(url.searchParams.get("format"), "metadata");
      return json({
        id: "source1",
        threadId: "source-thread",
        payload: {
          headers: [
            { name: "Message-ID", value: "<source@example.com>" },
            { name: "References", value: "<earlier@example.com>" },
            { name: "Subject", value: "Visit form" },
          ],
        },
      });
    }
    writes++;
    const { raw, threadId } = await request.json();
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.equal(threadId, "source-thread");
    assert.match(mime, /In-Reply-To: <source@example.com>\r\n/);
    assert.match(mime, /References: <earlier@example.com> <source@example.com>\r\n/);
    return json({ id: "reply1", threadId });
  });
  await client.sendEmail(
    { ...email(), subject: "Re: Visit form", replyToMessageId: "source1" },
    [],
  );
  assert.equal(writes, 1);
  await assert.rejects(
    client.sendEmail(
      {
        ...email(),
        subject: "Re: Visit form",
        replyToMessageId: "source1",
        threadId: "wrong-thread",
      },
      [],
    ),
    /thread/i,
  );
  await assert.rejects(
    client.sendEmail({ ...email(), subject: "Unrelated subject", replyToMessageId: "source1" }, []),
    /subject/i,
  );
  await assert.rejects(
    client.sendEmail({ ...email(), threadId: "source-thread" }, []),
    /replyToMessageId|source message/i,
  );
  assert.equal(writes, 1);
});

test("reply metadata cannot inject headers", async () => {
  let writes = 0;
  const client = clientWith((request) => {
    if (request.method !== "GET") writes++;
    if (request.url.endsWith("/profile")) return json({ emailAddress: "me@example.com" });
    return json({
      id: "source1",
      threadId: "thread1",
      payload: {
        headers: [
          { name: "Message-ID", value: "<ok@example.com>\r\nBcc: intruder@example.com" },
          { name: "Subject", value: email().subject },
        ],
      },
    });
  });
  await assert.rejects(
    client.sendEmail({ ...email(), replyToMessageId: "source1" }, []),
    /header|message.id/i,
  );
  assert.equal(writes, 0);
});

test("calendar reads expanded primary events and maps all-day boundaries", async () => {
  const client = clientWith((request) => {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(url.searchParams.get("singleEvents"), "true");
    assert.equal(url.searchParams.get("orderBy"), "startTime");
    assert.ok(url.searchParams.get("timeMin"));
    return json({
      timeZone: "America/Los_Angeles",
      items: [
        {
          id: "day1",
          summary: "Museum day",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-11" },
          attendees: [{ email: "guardian@example.com" }],
        },
      ],
    });
  });
  assert.deepEqual((await client.listEvents())[0], {
    id: "day1",
    calendarId: "primary",
    title: "Museum day",
    start: "2026-10-10",
    end: "2026-10-11",
    allDay: true,
    timeZone: "America/Los_Angeles",
    location: "",
    description: "",
    attendees: ["guardian@example.com"],
  });
});

test("calendar writes use calendar IDs, preserve unrelated fields via PATCH, and notify guests", async () => {
  const requests: { url: URL; method: string; body: unknown; ifMatch: string | null }[] = [];
  const client = clientWith(async (request) => {
    requests.push({
      url: new URL(request.url),
      method: request.method,
      body: request.method === "DELETE" || request.method === "GET" ? null : await request.json(),
      ifMatch: request.headers.get("if-match"),
    });
    return request.method === "DELETE" ? new Response(null, { status: 204 }) : json(eventResponse);
  });
  const draft = {
    ...event(),
    calendarId: "shared@example.com",
    attendees: ["guardian@example.com"],
  };
  assert.equal((await client.createEvent(draft)).calendarId, draft.calendarId);
  await client.updateEvent("event-1", draft);
  await client.deleteEvent(draft.calendarId, "event-1");
  assert.deepEqual(
    requests.map((item) => item.method),
    ["POST", "GET", "PATCH", "GET", "DELETE"],
  );
  assert.equal(
    requests[2].url.pathname,
    "/calendar/v3/calendars/shared%40example.com/events/event-1",
  );
  assert.ok(
    requests
      .filter((item) => item.method !== "GET")
      .every((item) => item.url.searchParams.get("sendUpdates") === "all"),
  );
  assert.equal(requests[2].ifMatch, eventResponse.etag);
  assert.equal(requests[4].ifMatch, eventResponse.etag);
  assert.deepEqual(requests[0].body, {
    summary: draft.title,
    start: { dateTime: draft.start, timeZone: draft.timeZone },
    end: { dateTime: draft.end, timeZone: draft.timeZone },
    location: "",
    description: "",
    attendees: [{ email: "guardian@example.com" }],
  });
});

test("calendar review captures authoritative details and requires a usable version", async () => {
  const reviewed = await clientWith(() => json(eventResponse)).reviewEvent("primary", "event-1");
  assert.equal(reviewed.event.title, "Community museum");
  assert.equal(reviewed.event.timeZone, "America/Los_Angeles");
  assert.equal(reviewed.version, eventResponse.etag);
  for (const etag of [undefined, "", "bad\r\nversion"]) {
    await assert.rejects(
      clientWith(() => json({ ...eventResponse, etag })).reviewEvent("primary", "event-1"),
      /etag|version/i,
    );
  }
  await assert.rejects(
    clientWith(() => json({ ...eventResponse, recurringEventId: "series" })).reviewEvent(
      "primary",
      "event-1",
    ),
    /recurr/i,
  );
});

test("calendar writes refuse targets changed since review before dispatch", async () => {
  let writes = 0;
  const client = clientWith((request) => {
    if (request.method !== "GET") writes++;
    return request.method === "DELETE"
      ? new Response(null, { status: 204 })
      : json({ ...eventResponse, etag: '"revision-2"' });
  });
  await assert.rejects(client.updateEvent("event-1", event(), eventResponse.etag), /changed/i);
  await assert.rejects(client.deleteEvent("primary", "event-1", eventResponse.etag), /changed/i);
  assert.equal(writes, 0);
});

test("calendar review resolves the selected calendar zone when Google omits an event zone", async () => {
  const paths: string[] = [];
  const client = clientWith((request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path.includes("/calendarList/")
      ? json({ id: "shared@example.com", timeZone: "Pacific/Auckland" })
      : json({
          ...eventResponse,
          start: { dateTime: "2026-10-11T08:00:00+13:00" },
          end: { dateTime: "2026-10-11T09:00:00+13:00" },
        });
  });
  const reviewed = await client.reviewEvent("shared@example.com", "event-1");
  assert.equal(reviewed.event.timeZone, "Pacific/Auckland");
  assert.ok(paths.includes("/calendar/v3/users/me/calendarList/shared%40example.com"));
});

test("calendar writes pass the reviewed version to Google's final conditional write", async () => {
  let writes = 0;
  const client = clientWith((request) => {
    if (request.method === "GET") return json(eventResponse);
    writes++;
    assert.equal(request.headers.get("if-match"), eventResponse.etag);
    return json({ error: { message: "Event changed after the check" } }, 412);
  });
  await assert.rejects(client.updateEvent("event-1", event(), eventResponse.etag), GoogleApiError);
  await assert.rejects(
    client.deleteEvent("primary", "event-1", eventResponse.etag),
    GoogleApiError,
  );
  assert.equal(writes, 2);
});

test("all-day writes use exclusive date-only end and invalid dates never call Google", async () => {
  let requests = 0;
  const client = clientWith(async (request) => {
    requests++;
    const body = await request.json();
    assert.deepEqual(body.start, { date: "2026-10-10" });
    assert.deepEqual(body.end, { date: "2026-10-11" });
    return json({ ...eventResponse, start: body.start, end: body.end });
  });
  await client.createEvent({ ...event(), start: "2026-10-10", end: "2026-10-11", allDay: true });
  await assert.rejects(client.createEvent({ ...event(), end: "2026-10-09T10:00:00-07:00" }));
  assert.equal(requests, 1);
});

test("calendar creates and updates reject nonexistent dates before contacting Google", async () => {
  let requests = 0;
  const client = clientWith(() => {
    requests++;
    return json(eventResponse);
  });
  for (const allDay of [true, false]) {
    const suffix = allDay ? "" : "T10:00:00+08:00";
    const draft = {
      ...event(),
      allDay,
      start: `2026-02-29${suffix}`,
      end: `2026-03-02${suffix}`,
    };
    await assert.rejects(client.createEvent(draft), { name: "ZodError" });
    await assert.rejects(client.updateEvent("event-1", draft), { name: "ZodError" });
  }
  assert.equal(requests, 0);
});

test("event updates explicitly clear the opposite time representation when switching all-day mode", async () => {
  const client = clientWith(async (request) => {
    if (request.method === "GET") return json(eventResponse);
    const body = await request.json();
    if (body.start.date) {
      assert.equal(body.start.dateTime, null);
      assert.equal(body.end.dateTime, null);
      return json({
        ...eventResponse,
        start: { date: body.start.date },
        end: { date: body.end.date },
      });
    }
    assert.equal(body.start.date, null);
    assert.equal(body.end.date, null);
    return json(eventResponse);
  });
  await client.updateEvent("event-1", {
    ...event(),
    allDay: true,
    start: "2026-10-10",
    end: "2026-10-11",
  });
  await client.updateEvent("event-1", event());
});

test("scope errors remain visible and do not look like empty inboxes", async () => {
  const client = clientWith(() =>
    json({ error: { message: "Request had insufficient authentication scopes." } }, 403),
  );
  await assert.rejects(
    client.listMail(),
    (error: unknown) =>
      error instanceof GoogleApiError && error.status === 403 && /scope/i.test(error.message),
  );
  await assert.rejects(client.listEvents(), /scope/i);
});

test("network failures and 5xx write responses produce outcome_unknown without retrying", async () => {
  for (const failure of ["network", "server", "invalid-success"] as const) {
    let writes = 0;
    const client = clientWith((request) => {
      if (request.url.endsWith("/profile")) return json({ emailAddress: "me@example.com" });
      if (request.method === "GET") return json(eventResponse);
      writes++;
      if (failure === "network") throw new TypeError("socket closed");
      return failure === "server"
        ? json({ error: { message: "upstream failed" } }, 503)
        : json({ unexpected: "body" });
    });
    await assert.rejects(client.sendEmail(email(), []), OutcomeUnknownError);
    await assert.rejects(client.createEvent(event()), OutcomeUnknownError);
    await assert.rejects(client.updateEvent("event-1", event()), OutcomeUnknownError);
    assert.equal(writes, 3);
  }
  let deletes = 0;
  await assert.rejects(
    clientWith((request) => {
      if (request.method === "GET") return json(eventResponse);
      deletes++;
      throw new TypeError("socket closed");
    }).deleteEvent("primary", "event-1"),
    OutcomeUnknownError,
  );
  assert.equal(deletes, 1);
});

test("credential failures before dispatch and explicit 4xx writes remain definite failures", async () => {
  const client = new GoogleClient({
    getAccessToken: async () => {
      throw new Error("Reconnect Google");
    },
    fetch: async () => {
      throw new Error("Must not fetch");
    },
  });
  await assert.rejects(
    client.createEvent(event()),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof OutcomeUnknownError) &&
      /Reconnect/.test(error.message),
  );
  await assert.rejects(
    clientWith(() => json({ error: { message: "invalid attendee" } }, 400)).createEvent(event()),
    (error: unknown) => error instanceof GoogleApiError && error.status === 400,
  );
});

test("an interrupted error response body cannot erase uncertainty about a write", async () => {
  const client = clientWith(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("Connection already closed");
          },
        }),
        { status: 503 },
      ),
  );
  await assert.rejects(client.createEvent(event()), OutcomeUnknownError);
});

test("thread detail reads sent and archived messages outside the inbox list", async () => {
  const client = clientWith((request) => {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/gmail/v1/users/me/threads/thread1");
    assert.equal(url.searchParams.get("format"), "full");
    return json({
      id: "thread1",
      messages: [
        {
          id: "archived1",
          threadId: "thread1",
          labelIds: [],
          payload: { mimeType: "text/plain", body: { data: base64url("Archived original") } },
        },
        {
          id: "sent1",
          threadId: "thread1",
          labelIds: ["SENT"],
          payload: {
            mimeType: "text/html",
            body: { data: base64url("<p>Sent reply &amp; thanks</p>") },
          },
        },
      ],
    });
  });
  const messages = await client.getThread("thread1");
  assert.deepEqual(
    messages.map(({ id, body, label }) => ({ id, body, label })),
    [
      { id: "archived1", body: "Archived original", label: "Mail" },
      { id: "sent1", body: "Sent reply & thanks", label: "Sent" },
    ],
  );
});

test("thread detail retrieves complete text bodies stored behind Gmail attachment IDs", async () => {
  const paths: string[] = [];
  const client = clientWith((request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path.includes("/attachments/"))
      return json({
        data: base64url("<p>Entire message beyond the snippet.</p>"),
        size: Buffer.byteLength("<p>Entire message beyond the snippet.</p>"),
      });
    return json({
      id: "thread1",
      messages: [
        {
          id: "msg1",
          threadId: "thread1",
          snippet: "Entire message...",
          payload: { mimeType: "text/html", body: { attachmentId: "body1", size: 38 } },
        },
      ],
    });
  });
  assert.equal((await client.getThread("thread1"))[0].body, "Entire message beyond the snippet.");
  assert.deepEqual(paths, [
    "/gmail/v1/users/me/threads/thread1",
    "/gmail/v1/users/me/messages/msg1/attachments/body1",
  ]);
});

test("event reads include earlier today and support selected calendars and bounded ranges", async () => {
  const queries: URL[] = [];
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const client = clientWith((request) => {
    queries.push(new URL(request.url));
    return json({ items: [eventResponse] });
  });
  await client.listEvents();
  assert.equal(queries[0].searchParams.get("timeMin"), midnight.toISOString());
  assert.equal(queries[0].searchParams.get("maxResults"), "100");
  assert.ok(Date.parse(queries[0].searchParams.get("timeMax") ?? "") > midnight.getTime());
  const result = await client.listEvents({
    calendarId: "shared@example.com",
    timeMin: "2026-10-01T00:00:00-07:00",
    timeMax: "2026-11-01T00:00:00-07:00",
  });
  assert.equal(result[0].calendarId, "shared@example.com");
  assert.equal(queries[1].pathname, "/calendar/v3/calendars/shared%40example.com/events");
  assert.equal(queries[1].searchParams.get("timeMin"), "2026-10-01T00:00:00-07:00");
  assert.equal(queries[1].searchParams.get("timeMax"), "2026-11-01T00:00:00-07:00");
  for (const options of [
    { timeMin: "yesterday" },
    { timeMin: "2026-10-01T00:00:00", timeMax: "2026-11-01T00:00:00Z" },
    { timeMin: "2026-10-01T00:00:00Z", timeMax: "2026-09-01T00:00:00Z" },
    { timeMin: "2026-10-01T00:00:00Z", timeMax: "2028-10-01T00:00:00Z" },
  ])
    await assert.rejects(client.listEvents(options), /date|range|time|366|offset/i);
  assert.equal(queries.length, 2);
});

test("calendar discovery follows pagination and retains names, zones, and access roles", async () => {
  const client = clientWith((request) => {
    const url = new URL(request.url);
    assert.equal(url.pathname, "/calendar/v3/users/me/calendarList");
    return url.searchParams.has("pageToken")
      ? json({
          items: [
            {
              id: "shared@example.com",
              summary: "Original name",
              summaryOverride: "Family",
              timeZone: "America/Los_Angeles",
              accessRole: "writer",
            },
          ],
        })
      : json({
          nextPageToken: "next1",
          items: [
            {
              id: "me@example.com",
              summary: "Personal",
              timeZone: "America/Los_Angeles",
              accessRole: "owner",
            },
          ],
        });
  });
  assert.deepEqual(await client.listCalendars(), [
    {
      id: "me@example.com",
      name: "Personal",
      timeZone: "America/Los_Angeles",
      accessRole: "owner",
    },
    {
      id: "shared@example.com",
      name: "Family",
      timeZone: "America/Los_Angeles",
      accessRole: "writer",
    },
  ]);
});

test("recurring masters and occurrences are rejected from fresh Google data before updates or deletes", async () => {
  for (const recurrence of [
    { recurrence: ["RRULE:FREQ=WEEKLY"] },
    { recurringEventId: "series1" },
  ]) {
    const methods: string[] = [];
    const client = clientWith((request) => {
      methods.push(request.method);
      assert.equal(new URL(request.url).pathname, "/calendar/v3/calendars/primary/events/event-1");
      return json({ ...eventResponse, ...recurrence });
    });
    await assert.rejects(client.validateSingleEvent("primary", "event-1"), /recurr/i);
    await assert.rejects(client.updateEvent("event-1", event()), /recurr/i);
    await assert.rejects(client.deleteEvent("primary", "event-1"), /recurr/i);
    assert.deepEqual(methods, ["GET", "GET", "GET"]);
  }
});

test("single-event validation is repeated at execution and read failures never dispatch writes", async () => {
  let reads = 0;
  let writes = 0;
  const client = clientWith((request) => {
    if (request.method !== "GET") {
      writes++;
      return json(eventResponse);
    }
    reads++;
    return json({ ...eventResponse, ...(reads > 1 ? { recurrence: ["RRULE:FREQ=DAILY"] } : {}) });
  });
  await client.validateSingleEvent("primary", "event-1");
  await assert.rejects(client.updateEvent("event-1", event()), /recurr/i);
  assert.equal(writes, 0);
  const failing = clientWith((request) => {
    if (request.method !== "GET") writes++;
    return json({ error: { message: "No access to this event" } }, 403);
  });
  await assert.rejects(failing.deleteEvent("primary", "event-1"), GoogleApiError);
  assert.equal(writes, 0);
});

test("a sender's unpaired-surrogate attachment filename does not break the inbox", async () => {
  const client = clientWith((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/messages")) return json({ messages: [{ id: "msg1" }] });
    return json({
      id: "msg1",
      threadId: "thread1",
      internalDate: "1791658800000",
      labelIds: ["INBOX"],
      payload: {
        headers: [{ name: "From", value: "sender@example.com" }],
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: base64url("See attached.") } },
          {
            mimeType: "application/pdf",
            filename: "form\uD800.pdf",
            body: { attachmentId: "attach1", size: 10 },
          },
        ],
      },
    });
  });
  const [mail] = await client.listMail();
  assert.deepEqual(mail.attachments, ["msg1:attach1:form%EF%BF%BD.pdf"]);
});

test("an outgoing attachment name with an unpaired surrogate still sends", async () => {
  const client = clientWith(async (request) => {
    if (new URL(request.url).pathname.endsWith("/profile"))
      return json({ emailAddress: "me@example.com" });
    const { raw } = await request.json();
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(mime, /filename\*=UTF-8''form%EF%BF%BD\.pdf/);
    return json({ id: "sent1", threadId: "thread1" });
  });
  await client.sendEmail(email(), [
    { name: "form\uD800.pdf", mimeType: "application/pdf", bytes: Buffer.from([1]) },
  ]);
});
