import React from 'react';
import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Message } from '../utils/types';
import { getCodeAgentModeLabelKey, normalizeCodeAgentMode } from '../utils/codeAgent';

interface CocoToolMessageProps {
  message: Message;
  pairedResult?: Message;
}

const OUTPUT_COLLAPSE_LIMIT = 1200;
const STRUCTURED_VALUE_LIMIT = 5000;

interface DetailRow {
  key: string;
  label: string;
  value: string;
}

interface CodeBlockData {
  key: string;
  label: string;
  language: string;
  code: string;
  terminal?: boolean;
}

type Translate = (key: string) => string;

const FILE_ARG_KEYS = ['file_path', 'path', 'filename'] as const;

const ARG_LABEL_KEYS: Record<string, string> = {
  file_path: 'toolFile',
  path: 'toolFile',
  filename: 'toolFile',
  command: 'toolCommand',
  content: 'toolContent',
  old_string: 'toolBefore',
  new_string: 'toolAfter',
  pattern: 'toolPattern',
  query: 'toolQuery',
  url: 'toolUrl',
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  diff: 'diff',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  less: 'less',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'tsx',
  txt: 'text',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isScalar = (value: unknown) => {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
};

const displayScalar = (value: unknown) => {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
};

const truncateText = (value: string, limit = STRUCTURED_VALUE_LIMIT) => {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

const prettyArgKey = (key: string) => {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
};

const labelForArgKey = (key: string, t: Translate) => {
  const translationKey = ARG_LABEL_KEYS[key];
  return translationKey ? t(translationKey) : prettyArgKey(key);
};

const readStringArg = (args: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return { key, value };
    }
  }
  return null;
};

