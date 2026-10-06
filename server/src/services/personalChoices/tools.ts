import { z } from "openmuse-zod";
import { type JevToolResult, jevOptionSchema } from "./domain";
import type { JevService } from "./service";

const optionInput = jevOptionSchema
  .omit({ id: true })
  .extend({ id: z.string().trim().min(1).max(200).optional() });
const normalizeExcerpt = (value: string) => value.replace(/\s+/g, " ").toLowerCase();
export const presentChoicesParameters = z
  .object({
    message: z.string().trim().min(1).max(2000),
    context: z.string().trim().min(1).max(8000),
    title: z.string().trim().min(1).max(200),
    control: z.enum(["clarification", "comparison"]),
    options: z.array(optionInput).max(12),
    mailThreadId: z.string().trim().min(1).max(500).optional(),
    refinementPanelId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (!input.refinementPanelId && input.options.length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "New choices need at least one option",
      });
  });
export function presentChoicesTool(
  jev: JevService,
  owner: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  mode: "sample" | "live",
  userMessage?: string,
) {
  return {
    name: "present_choices",
    description:
      "Present prepared clarification buttons or a sourced comparison after reading evidence. For choices based on a read email, include its mailThreadId; generic choices need no mail. Give 1–12 factual options for a new panel. Each comparison option needs at least one detail; its label, source titles, and details must be exact excerpts from the read source page text. To refine an earlier panel, supply refinementPanelId and leave options empty; the server reuses the full original candidate set. This only asks the user for a preference and performs no external action.",
    parameters: presentChoicesParameters,
    execute: async (input: z.infer<typeof presentChoicesParameters>): Promise<JevToolResult> => {
      try {
        signal.throwIfAborted();
        if (
          mode === "live" &&
          input.mailThreadId &&
          !(await jev.hasEvidence(owner, threadId, turnId, "mail", input.mailThreadId))
        )
          throw new Error("Read the referenced email before presenting choices.");
        if (mode === "live" && input.control === "comparison") {
          if (input.refinementPanelId) {
            await jev.candidateSources(owner, threadId, turnId, input.refinementPanelId);
          } else {
            for (const option of input.options) {
              const texts: string[] = [];
              for (const source of option.sources) {
                const observed = await jev.evidenceText(owner, threadId, turnId, "web", source.url);
                if (!observed)
                  throw new Error(`Read the source page before comparing: ${source.url}`);
                const text = normalizeExcerpt(observed);
                if (!text.includes(normalizeExcerpt(source.title)))
                  throw new Error(
                    `Comparison source title is not present in source text: ${source.url}`,
                  );
                texts.push(text);
              }
              if (!texts.some((observed) => observed.includes(normalizeExcerpt(option.label))))
                throw new Error(`Comparison label is not present in source text: ${option.label}`);
              if (!option.details.length)
                throw new Error(`Comparison needs at least one grounded detail: ${option.label}`);
              for (const detail of option.details)
                if (!texts.some((observed) => observed.includes(normalizeExcerpt(detail))))
                  throw new Error(
                    `Comparison detail is not present in source text: ${option.label}`,
                  );
            }
          }
        }
        return await jev.createPanel(owner, threadId, turnId, { ...input, userMessage }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        const message =
          error instanceof Error ? error.message : "Could not prepare choices. Please retry.";
        return {
          panel: null,
          error: message.length < 300 ? message : "Could not prepare choices. Please retry.",
        };
      }
    },
  };
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
