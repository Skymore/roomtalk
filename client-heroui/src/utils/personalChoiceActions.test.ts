import assert from "node:assert/strict";
import {test} from "vitest";
import type { JevPanel } from "./personalChoiceDomain";
import {
  choiceAvailability,
  confirmedJevSelection,
  displayJevUserMessage,
  latestJevPanelId,
  parseJevResult,
  retryChoiceAvailable,
  selectionText,
} from "./personalChoiceActions";

const panel: JevPanel = {
  id: "panel-1",
  threadId: "thread-1",
  turnId: "turn-1",
  candidateSetVersion: 1,
  type: "clarification",
  title: "What next?",
  mode: "sample",
  options: [{ id: "explore", label: "Explore exhibits", details: [], sources: [] }],
};

test("reads a complete Jev result from JSON or an object and rejects malformed content", () => {
  assert.equal(parseJevResult({ panel })?.panel?.id, "panel-1");
  assert.equal(parseJevResult(JSON.stringify({ panel }))?.panel?.id, "panel-1");
  assert.equal(parseJevResult("{broken"), null);
  assert.equal(parseJevResult({ panel: { ...panel, options: [] } }), null);
});

test("the latest complete panel only belongs to the active thread and current turn", () => {
  const history = [
    { role: "user", content: "Help me" },
    { role: "assistant", toolCalls: [{ id: "tool-1", name: "present_choices" }] },
    { role: "tool", toolCallId: "tool-1", content: JSON.stringify({ panel }) },
  ];
  assert.equal(latestJevPanelId(history, "thread-1"), "panel-1");
  assert.equal(latestJevPanelId(history, "another-thread"), null);
  assert.equal(
    latestJevPanelId([...history, { role: "user", content: "Something else" }], "thread-1"),
    null,
  );
  assert.equal(
    latestJevPanelId(
      [
        ...history,
        { role: "assistant", toolCalls: [{ id: "tool-2", name: "present_choices" }] },
        {
          role: "tool",
          toolCallId: "tool-2",
          content: JSON.stringify({ panel: { ...panel, id: "panel-2" } }),
        },
      ],
      "thread-1",
    ),
    "panel-2",
  );
});

test("finds AG-UI function tool calls as rendered by CopilotKit", () => {
  const messages = [
    { role: "user", content: "Help me get ready" },
    {
      role: "assistant",
      content: "I will lay out the next steps.",
      toolCalls: [
        { id: "call-1", type: "function", function: { name: "present_choices", arguments: "{}" } },
      ],
    },
    { role: "tool", toolCallId: "call-1", content: JSON.stringify({ panel }) },
    { role: "assistant", content: "Choose what you would like to do first." },
  ];
  assert.equal(latestJevPanelId(messages, "thread-1"), "panel-1");
  assert.equal(
    displayJevUserMessage(selectionText(panel, "explore"), messages),
    "Selected: Explore exhibits",
  );
});

test("stale, wrong-thread, selected, busy and pending panels cannot submit", () => {
  assert.equal(choiceAvailability(panel, "thread-2", "panel-1", false, false), "wrong-thread");
  assert.equal(choiceAvailability(panel, "thread-1", "panel-2", false, false), "stale");
  assert.equal(
    choiceAvailability({ ...panel, selectedId: "explore" }, "thread-1", "panel-1", false, false),
    "selected",
  );
  assert.equal(choiceAvailability(panel, "thread-1", "panel-1", true, false), "busy");
  assert.equal(choiceAvailability(panel, "thread-1", "panel-1", false, true), "pending");
  assert.equal(choiceAvailability(panel, "thread-1", "panel-1", false, false), "ready");
});

test("a carried preference leaves a new refinement panel selectable", () => {
  assert.equal(
    choiceAvailability({ ...panel, preferredId: "explore" }, "thread-1", "panel-1", false, false),
    "ready",
  );
});

test("only the failed option can retry while its panel has not been replaced", () => {
  const action = selectionText(panel, "explore");
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", null, "explore", action, false, false),
    true,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", null, "explore", "hello", false, false),
    false,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", "panel-2", "explore", action, false, false),
    false,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-2", null, "explore", action, false, false),
    false,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", null, "unknown", action, false, false),
    false,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", null, "explore", action, true, false),
    false,
  );
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", null, "explore", action, false, true),
    false,
  );
  assert.equal(
    retryChoiceAvailable(
      { ...panel, selectedId: "explore" },
      "thread-1",
      null,
      "explore",
      action,
      false,
      false,
    ),
    false,
  );
});

test("selection uses the bounded server action format and rejects unknown options", () => {
  assert.equal(
    selectionText(panel, "explore"),
    '[OpenMuse choice] {"panelId":"panel-1","threadId":"thread-1","candidateSetVersion":1,"optionId":"explore"}',
  );
  assert.throws(() => selectionText(panel, "unknown"), /Unknown choice/);
});

test("the transcript shows the trusted option label instead of the action payload", () => {
  const action = selectionText(panel, "explore");
  const history = [
    { role: "assistant", toolCalls: [{ id: "tool-1", name: "present_choices" }] },
    { role: "tool", toolCallId: "tool-1", content: JSON.stringify({ panel }) },
  ];
  assert.equal(displayJevUserMessage(action, history), "Selected: Explore exhibits");
  assert.equal(displayJevUserMessage("Hello", history), "Hello");
  assert.equal(displayJevUserMessage("[OpenMuse choice] {broken", history), "Choice unavailable");
  assert.equal(displayJevUserMessage(action, []), "Choice unavailable");
});

test("a replayed choice is confirmed only after a server continuation", () => {
  const action = selectionText(panel, "explore");
  const history = [
    { role: "assistant", toolCalls: [{ id: "tool-1", name: "present_choices" }] },
    { role: "tool", toolCallId: "tool-1", content: JSON.stringify({ panel }) },
    { role: "user", content: action },
  ];
  assert.equal(confirmedJevSelection(history, "panel-1"), null);
  assert.equal(
    confirmedJevSelection(
      [...history, { role: "assistant", content: "Let's explore." }],
      "panel-1",
    ),
    "explore",
  );
});

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