const formatStructuredValue = (value: unknown, depth = 0): string => {
  const indent = '  '.repeat(depth);
  const nextIndent = '  '.repeat(depth + 1);

  if (isScalar(value)) {
    return `${indent}${displayScalar(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}No items`;
    return value.map((item, index) => {
      if (isRecord(item)) {
        return `${indent}Item ${index + 1}\n${formatStructuredValue(item, depth + 1)}`;
      }
      return `${indent}- ${formatStructuredValue(item, 0).trim()}`;
    }).join('\n');
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${indent}No fields`;
    return entries.map(([key, nestedValue]) => {
      if (isScalar(nestedValue)) {
        return `${indent}${prettyArgKey(key)}: ${displayScalar(nestedValue)}`;
      }
      return `${indent}${prettyArgKey(key)}:\n${formatStructuredValue(nestedValue, depth + 1)}`;
    }).join('\n');
  }

  return `${nextIndent}${String(value)}`;
};

const inferLanguageFromPath = (path?: string) => {
  if (!path) return 'text';
  const cleanPath = path.split('?')[0].split('#')[0];
  const extension = cleanPath.includes('.') ? cleanPath.split('.').pop()?.toLowerCase() : undefined;
  return extension ? EXTENSION_LANGUAGES[extension] || 'text' : 'text';
};

const inferLanguageFromContent = (content: string, path?: string) => {
  const byPath = inferLanguageFromPath(path);
  if (byPath !== 'text') return byPath;
  const trimmed = content.trimStart();
  if (trimmed.startsWith('#!/usr/bin/env python') || trimmed.startsWith('#!/usr/bin/python')) return 'python';
  if (trimmed.startsWith('#!/usr/bin/env bash') || trimmed.startsWith('#!/bin/bash')) return 'bash';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return 'text';
};

const isShellTool = (toolName: string) => {
  const lower = toolName.toLowerCase();
  return lower === 'bash' || lower.includes('shell') || lower.includes('terminal');
};

const getToolSummary = (message: Message): string => {
  const args = message.toolArgs;
  if (!args) return '';
  const filePath = args.file_path || args.path || args.filename;
  if (typeof filePath === 'string') {
    const segments = filePath.split('/');
    return segments.length > 2
      ? `…/${segments.slice(-2).join('/')}`
      : filePath;
  }
  const command = args.command;
  if (typeof command === 'string') {
    return command.length > 60 ? `${command.slice(0, 57)}…` : command;
  }
  const query = args.query || args.url || args.pattern;
  if (typeof query === 'string') {
    return query.length > 60 ? `${query.slice(0, 57)}…` : query;
  }
  return '';
};

const getToolIcon = (toolName: string): string => {
  const lower = toolName.toLowerCase();
  if (lower === 'read') return 'lucide:file-text';
  if (lower === 'edit') return 'lucide:pencil';
  if (lower === 'write') return 'lucide:file-plus';
  if (lower === 'bash' || lower.includes('shell')) return 'lucide:terminal';
  if (lower.includes('search') || lower.includes('grep')) return 'lucide:search';
  if (lower.includes('web') || lower.includes('fetch')) return 'lucide:globe';
  if (lower.includes('list') || lower.includes('glob')) return 'lucide:folder-open';
  return 'lucide:wrench';
};

const getModeLabel = (message: Message, t: Translate) => {
  if (message.codeAgentMode) {
    return t(getCodeAgentModeLabelKey(normalizeCodeAgentMode(message.codeAgentMode)));
  }
  return '';
};

const useThemeDark = () => {
  const [themeDark, setThemeDark] = React.useState(
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );

  React.useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      setThemeDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => observer.disconnect();
  }, []);

  return themeDark;
};

const buildToolArgView = (args: Record<string, unknown> | undefined, t: Translate) => {
  const rows: DetailRow[] = [];
  const codeBlocks: CodeBlockData[] = [];
  const consumed = new Set<string>();

  if (!args || Object.keys(args).length === 0) {
    return { rows, codeBlocks, hasContent: false };
  }

  const fileArg = readStringArg(args, FILE_ARG_KEYS);
  const filePath = fileArg?.value;
  if (fileArg) {
    consumed.add(fileArg.key);
    rows.push({ key: fileArg.key, label: t('toolFile'), value: fileArg.value });
  }

  const command = typeof args.command === 'string' ? args.command : '';
  if (command) {
    consumed.add('command');
    codeBlocks.push({
      key: 'command',
      label: t('toolCommand'),
      language: 'bash',
      code: command,
      terminal: true,
    });
  }

  for (const key of ['pattern', 'query', 'url']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      consumed.add(key);
      rows.push({ key, label: labelForArgKey(key, t), value });
    }
  }

  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  if (oldString) {
    consumed.add('old_string');
    codeBlocks.push({
      key: 'old_string',
      label: t('toolBefore'),
      language: inferLanguageFromContent(oldString, filePath),
      code: oldString,
    });
  }
  if (newString) {
    consumed.add('new_string');
    codeBlocks.push({
      key: 'new_string',
      label: t('toolAfter'),
      language: inferLanguageFromContent(newString, filePath),
      code: newString,
    });
  }

  const content = typeof args.content === 'string' ? args.content : '';
  if (content) {
    consumed.add('content');
    codeBlocks.push({
      key: 'content',
      label: t('toolContent'),
      language: inferLanguageFromContent(content, filePath),
      code: content,
    });
  }

  const edits = args.edits;
  if (Array.isArray(edits)) {
    consumed.add('edits');
    edits.forEach((edit, index) => {
      if (!isRecord(edit)) return;
      const editOldString = typeof edit.old_string === 'string' ? edit.old_string : '';
      const editNewString = typeof edit.new_string === 'string' ? edit.new_string : '';
      if (editOldString) {
        codeBlocks.push({
          key: `edit_${index}_old`,
          label: `${t('toolChange')} ${index + 1} · ${t('toolBefore')}`,
          language: inferLanguageFromContent(editOldString, filePath),
          code: editOldString,
        });
      }
      if (editNewString) {
        codeBlocks.push({
          key: `edit_${index}_new`,
          label: `${t('toolChange')} ${index + 1} · ${t('toolAfter')}`,
          language: inferLanguageFromContent(editNewString, filePath),
          code: editNewString,
        });
      }
    });
  }

  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key)) continue;
    if (isScalar(value)) {
      rows.push({ key, label: labelForArgKey(key, t), value: displayScalar(value) });
      continue;
    }
    codeBlocks.push({
      key,
      label: labelForArgKey(key, t),
      language: 'text',
      code: truncateText(formatStructuredValue(value)),
    });
  }

  return { rows, codeBlocks, hasContent: rows.length > 0 || codeBlocks.length > 0 };
};

interface CodeSnippetProps {
  code: string;
  language: string;
  terminal?: boolean;
  themeDark: boolean;
  tone?: 'default' | 'danger';
  maxHeightClass?: string;
  copyLabel: string;
  copiedLabel: string;
}

const CodeSnippet: React.FC<CodeSnippetProps> = ({
  code, language, terminal, themeDark, tone = 'default', maxHeightClass, copyLabel, copiedLabel,
}) => {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<number | null>(null);
  const showLineNumbers = !terminal && code.includes('\n');

  React.useEffect(() => () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className={`group/code relative overflow-hidden rounded-lg ${
      tone === 'danger'
        ? 'bg-danger-50 dark:bg-danger-950/30'
        : 'bg-[#f0eee6] dark:bg-[#242421]'
    }`}>
      <div className={maxHeightClass ? `${maxHeightClass} overflow-auto` : ''}>
        <SyntaxHighlighter
          language={language}
          style={themeDark ? oneDark : oneLight}
          showLineNumbers={showLineNumbers}
          wrapLongLines
          customStyle={{
            margin: 0,
            padding: '0.5rem 0.75rem',
            background: 'transparent',
            fontSize: '0.75rem',
            lineHeight: '1.4',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          codeTagProps={{ style: { background: 'transparent' } }}
          lineNumberStyle={{ minWidth: '2em', color: themeDark ? '#6b6a65' : '#b0aea5' }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
      <button
        type="button"
        className="absolute right-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-[#87867f] opacity-0 transition-opacity hover:bg-[#dedbd0]/60 hover:text-[#4d4c48] group-hover/code:opacity-100 dark:text-[#8f8d86] dark:hover:bg-[#30302e]/60 dark:hover:text-[#c8c6be]"
        onClick={handleCopy}
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
};

export const CocoToolMessage: React.FC<CocoToolMessageProps> = ({ message, pairedResult }) => {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);
  const themeDark = useThemeDark();

  const isToolCall = message.messageType === 'tool_call';
  const isSandboxStatus = message.messageType === 'sandbox_status';

  if (isSandboxStatus) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-0.5">
        <Icon icon="lucide:box" className="h-3 w-3 flex-shrink-0 text-[#87867f] dark:text-[#8f8d86]" />
        <span className="text-xs text-[#87867f] dark:text-[#8f8d86]">
          {message.content || t('sandboxStatusEvent')}
        </span>
      </div>
    );
  }

  const isToolResult = message.messageType === 'tool_result';
  const toolName = message.toolName || t('unknownTool');
  const summary = isToolCall ? getToolSummary(message) : '';
  const icon = getToolIcon(toolName);

  const result = isToolResult ? message : pairedResult;
  const hasResult = !!result;
  const isError = result?.isError || result?.status === 'error';
  const isSuccess = hasResult && !isError;
  const isPending = isToolCall && !hasResult;
  const modeLabel = getModeLabel(message, t);

  const output = result?.toolOutputPreview || result?.content || '';
  const shouldCollapseOutput = output.length > OUTPUT_COLLAPSE_LIMIT;
  const visibleOutput = shouldCollapseOutput && !isOutputExpanded
    ? `${output.slice(0, OUTPUT_COLLAPSE_LIMIT)}…`
    : output;

  const argsView = isToolCall ? buildToolArgView(message.toolArgs, t) : null;
  const filePath = isToolCall && message.toolArgs
    ? readStringArg(message.toolArgs, FILE_ARG_KEYS)?.value
    : undefined;
  const outputLanguage = isShellTool(toolName)
    ? 'bash'
    : inferLanguageFromContent(visibleOutput || '', filePath);

  return (
    <div className="my-0.5 max-w-full">
      <button
        type="button"
        data-testid={isToolCall ? 'coco-tool-call' : 'coco-tool-result'}
        className={`
          group/tool flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg
          border px-2.5 py-1.5 text-left transition-colors
          ${isError
            ? 'border-danger-300/50 bg-danger-50/50 hover:bg-danger-50 dark:border-danger-500/30 dark:bg-danger-500/5 dark:hover:bg-danger-500/10'
            : 'border-[#dedbd0]/80 bg-[#f5f4ef]/60 hover:bg-[#efede5] dark:border-[#3a3a37]/80 dark:bg-[#242421]/60 dark:hover:bg-[#2a2a27]'
          }
        `}
        onClick={() => setIsExpanded(v => !v)}
        aria-expanded={isExpanded}
      >
        <Icon
          icon={icon}
          className={`h-3.5 w-3.5 flex-shrink-0 ${isError ? 'text-danger-500 dark:text-danger-400' : 'text-[#87867f] dark:text-[#8f8d86]'}`}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#4d4c48] dark:text-[#c8c6be]">
          {toolName}
          {summary && (
            <span className="ml-1 font-normal text-[#87867f] dark:text-[#8f8d86]">{summary}</span>
          )}
        </span>

        {modeLabel && (
          <span className="rounded-full border border-[#dedbd0] px-1.5 py-0.5 text-[10px] font-semibold text-[#5e5d59] dark:border-[#3a3a37] dark:text-[#b0aea5]">
            {modeLabel}
          </span>
        )}

        {isPending && (
          <span className="ml-auto inline-block h-3 w-3 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-[#87867f] border-t-transparent dark:border-[#8f8d86] dark:border-t-transparent" />
        )}
        {isSuccess && (
          <Icon icon="lucide:check" className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-emerald-500 dark:text-emerald-400" />
        )}
        {isError && (
          <Icon icon="lucide:x" className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-danger-500 dark:text-danger-400" />
        )}
        {typeof result?.exitCode === 'number' && result.exitCode !== 0 && (
          <span className="ml-0.5 text-[10px] font-mono text-danger-500 dark:text-danger-400">
            E{result.exitCode}
          </span>
        )}
        <Icon
          icon="lucide:chevron-right"
          className={`h-3 w-3 flex-shrink-0 text-[#b0aea5] transition-transform dark:text-[#6b6a65] ${isExpanded ? 'rotate-90' : ''}`}
        />
      </button>

      {isExpanded && (
        <div className="mt-1 space-y-1.5 pl-6 pr-1">
          {argsView?.rows.map(row => (
            <div key={row.key} className="flex items-baseline gap-2 text-xs">
              <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#87867f] dark:text-[#8f8d86]">
                {row.label}
              </span>
              <span className="min-w-0 break-all font-mono text-[11px] text-[#4d4c48] dark:text-[#c8c6be]">
                {row.value}
              </span>
            </div>
          ))}

          {argsView?.codeBlocks.map(block => (
            <div key={block.key}>
              <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#87867f] dark:text-[#8f8d86]">
                {block.label}
              </div>
              <CodeSnippet
                code={block.code}
                language={block.language}
                terminal={block.terminal}
                themeDark={themeDark}
                maxHeightClass="max-h-[200px]"
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
              />
            </div>
          ))}

          {hasResult && (
            <div className={`${argsView?.hasContent ? 'border-t border-[#dedbd0]/40 pt-1.5 dark:border-[#3a3a37]/40' : ''}`}>
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${
                  isError ? 'text-danger-500 dark:text-danger-400' : 'text-[#87867f] dark:text-[#8f8d86]'
                }`}>
                  {t(isError ? 'toolResultFailed' : 'toolOutput')}
                </span>
                {typeof result.exitCode === 'number' && (
                  <span className="text-[10px] font-mono text-[#87867f] dark:text-[#8f8d86]">
                    {t('exitCode')} {result.exitCode}
                  </span>
                )}
              </div>
              <CodeSnippet
                code={visibleOutput || t('emptyToolOutput')}
                language={outputLanguage}
                terminal={isShellTool(toolName)}
                themeDark={themeDark}
                tone={isError ? 'danger' : 'default'}
                maxHeightClass={shouldCollapseOutput && !isOutputExpanded ? '' : 'max-h-[320px]'}
                copyLabel={t('copy')}
                copiedLabel={t('copied')}
              />
              {shouldCollapseOutput && (
                <button
                  type="button"
                  className="mt-1 text-[11px] font-medium text-[#87867f] hover:text-[#4d4c48] dark:text-[#8f8d86] dark:hover:text-[#c8c6be]"
                  onClick={(e) => { e.stopPropagation(); setIsOutputExpanded(v => !v); }}
                >
                  {isOutputExpanded ? t('showLess') : t('showMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
