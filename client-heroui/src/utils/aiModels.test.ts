import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AIModelOption,
  fetchAIModels,
  FALLBACK_AI_MODEL,
  FALLBACK_AI_MODELS,
  formatModelPrice,
  isPremiumAIModel,
  getAIModelAccessReason,
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

  it("exposes current models and distinguishes expensive models from membership restrictions", () => {
    expect(FALLBACK_AI_MODEL).toBe("deepseek-v4-pro");
    expect(FALLBACK_AI_MODELS.some(model => model.id === "gpt-6.1-sol")).toBe(true);
    const astra = FALLBACK_AI_MODELS.find(model => model.id === "gpt-6-astra")!;
    const fable = FALLBACK_AI_MODELS.find(model => model.id === "claude-fable-5.1")!;
    const luna = FALLBACK_AI_MODELS.find(model => model.id === "gpt-6-luna")!;
    expect(isPremiumAIModel(astra)).toBe(true);
    expect(getAIModelAccessReason({ effectiveTier: "guest", creditBalanceUsd: 5 }, { id: "gpt-6.1-sol" })).toBeUndefined();
    for (const model of [astra, fable]) {
      expect(getAIModelAccessReason({ effectiveTier: "guest", creditBalanceUsd: 5 }, model)).toBe("aiModelMembershipRequired");
      expect(getAIModelAccessReason({ effectiveTier: "free", creditBalanceUsd: 50 }, model)).toBe("aiModelMembershipRequired");
      expect(getAIModelAccessReason({ effectiveTier: "pro", creditBalanceUsd: 20 }, model)).toBeUndefined();
    }
    expect(getAIModelAccessReason({ effectiveTier: "free", creditBalanceUsd: 0 }, luna)).toBeUndefined();
    expect(getAIModelAccessReason({ effectiveTier: "free", creditBalanceUsd: -5 }, luna)).toBe("aiModelCreditLimitReached");
    expect(getAIModelAccessReason({ effectiveTier: "free", creditBalanceUsd: -1 }, { id: 'one-dollar', pricing: { inputPerMillion: 1 } })).toBe("aiModelCheapOnly");
    expect(getAIModelAccessReason(null, luna)).toBe("aiModelCreditsUnavailable");
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
