import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PROJECT_ROOT, "..");
const I18N_FILE = path.join(PROJECT_ROOT, "src", "utils", "i18n.ts");
const SOURCE_LOCALE = "en";
const TARGET_LOCALES = ["zh", "hi", "ja", "ko"];
const LOCALE_NAMES = {
  zh: "Chinese (Simplified)",
  hi: "Hindi",
  ja: "Japanese",
  ko: "Korean",
};
const PRESERVED_TERMS = ["RoomTalk", "AI", "ID", "Enter", "Ctrl", "Command", "Shift", "Mermaid"];

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const apply = args.has("--apply");
const force = args.has("--force");

if (!dryRun && !apply) {
  console.error("Use --dry-run to inspect missing translations or --apply to generate and write them.");
  process.exit(1);
}

const read = (filePath) => fs.readFileSync(filePath, "utf8");

const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return;

  const content = read(filePath);
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key]) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }

    process.env[key] = value;
  }
};

[
  path.join(REPO_ROOT, ".env.local"),
  path.join(REPO_ROOT, ".env"),
  path.join(REPO_ROOT, "server", ".env.local"),
  path.join(REPO_ROOT, "server", ".env"),
  path.join(PROJECT_ROOT, ".env.local"),
  path.join(PROJECT_ROOT, ".env"),
].forEach(loadEnvFile);

const findMatchingBrace = (content, openIndex) => {
  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`No matching brace found at index ${openIndex}`);
};

const findObjectRangeAfter = (content, markerIndex) => {
  const openIndex = content.indexOf("{", markerIndex);
  if (openIndex === -1) return null;

  return {
    start: openIndex,
    end: findMatchingBrace(content, openIndex),
  };
};

const findLocaleRange = (content, locale) => {
  const markerPatterns = [
    new RegExp(`\\b${locale}\\s*:\\s*\\{`),
    new RegExp(`resources\\.${locale}\\s*=\\s*\\{`),
  ];

  for (const pattern of markerPatterns) {
    const match = pattern.exec(content);
    if (!match) continue;

    return findObjectRangeAfter(content, match.index);
  }

  return null;
};

const findTranslationRange = (content, locale) => {
  const localeRange = findLocaleRange(content, locale);
  if (!localeRange) {
    throw new Error(`Locale "${locale}" was not found in ${I18N_FILE}`);
  }

  const localeContent = content.slice(localeRange.start, localeRange.end + 1);
  const match = /translation\s*:\s*\{/.exec(localeContent);
  if (!match) {
    throw new Error(`Locale "${locale}" has no translation object.`);
  }

  const absoluteMatchIndex = localeRange.start + match.index;
  return findObjectRangeAfter(content, absoluteMatchIndex);
};

const parseStringLiteral = (rawValue) => JSON.parse(`"${rawValue}"`);

const extractTranslations = (translationBlock) => {
  const translations = new Map();
  const pairPattern = /"([A-Za-z0-9_.-]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;

  while ((match = pairPattern.exec(translationBlock))) {
    translations.set(match[1], parseStringLiteral(match[2]));
  }

  return translations;
};

const extractPlaceholders = (value) => {
  const placeholders = new Set();
  const pattern = /\{\{[A-Za-z0-9_]+\}\}/g;
  let match;

  while ((match = pattern.exec(value))) {
    placeholders.add(match[0]);
  }

  return [...placeholders].sort();
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeTsString = (value) => JSON.stringify(String(value));

const buildPrompt = (targetLocales, sourceStrings) => `You are translating UI strings for RoomTalk.

Context:
- RoomTalk is a real-time chat room app with optional AI assistant responses.
- Strings are short UI labels, buttons, tooltips, status messages, and validation errors.

Translate the English source strings to these locales: ${targetLocales
  .map((locale) => `${locale} (${LOCALE_NAMES[locale]})`)
  .join(", ")}.

Rules:
- Preserve placeholders exactly, including double braces such as {{roomId}}, {{max}}, and {{error}}.
- Keep these product or technical terms unchanged when they appear: ${PRESERVED_TERMS.join(", ")}.
- Keep keyboard shortcut tokens unchanged.
- Use concise, natural UI language.
- Return only valid JSON with this exact shape:
{
  "zh": { "key": "translation" },
  "hi": { "key": "translation" },
  "ja": { "key": "translation" },
  "ko": { "key": "translation" }
}
- Include only the requested target locale objects.

English source strings:
${JSON.stringify(sourceStrings, null, 2)}
`;

const extractJsonObject = (content) => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);

  if (!candidate.trim().startsWith("{")) {
    throw new Error("The model response did not contain a JSON object.");
  }

  return JSON.parse(candidate);
};

