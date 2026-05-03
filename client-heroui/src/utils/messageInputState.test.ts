import { describe, expect, it } from "vitest";
import {
  buildAIPrompt,
  buildOutgoingMessageItems,
  emptyMessageContent,
  hasMessageContent,
  MessageContentItem,
} from "./messageInputState";

const imageFile = () => new File(["image"], "image.png", { type: "image/png" });

describe("messageInputState", () => {
  it("detects empty text, text, and image content", () => {
    expect(hasMessageContent(emptyMessageContent())).toBe(false);
    expect(hasMessageContent([{ type: "text", content: "  hello  " }])).toBe(true);
    expect(hasMessageContent([{ type: "image", content: "blob:image" }])).toBe(true);
  });

  it("builds AI prompts from trimmed text only", () => {
    const items: MessageContentItem[] = [
      { type: "text", content: " first " },
      { type: "image", content: "blob:image", file: imageFile() },
      { type: "text", content: "\nsecond\n" },
      { type: "text", content: "   " },
    ];

    expect(buildAIPrompt(items)).toBe("first\nsecond");
  });

  it("builds outgoing items preserving text around images", () => {
    const firstImage = imageFile();
    const secondImage = imageFile();
    const items: MessageContentItem[] = [
      { type: "text", content: "first" },
      { type: "text", content: "second" },
      { type: "image", content: "blob:one", file: firstImage, previewUrl: "blob:one" },
      { type: "text", content: "after image" },
      { type: "image", content: "blob:two", file: secondImage },
      { type: "text", content: "tail" },
    ];

    expect(buildOutgoingMessageItems(items)).toEqual([
      { type: "text", content: "first\nsecond" },
      { type: "image", file: firstImage, previewUrl: "blob:one" },
      { type: "text", content: "after image" },
      { type: "image", file: secondImage, previewUrl: undefined },
      { type: "text", content: "tail" },
    ]);
  });

  it("does not emit image items without files", () => {
    expect(buildOutgoingMessageItems([
      { type: "image", content: "https://example.com/image.png" },
    ])).toEqual([]);
  });
});
