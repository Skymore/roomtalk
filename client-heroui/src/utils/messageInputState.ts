export type MessageContentItem = {
  type: "text" | "image";
  content: string;
  file?: File;
  previewUrl?: string;
};

export type OutgoingMessageItem =
  | { type: "text"; content: string }
  | { type: "image"; file: File; previewUrl?: string };

export const emptyMessageContent = (): MessageContentItem[] => [{ type: "text", content: "" }];

export const hasMessageContent = (items: MessageContentItem[]): boolean => {
  return items.some(item =>
    (item.type === "text" && item.content.trim() !== "") ||
    item.type === "image"
  );
};

export const buildAIPrompt = (items: MessageContentItem[]): string => {
  return items
    .filter(item => item.type === "text")
    .map(item => item.content.trim())
    .filter(Boolean)
    .join("\n");
};

export const buildOutgoingMessageItems = (items: MessageContentItem[]): OutgoingMessageItem[] => {
  const outgoingItems: OutgoingMessageItem[] = [];
  let currentTextContent = "";

  const flushText = () => {
    if (currentTextContent.trim() !== "") {
      outgoingItems.push({ type: "text", content: currentTextContent });
      currentTextContent = "";
    }
  };

  for (const item of items) {
    if (item.type === "text") {
      if (item.content.trim() !== "") {
        currentTextContent += (currentTextContent ? "\n" : "") + item.content;
      }
    } else if (item.file) {
      flushText();
      outgoingItems.push({ type: "image", file: item.file, previewUrl: item.previewUrl });
    }
  }

  flushText();
  return outgoingItems;
};