const getProvider = () => {
  const preference = process.env.I18N_TRANSLATION_PROVIDER?.toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (preference === "openrouter" && openrouterKey) {
    return {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: openrouterKey,
      model: process.env.I18N_TRANSLATION_MODEL || "google/gemini-3-flash-preview",
    };
  }

  if (preference === "openai" && openaiKey) {
    return {
      name: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model: process.env.I18N_TRANSLATION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  if (openaiKey) {
    return {
      name: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      apiKey: openaiKey,
      model: process.env.I18N_TRANSLATION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    };
  }

  if (openrouterKey) {
    return {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: openrouterKey,
      model: process.env.I18N_TRANSLATION_MODEL || "google/gemini-3-flash-preview",
    };
  }

  throw new Error(
    "No translation API key found. Set OPENAI_API_KEY or OPENROUTER_API_KEY in the environment or an .env file.",
  );
};

const callTranslationModel = async (targetLocales, sourceStrings) => {
  const provider = getProvider();
  const response = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: buildPrompt(targetLocales, sourceStrings),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`${provider.name} API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`${provider.name} response did not include message content.`);
  }

  return extractJsonObject(content);
};

const validateTranslations = (translations, targetLocales, missingByLocale, sourceTranslations) => {
  const errors = [];

  for (const locale of targetLocales) {
    if (!translations[locale] || typeof translations[locale] !== "object") {
      errors.push(`Missing locale object: ${locale}`);
      continue;
    }

    for (const key of missingByLocale[locale]) {
      const translatedValue = translations[locale][key];
      if (typeof translatedValue !== "string" || translatedValue.trim() === "") {
        errors.push(`Missing translation: ${locale}.${key}`);
        continue;
      }

      const sourcePlaceholders = extractPlaceholders(sourceTranslations.get(key));
      const translatedPlaceholders = extractPlaceholders(translatedValue);
      if (sourcePlaceholders.join("|") !== translatedPlaceholders.join("|")) {
        errors.push(
          `Placeholder mismatch: ${locale}.${key} expected [${sourcePlaceholders.join(", ")}], got [${translatedPlaceholders.join(", ")}]`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid generated translations:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  }
};

const replaceOrInsertTranslations = (content, locale, updates) => {
  const translationRange = findTranslationRange(content, locale);
  let block = content.slice(translationRange.start, translationRange.end + 1);
  const insertions = [];

  for (const [key, value] of updates) {
    const pairPattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)"((?:\\\\.|[^"\\\\])*)"`);
    if (pairPattern.test(block)) {
      block = block.replace(pairPattern, (_, prefix) => `${prefix}${escapeTsString(value)}`);
    } else {
      insertions.push([key, value]);
    }
  }

  if (insertions.length > 0) {
    const closeBraceIndex = block.lastIndexOf("}");
    const closeLineStart = block.lastIndexOf("\n", closeBraceIndex) + 1;
    const beforeCloseLine = block.slice(0, closeLineStart);
    const closeLine = block.slice(closeLineStart);
    const keyIndent =
      block.match(/\n(\s*)"[A-Za-z0-9_.-]+"\s*:/)?.[1] ??
      block.match(/\n(\s*)\.\.\./)?.[1] ??
      "    ";
    const insertionText = insertions
      .map(([key, value]) => `${keyIndent}"${key}": ${escapeTsString(value)},`)
      .join("\n");

    block = `${beforeCloseLine}${insertionText}\n${closeLine}`;
  }

  return `${content.slice(0, translationRange.start)}${block}${content.slice(translationRange.end + 1)}`;
};

const formatMissingSummary = (missingByLocale) => {
  for (const locale of TARGET_LOCALES) {
    const keys = missingByLocale[locale];
    const preview = keys.slice(0, 12).join(", ");
    const suffix = keys.length > 12 ? `, ... +${keys.length - 12} more` : "";
    console.log(`${locale.padEnd(2)} ${String(keys.length).padStart(3)} missing${preview ? `: ${preview}${suffix}` : ""}`);
  }
};

const main = async () => {
  const content = read(I18N_FILE);
  const sourceRange = findTranslationRange(content, SOURCE_LOCALE);
  const sourceBlock = content.slice(sourceRange.start, sourceRange.end + 1);
  const sourceTranslations = extractTranslations(sourceBlock);
  const sourceEntries = [...sourceTranslations.entries()];
  const missingByLocale = {};

  for (const locale of TARGET_LOCALES) {
    const translationRange = findTranslationRange(content, locale);
    const localeBlock = content.slice(translationRange.start, translationRange.end + 1);
    const localeTranslations = extractTranslations(localeBlock);

    missingByLocale[locale] = sourceEntries
      .filter(([key]) => force || !localeTranslations.has(key) || localeTranslations.get(key).trim() === "")
      .map(([key]) => key);
  }

  formatMissingSummary(missingByLocale);

  const targetLocales = TARGET_LOCALES.filter((locale) => missingByLocale[locale].length > 0);
  const missingKeys = [...new Set(targetLocales.flatMap((locale) => missingByLocale[locale]))];

  if (missingKeys.length === 0) {
    console.log("All target translations are up to date.");
    return;
  }

  if (dryRun) {
    console.log("Dry run only. Run npm run translate:i18n to generate and write missing translations.");
    return;
  }

  const sourceStrings = Object.fromEntries(missingKeys.map((key) => [key, sourceTranslations.get(key)]));
  const generatedTranslations = await callTranslationModel(targetLocales, sourceStrings);
  validateTranslations(generatedTranslations, targetLocales, missingByLocale, sourceTranslations);

  let updatedContent = content;
  for (const locale of targetLocales) {
    const updates = missingByLocale[locale].map((key) => [key, generatedTranslations[locale][key]]);
    updatedContent = replaceOrInsertTranslations(updatedContent, locale, updates);
  }

  fs.writeFileSync(I18N_FILE, updatedContent);
  console.log(`Wrote generated translations to ${path.relative(PROJECT_ROOT, I18N_FILE)}.`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
