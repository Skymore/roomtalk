export const languageOptions = [
  { key: "en", labelKey: "english", displayName: "English", icon: "circle-flags:uk" },
  { key: "zh", labelKey: "chinese", displayName: "中文", icon: "circle-flags:cn" },
  { key: "hi", labelKey: "hindi", displayName: "हिंदी", icon: "circle-flags:in" },
  { key: "ja", labelKey: "japanese", displayName: "日本語", icon: "circle-flags:jp" },
  { key: "ko", labelKey: "korean", displayName: "한국어", icon: "circle-flags:kr" },
] as const;

export type LanguageKey = (typeof languageOptions)[number]["key"];

export const getLanguageOption = (language: string) =>
  languageOptions.find((option) => language === option.key || language.startsWith(`${option.key}-`)) ??
  languageOptions[0];
