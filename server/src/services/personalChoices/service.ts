import { createHash, randomUUID } from "node:crypto";
import {
  type JevAction,
  type JevOption,
  type JevPanel,
  type JevToolResult,
  jevActionSchema,
  jevOptionSchema,
  jevPanelSchema,
  parseJevAction,
} from "./domain";
import type { Store } from "../personalComputer/store";
import { type JevAdapter, rankJevOptions } from "./adapter";

export type PresentChoicesInput = {
  /** The person's latest message; the tool always supplies it, direct callers fall back to `message`. */
  userMessage?: string;
  message: string;
  context: string;
  title: string;
  control: "clarification" | "comparison";
  options: Array<Omit<JevOption, "id"> & { id?: string }>;
  refinementPanelId?: string;
};
type PanelRecord = { id: string; panel: JevPanel; candidates: JevOption[] };
type ThreadRecord = {
  id: string;
  revision: number;
  generation: number;
  currentPanelId?: string | null;
  selectedId?: string | null;
  /** The panel a new user turn retired; only that turn may still refine it. */
  retiredPanelId?: string | null;
  retiredTurnId?: string | null;
};
/** Whether `panelId` may be refined by `turnId`: it is current, or this turn just retired it. */
function refinable(head: ThreadRecord | null | undefined, panelId: string, turnId: string) {
  return (
    !!head &&
    (head.currentPanelId === panelId ||
      (head.retiredPanelId === panelId && head.retiredTurnId === turnId))
  );
}
export type JevHeadSnapshot = {
  currentPanelId: string;
  revision: number;
  selectedId: string | null;
};
export class JevService {
  constructor(
    private readonly deps: { store: Store; adapter: JevAdapter; mode: "sample" | "live" },
  ) {}
  get mode() { return this.deps.mode; }
  /** Host adaptation: keep the actual accepted user prompt bound to the active Codex turn. */
  async beginTurn(owner: string, threadId: string, turnId: string, text: string): Promise<string> {
    const action = parseJevAction(text);
    const prompt = action ? (await this.select(owner, threadId, action)).continuation : text;
    if (!action) await this.expireIfUnchanged(owner, threadId, await this.headSnapshot(owner, threadId), turnId);
    await this.store.put(owner, "jev_user_messages", {id: `${threadId}:${turnId}`, text: prompt});
    return prompt;
  }
  async userMessage(owner: string, threadId: string, turnId: string): Promise<string | undefined> {
    return (await this.store.get<{text:string}>(owner, "jev_user_messages", `${threadId}:${turnId}`))?.text;
  }
  private get store() {
    return this.deps.store;
  }
  private async reserve(
    owner: string,
    threadId: string,
    turnId: string,
    refinementPanelId?: string,
  ): Promise<ThreadRecord> {
    await this.store.insertIfAbsent(owner, "jev_threads", {
      id: threadId,
      revision: 0,
      generation: 0,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
      if (!current) throw new Error("Choices thread is unavailable");
      if (refinementPanelId && !refinable(current, refinementPanelId, turnId))
        throw new Error("The earlier choices have been superseded");
      const updated = await this.store.compareAndSwap<ThreadRecord>(
        owner,
        "jev_threads",
        threadId,
        {
          generation: current.generation,
          ...(!refinementPanelId
            ? {}
            : current.currentPanelId === refinementPanelId
              ? { currentPanelId: refinementPanelId }
              : { retiredPanelId: refinementPanelId, retiredTurnId: turnId }),
        },
        { generation: current.generation + 1 },
      );
      if (updated) return updated;
    }
    throw new Error("Choices thread changed too many times; please retry");
  }
  async currentPanel(owner: string, threadId: string): Promise<JevPanel | null> {
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (!head?.currentPanelId) return null;
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", head.currentPanelId);
    return record?.panel ?? null;
  }
  async headSnapshot(owner: string, threadId: string): Promise<JevHeadSnapshot | null> {
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (!head?.currentPanelId) return null;
    return {
      currentPanelId: head.currentPanelId,
      revision: head.revision,
      selectedId: head.selectedId ?? null,
    };
  }
  /** Retires the snapshot's panel on behalf of `turnId`, unless the head moved meanwhile. */
  async expireIfUnchanged(
    owner: string,
    threadId: string,
    snapshot: JevHeadSnapshot | null,
    turnId: string,
  ): Promise<boolean> {
    if (!snapshot) return false;
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (
      !head ||
      head.currentPanelId !== snapshot.currentPanelId ||
      head.revision !== snapshot.revision ||
      (head.selectedId ?? null) !== snapshot.selectedId
    )
      return false;
    return !!(await this.store.compareAndSwap<ThreadRecord>(
      owner,
      "jev_threads",
      threadId,
      {
        generation: head.generation,
        revision: snapshot.revision,
        currentPanelId: snapshot.currentPanelId,
        selectedId: snapshot.selectedId,
      },
      {
        generation: head.generation + 1,
        revision: head.generation + 1,
        currentPanelId: null,
        selectedId: null,
        retiredPanelId: snapshot.currentPanelId,
        retiredTurnId: turnId,
      },
    ));
  }
  async candidateSources(
    owner: string,
    threadId: string,
    turnId: string,
    refinementPanelId: string,
  ): Promise<string[]> {
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", refinementPanelId);
    if (
      !refinable(head, refinementPanelId, turnId) ||
      record?.panel.threadId !== threadId ||
      (this.deps.mode === "live" && record.panel.mode !== "live")
    )
      throw new Error("The earlier choices are unavailable or superseded");
    return [
      ...new Set(record.candidates.flatMap((option) => option.sources.map((source) => source.url))),
    ];
  }
  async createPanel(
    owner: string,
    threadId: string,
    turnId: string,
    input: PresentChoicesInput,
    signal: AbortSignal,
  ): Promise<JevToolResult> {
    signal.throwIfAborted();
    const previous = input.refinementPanelId
      ? await this.store.get<PanelRecord>(owner, "jev_panels", input.refinementPanelId)
      : null;
    const priorHead = input.refinementPanelId
      ? await this.store.get<ThreadRecord>(owner, "jev_threads", threadId)
      : null;
    if (
      input.refinementPanelId &&
      (!previous ||
        previous.panel.threadId !== threadId ||
        !refinable(priorHead, input.refinementPanelId, turnId))
    )
      throw new Error("The earlier choices are unavailable or superseded");
    const candidates = previous
      ? previous.candidates
      : input.options.map((candidate) => {
          const id =
            candidate.id ??
            createHash("sha256")
              .update(
                JSON.stringify({
                  label: candidate.label,
                  details: candidate.details,
                  sources: candidate.sources,
                }),
              )
              .digest("hex")
              .slice(0, 32);
          return jevOptionSchema.parse({ ...candidate, id });
        });
    if (
      candidates.length < 1 ||
      candidates.length > 12 ||
      new Set(candidates.map((o) => o.id)).size !== candidates.length
    )
      throw new Error("Choices need 1–12 distinct options");
    if (input.control === "comparison" && candidates.some((o) => o.sources.length === 0))
      throw new Error("Comparison choices need sources");
    const generation = await this.reserve(owner, threadId, turnId, input.refinementPanelId);
    const priorSelectedId = generation.selectedId ?? undefined;
    const decision = await this.deps.adapter.decide(
      {
        userMessage: input.userMessage ?? input.message,
        message: input.message,
        context: input.context,
        options: candidates,
        allowedControls: [input.control, "agent"],
        selectedId: priorSelectedId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (decision.control === "agent") {
      const head = await this.store.compareAndSwap<ThreadRecord>(
        owner,
        "jev_threads",
        threadId,
        {
          generation: generation.generation,
          revision: generation.revision,
          ...(generation.currentPanelId !== undefined
            ? { currentPanelId: generation.currentPanelId }
            : {}),
          ...(generation.selectedId !== undefined ? { selectedId: generation.selectedId } : {}),
        },
        {
          revision: generation.generation,
          currentPanelId: null,
          selectedId: null,
          retiredPanelId: null,
          retiredTurnId: null,
        },
      );
      if (!head)
        return { panel: null, error: "These choices were superseded by a newer response." };
      return { panel: null };
    }
    if (decision.control !== input.control) throw new Error("Jev returned an unexpected control");
    const ranked = rankJevOptions(candidates, decision);
    const visible = decision.control === "comparison" ? ranked.slice(0, 3) : ranked;
    const preferredId =
      previous && priorSelectedId && ranked.some((option) => option.id === priorSelectedId)
        ? priorSelectedId
        : undefined;
    if (preferredId && !visible.some((option) => option.id === preferredId)) {
      const preferred = ranked.find((option) => option.id === preferredId);
      if (preferred) visible[visible.length - 1] = preferred;
    }
    const panel = jevPanelSchema.parse({
      id: randomUUID(),
      threadId,
      turnId,
      candidateSetVersion: generation.generation,
      type: decision.control,
      title: input.title,
      options: visible,
      preferredId,
      mode: this.deps.mode,
    });
    signal.throwIfAborted();
    await this.store.insertIfAbsent(owner, "jev_panels", { id: panel.id, panel, candidates });
    signal.throwIfAborted();
    const head = await this.store.compareAndSwap<ThreadRecord>(
      owner,
      "jev_threads",
      threadId,
      {
        generation: generation.generation,
        revision: generation.revision,
        ...(generation.currentPanelId !== undefined
          ? { currentPanelId: generation.currentPanelId }
          : {}),
        ...(generation.selectedId !== undefined ? { selectedId: generation.selectedId } : {}),
      },
      {
        revision: generation.generation,
        currentPanelId: panel.id,
        selectedId: null,
        retiredPanelId: null,
        retiredTurnId: null,
      },
    );
    if (!head) return { panel: null, error: "These choices were superseded by a newer response." };
    return { panel };
  }
  async select(
    owner: string,
    threadId: string,
    rawAction: JevAction,
  ): Promise<{ continuation: string; panel: JevPanel }> {
    const action = jevActionSchema.parse(rawAction);
    if (action.threadId !== threadId)
      throw new Error("This choice belongs to another conversation");
    const record = await this.store.get<PanelRecord>(owner, "jev_panels", action.panelId);
    if (
      !record ||
      record.panel.threadId !== threadId ||
      record.panel.candidateSetVersion !== action.candidateSetVersion
    )
      throw new Error("This choice is unavailable or out of date");
    const option = record.candidates.find((o) => o.id === action.optionId);
    if (!option || !record.panel.options.some((o) => o.id === action.optionId))
      throw new Error("This option is unavailable");
    const head = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
    if (
      !head ||
      head.revision !== action.candidateSetVersion ||
      head.currentPanelId !== action.panelId
    )
      throw new Error("These choices have been superseded");
    if (head.selectedId && head.selectedId !== action.optionId)
      throw new Error("A different choice was already selected");
    if (!head.selectedId) {
      const claimed = await this.store.compareAndSwap<ThreadRecord>(
        owner,
        "jev_threads",
        threadId,
        { revision: head.revision, currentPanelId: action.panelId, selectedId: null },
        { selectedId: action.optionId },
      );
      if (!claimed) {
        const reread = await this.store.get<ThreadRecord>(owner, "jev_threads", threadId);
        if (reread?.selectedId !== action.optionId || reread?.currentPanelId !== action.panelId)
          throw new Error("This choice has changed");
      }
    }
    return {
      continuation: `I choose “${option.label}” from ${record.panel.type} choices. Continue with that preference.`,
      panel: { ...record.panel, selectedId: option.id },
    };
  }
  async noteEvidence(
    owner: string,
    threadId: string,
    runId: string,
    kind: "mail" | "web",
    reference: string,
    text?: string,
  ): Promise<void> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    if (kind === "web") {
      if (!text?.trim()) return;
      await this.store.put(owner, "jev_evidence", {
        id,
        threadId,
        runId,
        kind,
        reference,
        text: text.slice(0, 30_000),
      });
      return;
    }
    await this.store.insertIfAbsent(owner, "jev_evidence", {
      id,
      threadId,
      runId,
      kind,
      reference,
    });
    await this.store.insertIfAbsent(owner, "jev_mail_evidence", { id: `${threadId}:${runId}` });
  }
  async hasEvidence(
    owner: string,
    threadId: string,
    runId: string,
    kind: "mail" | "web",
    reference: string,
  ): Promise<boolean> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    return !!(await this.store.get(owner, "jev_evidence", id));
  }
  async hasAnyMailEvidence(owner: string, threadId: string, runId: string): Promise<boolean> {
    return !!(await this.store.get(owner, "jev_mail_evidence", `${threadId}:${runId}`));
  }
  async evidenceText(
    owner: string,
    threadId: string,
    runId: string,
    kind: "web",
    reference: string,
  ): Promise<string | null> {
    const id = `${threadId}:${runId}:${kind}:${createHash("sha256").update(reference).digest("hex")}`;
    const record = await this.store.get<{ text?: string }>(owner, "jev_evidence", id);
    return record?.text?.trim() ? record.text : null;
  }
}

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
