import { z } from "openmuse-zod";

const id = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(200);
const httpUrl = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Source URL must use HTTP or HTTPS");

export const jevSourceSchema = z.object({ title: shortText, url: httpUrl }).strict();
export const jevOptionSchema = z
  .object({
    id,
    label: shortText,
    details: z.array(z.string().trim().min(1).max(600)).max(4),
    sources: z.array(jevSourceSchema).max(5),
  })
  .strict();
export const jevPanelSchema = z
  .object({
    id,
    threadId: id,
    turnId: id,
    candidateSetVersion: z.number().int().positive(),
    type: z.enum(["clarification", "comparison"]),
    title: shortText,
    options: z.array(jevOptionSchema).min(1).max(12),
    selectedId: id.optional(),
    preferredId: id.optional(),
    mode: z.enum(["sample", "live"]),
  })
  .strict()
  .superRefine((panel, ctx) => {
    const ids = new Set<string>();
    panel.options.forEach((option, index) => {
      if (ids.has(option.id))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate option ID",
          path: ["options", index, "id"],
        });
      ids.add(option.id);
      if (panel.type === "comparison" && option.sources.length === 0)
        ctx.addIssue({
          code: "custom",
          message: "Comparison options need sources",
          path: ["options", index, "sources"],
        });
    });
    if (panel.type === "comparison" && panel.options.length > 3)
      ctx.addIssue({
        code: "custom",
        message: "Comparison panel can show at most three options",
        path: ["options"],
      });
    if (panel.selectedId && !ids.has(panel.selectedId))
      ctx.addIssue({ code: "custom", message: "Selected option is missing", path: ["selectedId"] });
    if (panel.preferredId && !ids.has(panel.preferredId))
      ctx.addIssue({
        code: "custom",
        message: "Preferred option is missing",
        path: ["preferredId"],
      });
  });
export const jevToolResultSchema = z
  .object({ panel: jevPanelSchema.nullable(), error: z.string().max(600).optional() })
  .strict();
export const jevActionSchema = z
  .object({
    panelId: id,
    threadId: id,
    candidateSetVersion: z.number().int().positive(),
    optionId: id,
  })
  .strict();
export const jevActionPrefix = "[OpenMuse choice] ";
export type JevSource = z.infer<typeof jevSourceSchema>;
export type JevOption = z.infer<typeof jevOptionSchema>;
export type JevPanel = z.infer<typeof jevPanelSchema>;
export type JevToolResult = z.infer<typeof jevToolResultSchema>;
export type JevAction = z.infer<typeof jevActionSchema>;
export function encodeJevAction(action: JevAction): string {
  return jevActionPrefix + JSON.stringify(jevActionSchema.parse(action));
}
export function parseJevAction(text: string): JevAction | null {
  if (!text.startsWith(jevActionPrefix)) return null;
  return jevActionSchema.parse(JSON.parse(text.slice(jevActionPrefix.length)));
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
