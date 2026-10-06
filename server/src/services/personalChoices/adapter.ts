import {
  APIError,
  choice,
  score,
  TypeSafeClient,
  type TypeSafeClientConfig,
} from "@typesafe-ai/sdk";
import type { JevOption } from "./domain";
import { type Config, defaultJevModel } from "./config";
import { providerFailure } from "./log";

export type JevControl = "clarification" | "comparison" | "agent";
export type JevDecisionInput = {
  /** The person's own latest message, so Jev judges independently of the agent's framing. */
  userMessage: string;
  /** The agent's summary of the request. */
  message: string;
  context: string;
  options: JevOption[];
  /** The agent's prepared control comes first; "agent" is the prose fallback. */
  allowedControls: JevControl[];
  selectedId?: string;
};
export type JevDecision = { control: JevControl; scores: Record<string, number> };
export interface JevAdapter {
  decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision>;
}
/** Jev overrides the agent's prepared control only when at least this confident. */
export const jevOverrideConfidence = 0.5;
/** Bounds a choices panel to about ten seconds of provider time instead of the SDK's ~30s. */
const jevTimeoutMs = 5_000;
const jevMaxRetries = 1;
/** Ranks by rubric level; fractional scores between levels are not calibrated finely enough to order. */
export function rankJevOptions(options: JevOption[], decision: JevDecision): JevOption[] {
  const ids = new Set(options.map((option) => option.id));
  if (
    Object.keys(decision.scores).length !== options.length ||
    Object.keys(decision.scores).some((id) => !ids.has(id))
  )
    throw new Error("Jev returned invalid score IDs");
  options.forEach((option) => {
    if (!Number.isFinite(decision.scores[option.id]))
      throw new Error("Jev returned a missing or invalid score");
  });
  const level = (option: JevOption) => Math.round(decision.scores[option.id]);
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => level(b.option) - level(a.option) || a.index - b.index)
    .map(({ option }) => option);
}
export class SampleJevAdapter implements JevAdapter {
  async decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision> {
    signal.throwIfAborted();
    const handsOn = /hands[ -]?on|touch|interactive/i.test(input.message);
    const scores = Object.fromEntries(
      input.options.map((option, index) => [
        option.id,
        handsOn && /touch|rocky|interactive/i.test(`${option.label} ${option.details.join(" ")}`)
          ? 10
          : input.options.length - index,
      ]),
    );
    return {
      control: input.allowedControls.includes("comparison")
        ? "comparison"
        : input.allowedControls[0],
      scores,
    };
  }
}
/** Builds the adapter once per server so every run shares one TypeSafe client. */
export function createJevAdapter(
  config: Pick<Config, "jevMode" | "typesafeApiKey" | "jevModel">,
): JevAdapter | undefined {
  if (config.jevMode === "sample") return new SampleJevAdapter();
  if (config.jevMode !== "live") return undefined;
  if (!config.typesafeApiKey) throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  return LiveJevAdapter.withKey(config.typesafeApiKey, config.jevModel ?? defaultJevModel);
}
/** 4xx responses other than timeouts and rate limits fail the same way on every retry. */
function retryable(error: unknown): boolean {
  return !(
    error instanceof APIError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
type ClientPort = Pick<TypeSafeClient, "systemOne">;
export class LiveJevAdapter implements JevAdapter {
  constructor(
    private readonly client: ClientPort,
    private readonly model: string,
  ) {}
  /** `transport` lets contract tests drive the real client with a fake `fetch`. */
  static withKey(
    apiKey: string,
    model: string,
    transport: Pick<TypeSafeClientConfig, "fetch"> = {},
  ): LiveJevAdapter {
    return new LiveJevAdapter(
      new TypeSafeClient({
        ...transport,
        apiKey,
        timeout: jevTimeoutMs,
        retry: { maxRetries: jevMaxRetries },
      }),
      model,
    );
  }
  async decide(input: JevDecisionInput, signal: AbortSignal): Promise<JevDecision> {
    signal.throwIfAborted();
    if (!input.allowedControls.length) throw new Error("Jev has no allowed controls");
    const questions = {
      control: choice(
        "Which interaction best serves the user's latest message in `userMessage`? Present prepared choices when they let the user select a useful, supported next step. Choose an ordinary agent response only when those options are unhelpful or unsupported.",
        Object.fromEntries(
          input.allowedControls.map((control) => [
            control,
            control === "clarification"
              ? "Present the prepared options as clickable next steps"
              : control === "comparison"
                ? "Present the sourced candidates as clickable comparison cards"
                : "Answer the user in prose without choice cards",
          ]),
        ),
      ),
      // Options are referenced by position; their labels come from untrusted pages and stay in state.
      ...Object.fromEntries(
        input.options.map((_, index) => [
          `fit_${index}`,
          score(
            `How well does \`options[${index}]\` fit the user's latest message in \`userMessage\`? Use only the details of \`options[${index}]\` as evidence.`,
            ["Does not fit", "Some fit", "Good fit", "Best fit"],
          ),
        ]),
      ),
    };
    const result = await this.client
      .systemOne(
        {
          model: this.model,
          state: {
            userMessage: input.userMessage,
            agentSummary: input.message,
            context: input.context,
            selectedId: input.selectedId ?? null,
            options: input.options,
          },
          questions,
        },
        { signal },
      )
      .catch((error: unknown) => {
        signal.throwIfAborted();
        providerFailure("jev.decide", error);
        throw Object.assign(new Error(
          retryable(error)
            ? "Jev could not evaluate these choices. Please retry."
            : "Jev is unavailable for these choices. Do not retry; answer the user in prose.",
        ), { cause: error });
      });
    signal.throwIfAborted();
    if (
      !result ||
      typeof result !== "object" ||
      !result.answers ||
      typeof result.answers !== "object" ||
      Array.isArray(result.answers)
    )
      throw new Error("Jev returned invalid answers");
    const answers = result.answers as Record<
      string,
      { type?: string; choice?: string; score?: number; confidence?: number }
    >;
    const chosen = answers.control?.choice;
    const confidence = answers.control?.confidence;
    if (
      answers.control?.type !== "choice" ||
      !input.allowedControls.includes(chosen as JevControl) ||
      typeof confidence !== "number" ||
      !(confidence >= 0 && confidence <= 1)
    )
      throw new Error("Jev returned an invalid control");
    // An uncertain answer does not override the agent's prepared control.
    const control =
      confidence < jevOverrideConfidence ? input.allowedControls[0] : (chosen as JevControl);
    const scores: Record<string, number> = {};
    input.options.forEach((option, index) => {
      const answer = answers[`fit_${index}`];
      if (
        answer?.type !== "score" ||
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > 3
      )
        throw new Error("Jev returned an invalid score");
      scores[option.id] = answer.score;
    });
    return { control, scores };
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
