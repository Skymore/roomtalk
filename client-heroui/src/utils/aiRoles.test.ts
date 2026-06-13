import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAIRole,
  AIRole,
  defaultAIRoles,
  deleteAIRole,
  generateAIRoleDraft,
  getAIRoleDisplayName,
  getAIRoleDisplayPrompt,
  getSavedAIRoles,
  getSelectedAIRole,
  saveAIRoles,
  updateAIRole,
} from "./aiRoles";

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }

  removeItem(key: string) {
    this.data.delete(key);
  }
}

const customRole: AIRole = {
  id: "custom",
  name: "Custom",
  systemPrompt: "Custom prompt",
  color: "primary",
  icon: "lucide:bot",
};

describe("aiRoles", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("returns default roles when storage is empty or invalid", () => {
    expect(getSavedAIRoles()).toEqual(defaultAIRoles);

    localStorage.setItem("aiRoles", "{invalid");
    expect(getSavedAIRoles()).toEqual(defaultAIRoles);
  });

  it("saves and loads custom roles", () => {
    saveAIRoles([customRole]);

    expect(getSavedAIRoles()).toEqual([customRole]);
  });

  it("migrates saved roles once when built-in defaults change", () => {
    localStorage.setItem("aiRoles", JSON.stringify([customRole]));

    expect(getSavedAIRoles()).toEqual([
      customRole,
      ...defaultAIRoles,
    ]);

    saveAIRoles([customRole]);
    expect(getSavedAIRoles()).toEqual([customRole]);
  });

  it("translates built-in role names and prompts while keeping custom roles literal", () => {
    const t = (key: string) => `translated:${key}`;

    expect(getAIRoleDisplayName(defaultAIRoles[0], t)).toBe("translated:roleAssistantName");
    expect(getAIRoleDisplayPrompt(defaultAIRoles[0], t)).toBe("translated:roleAssistantPrompt");
    expect(getAIRoleDisplayName(defaultAIRoles[1], t)).toBe("translated:roleA2UIDemoName");
    expect(getAIRoleDisplayPrompt(defaultAIRoles[1], t)).toBe("translated:roleA2UIDemoPrompt");
    expect(getAIRoleDisplayName(customRole, t)).toBe("Custom");
    expect(getAIRoleDisplayPrompt(customRole, t)).toBe("Custom prompt");
  });

  it("adds and updates roles without mutating the original list", () => {
    const roles = [defaultAIRoles[0]];
    const added = addAIRole(roles, customRole);
    const updatedRole = { ...customRole, name: "Updated" };

    expect(added).toEqual([defaultAIRoles[0], customRole]);
    expect(roles).toEqual([defaultAIRoles[0]]);
    expect(updateAIRole(added, updatedRole)).toEqual([defaultAIRoles[0], updatedRole]);
  });

  it("resolves selected roles with safe fallbacks", () => {
    expect(getSelectedAIRole([defaultAIRoles[0], customRole], "custom")).toBe(customRole);
    expect(getSelectedAIRole([customRole], "missing")).toBe(customRole);
    expect(getSelectedAIRole([], "missing")).toBe(defaultAIRoles[0]);
  });

  it("deletes roles and moves selection when the selected role is removed", () => {
    const roles = [defaultAIRoles[0], customRole];

    expect(deleteAIRole(roles, "custom", "custom")).toEqual({
      roles: [defaultAIRoles[0]],
      selectedRoleId: "default",
    });
    expect(deleteAIRole(roles, "custom", "default")).toEqual({
      roles: [defaultAIRoles[0]],
      selectedRoleId: "default",
    });
    expect(deleteAIRole([customRole], "custom", "custom")).toEqual({
      roles: [customRole],
      selectedRoleId: "custom",
    });
  });

  it("requests and validates AI generated role drafts", async () => {
    localStorage.setItem("clientId", "client-1");
    const draft = { name: "Reviewer", systemPrompt: "Review code carefully." };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => draft,
    })));

    await expect(generateAIRoleDraft("Create a reviewer")).resolves.toEqual(draft);
    expect(fetch).toHaveBeenCalledWith("/api/ai-role-draft", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idea: "Create a reviewer", clientId: "client-1" }),
    });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502 })));
    await expect(generateAIRoleDraft("fail")).rejects.toThrow("Failed to generate AI role draft: 502");

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ name: "Missing prompt" }),
    })));
    await expect(generateAIRoleDraft("invalid")).rejects.toThrow("AI role draft response is invalid");
  });
});
