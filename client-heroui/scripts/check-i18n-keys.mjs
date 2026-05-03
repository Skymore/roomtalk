import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, "src");
const I18N_FILE = path.join(SRC_DIR, "utils", "i18n.ts");
const SOURCE_LOCALE = "en";
const LOCALES = ["en", "zh", "hi", "ja", "ko"];

const read = (filePath) => fs.readFileSync(filePath, "utf8");

const walk = (dir, files = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
};

const extractLocaleBlock = (content, locale) => {
  const markers = [`${locale}: {`, `resources.${locale} = {`];
  const start = markers
    .map((marker) => content.indexOf(marker))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];

  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let blockStart = -1;

  for (let i = start; i < content.length; i += 1) {
    const char = content[i];

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

    if (char === "\"" || char === "'" || char === "`") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && blockStart !== -1) {
        return content.slice(blockStart, i + 1);
      }
    }
  }

  return "";
};

const extractTranslationKeys = (block) => {
  const keys = new Set();
  const keyPattern = /"([A-Za-z0-9_.-]+)"\s*:/g;
  let match;

  while ((match = keyPattern.exec(block))) {
    keys.add(match[1]);
  }

  return keys;
};

const extractPlaceholders = (value) => {
  const placeholders = new Set();
  const pattern = /\{\{?[A-Za-z0-9_]+\}?\}/g;
  let match;

  while ((match = pattern.exec(value))) {
    placeholders.add(match[0]);
  }

  return [...placeholders].sort();
};

const extractTranslations = (block) => {
  const translations = new Map();
  const pairPattern = /"([A-Za-z0-9_.-]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match;

  while ((match = pairPattern.exec(block))) {
    translations.set(match[1], match[2]);
  }

  return translations;
};

