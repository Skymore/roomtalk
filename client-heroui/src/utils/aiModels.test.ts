import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIModelOption,
  fetchAIModels,
  formatModelPrice,
  getStoredAIModel,
  resolveSelectedAIModel,
  saveStoredAIModel,
} from "./aiModels";

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const pricedModel: AIModelOption = {
  id: "priced",
  label: "Priced",
  pricing: { currency: "USD", inputPerMillion: 1.5, outputPerMillion: 12 },
};

describe("aiModels", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("stores and reads the selected model id", () => {
    expect(getStoredAIModel()).toBe("");

    saveStoredAIModel("gpt-5.5");

    expect(getStoredAIModel()).toBe("gpt-5.5");
  });

  it("formats model pricing and missing pricing", () => {
    expect(formatModelPrice(pricedModel)).toBe("$1.5/M in · $12/M out");
    expect(formatModelPrice({ id: "custom", label: "Custom" })).toBe("Price unavailable");
    expect(formatModelPrice({
      id: "free",
      label: "Free",
      pricing: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0.125 },
    })).toBe("$0/M in · $0.125/M out");
  });

  it("keeps a stored model only when the server still exposes it", () => {
    const models = [
      { id: "default", label: "Default" },
      { id: "stored", label: "Stored" },
    ];

    expect(resolveSelectedAIModel("stored", "default", models)).toBe("stored");
    expect(resolveSelectedAIModel("missing", "default", models)).toBe("default");
    expect(resolveSelectedAIModel("", "default", models)).toBe("default");
  });

  it("fetches and validates AI model responses", async () => {
    const response = {
      defaultModel: "priced",
      models: [pricedModel],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => response,
    })));

    await expect(fetchAIModels()).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith("/api/ai-models");
  });

  it("rejects failed or invalid model responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(fetchAIModels()).rejects.toThrow("Failed to load AI models: 500");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ defaultModel: "", models: [] }),
    })));
    await expect(fetchAIModels()).rejects.toThrow("AI model response is invalid");
  });
});
