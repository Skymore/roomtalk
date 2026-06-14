import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIModelOption,
  fetchAIModels,
  FALLBACK_AI_MODEL,
  FALLBACK_AI_MODELS,
  formatModelPrice,
  isPremiumAIModel,
  resolveSelectedAIModel,
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
  pricing: { currency: "USD", inputPerMillion: 1.5, cachedInputPerMillion: 0.15, outputPerMillion: 12 },
};

describe("aiModels", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("uses DeepSeek as the fallback default and flags high or unknown output prices as premium", () => {
    expect(FALLBACK_AI_MODEL).toBe("deepseek-v4-pro");
    expect(isPremiumAIModel(FALLBACK_AI_MODELS.find(model => model.id === "gpt-5.5")!)).toBe(true);
    expect(isPremiumAIModel(FALLBACK_AI_MODELS.find(model => model.id === "~google/gemini-pro-latest")!)).toBe(true);
    expect(isPremiumAIModel(FALLBACK_AI_MODELS.find(model => model.id === "google/gemini-3.5-flash")!)).toBe(false);
    expect(FALLBACK_AI_MODELS.find(model => model.id === "tencent/hy3-preview")?.pricing?.outputPerMillion).toBe(0.26);
    expect(isPremiumAIModel({})).toBe(true);
    expect(isPremiumAIModel({ pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 10 } })).toBe(false);
    expect(isPremiumAIModel({ pricing: { currency: "USD", inputPerMillion: 1, outputPerMillion: 10.01 } })).toBe(true);
  });

  it("formats model pricing and missing pricing", () => {
    expect(formatModelPrice(pricedModel)).toBe("$1.5/M in · $0.15/M cached · $12/M out");
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