const extractUsedKeys = () => {
  const keys = new Set();
  const files = walk(SRC_DIR);
  const tCallPattern = /(?<![A-Za-z0-9_])t\(\s*["']([A-Za-z0-9_.-]+)["']/g;
  const knownDynamicPattern = /\b(?:labelKey|nameKey|promptKey|tooltip|activeTooltip)\s*:\s*["']([A-Za-z0-9_.-]+)["']/g;

  for (const filePath of files) {
    const content = read(filePath);
    let match;

    while ((match = tCallPattern.exec(content))) {
      keys.add(match[1]);
    }

    while ((match = knownDynamicPattern.exec(content))) {
      keys.add(match[1]);
    }
  }

  return keys;
};

const HARD_CODED_UI_ALLOWLIST = new Set(["RoomTalk", "ID:"]);
const LOCALIZED_LITERAL_ALLOWLIST = new Set([
  "src/pages/MessagePage.tsx",
  "src/utils/i18n.ts",
  "src/utils/languages.ts",
]);
const hasHumanText = (value) => /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0900-\u097F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u.test(value);
const hasLocalizedScript = (value) => /[\u0900-\u097F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/u.test(value);
const cleanLiteral = (value) => value.replace(/\s+/g, " ").trim();
const isExpressionFragment = (value) =>
  value.startsWith(":") ||
  value.includes("?.") ||
  value.includes("=>") ||
  /^[A-Za-z_$][\w$]*\s*[?:]/.test(value);

const findHardcodedUiStrings = () => {
  const issues = [];
  const files = walk(SRC_DIR).filter((filePath) => filePath.endsWith(".tsx"));
  const patterns = [
    {
      name: "JSX text",
      regex: />\s*([^<>{}\n]*[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0900-\u097F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF][^<>{}\n]*)\s*</gu,
    },
    {
      name: "literal UI prop",
      regex: /\b(?:aria-label|title|placeholder|content|label|description)=["']([^"']+)["']/gu,
    },
  ];

  for (const filePath of files) {
    const content = read(filePath);

    for (const { name, regex } of patterns) {
      let match;
      while ((match = regex.exec(content))) {
        const value = cleanLiteral(match[1]);
        if (!value || !hasHumanText(value) || HARD_CODED_UI_ALLOWLIST.has(value) || isExpressionFragment(value)) continue;

        const line = content.slice(0, match.index).split("\n").length;
        issues.push({
          file: path.relative(ROOT, filePath),
          line,
          value,
          kind: name,
        });
      }
    }
  }

  return issues;
};

const getStringLiteralText = (node) => {
  if (ts.isStringLiteralLike(node)) return node.text;
  return "";
};

const findLocalizedSourceLiterals = () => {
  const issues = [];
  const files = walk(SRC_DIR);

  for (const filePath of files) {
    const relativePath = path.relative(ROOT, filePath);
    if (LOCALIZED_LITERAL_ALLOWLIST.has(relativePath)) continue;

    const content = read(filePath);
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      const literalText = getStringLiteralText(node);
      if (literalText && hasLocalizedScript(literalText)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        issues.push({
          file: relativePath,
          line: line + 1,
          value: cleanLiteral(literalText),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return issues;
};

const getPropertyName = (expression) => {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return "";
};

const findHardcodedLocaleFormatting = () => {
  const issues = [];
  const files = walk(SRC_DIR);
  const localeMethods = new Set(["toLocaleDateString", "toLocaleString", "toLocaleTimeString"]);

  for (const filePath of files) {
    const relativePath = path.relative(ROOT, filePath);
    const content = read(filePath);
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    const visit = (node) => {
      if (ts.isCallExpression(node) && localeMethods.has(getPropertyName(node.expression))) {
        const firstArg = node.arguments[0];
        const locale = firstArg ? getStringLiteralText(firstArg) : "";

        if (locale) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart(sourceFile));
          issues.push({
            file: relativePath,
            line: line + 1,
            value: locale,
            method: getPropertyName(node.expression),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return issues;
};

const i18nContent = read(I18N_FILE);
const sourceBlock = extractLocaleBlock(i18nContent, SOURCE_LOCALE);
const sourceKeys = extractTranslationKeys(sourceBlock);
const usedKeys = extractUsedKeys();
const missingSourceKeys = [...usedKeys].filter((key) => !sourceKeys.has(key)).sort();
const hardcodedUiStrings = findHardcodedUiStrings();
const localizedSourceLiterals = findLocalizedSourceLiterals();
const hardcodedLocaleFormatting = findHardcodedLocaleFormatting();

if (missingSourceKeys.length > 0) {
  console.error("Missing source translation keys:");
  for (const key of missingSourceKeys) {
    console.error(`  - ${key}`);
  }
  process.exit(1);
}

if (hardcodedUiStrings.length > 0) {
  console.error("Hardcoded UI strings found. Move these through i18n or add a deliberate allowlist entry:");
  for (const issue of hardcodedUiStrings) {
    console.error(`  - ${issue.file}:${issue.line} [${issue.kind}] "${issue.value}"`);
  }
  process.exit(1);
}

if (localizedSourceLiterals.length > 0) {
  console.error("Localized source literals found outside the locale catalog. Move UI text through i18n or add a deliberate allowlist entry:");
  for (const issue of localizedSourceLiterals) {
    console.error(`  - ${issue.file}:${issue.line} "${issue.value}"`);
  }
  process.exit(1);
}

if (hardcodedLocaleFormatting.length > 0) {
  console.error("Hardcoded locale formatting found. Use the active i18n language when formatting dates, times, and numbers:");
  for (const issue of hardcodedLocaleFormatting) {
    console.error(`  - ${issue.file}:${issue.line} ${issue.method}("${issue.value}")`);
  }
  process.exit(1);
}

let hasPlaceholderError = false;
const sourceTranslations = extractTranslations(sourceBlock);

for (const locale of LOCALES) {
  const localeBlock = extractLocaleBlock(i18nContent, locale);
  const localeTranslations = extractTranslations(localeBlock);

  if (localeTranslations.size === 0) {
    console.error(`Locale "${locale}" has no translations.`);
    process.exit(1);
  }

  for (const [key, sourceValue] of sourceTranslations.entries()) {
    const translatedValue = localeTranslations.get(key);
    if (!translatedValue) continue;

    const sourcePlaceholders = extractPlaceholders(sourceValue);
    const translatedPlaceholders = extractPlaceholders(translatedValue);
    if (sourcePlaceholders.join("|") !== translatedPlaceholders.join("|")) {
      hasPlaceholderError = true;
      console.error(
        `Placeholder mismatch for ${locale}.${key}: expected [${sourcePlaceholders.join(", ")}], got [${translatedPlaceholders.join(", ")}]`,
      );
    }
  }
}

if (hasPlaceholderError) {
  process.exit(1);
}

console.log(`i18n check passed: ${usedKeys.size} used keys covered by ${sourceKeys.size} source keys.`);
