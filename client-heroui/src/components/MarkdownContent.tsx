/* ------------------------------------------------------------------
   MarkdownContent.tsx  v10.0.0  (2025-02-20 + theme support)
   ------------------------------------------------------------------ */

import React, { memo, useState, useEffect, useRef, ReactNode } from "react";
import Markdown from "markdown-to-jsx";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Image, Tooltip } from "@heroui/react";
import "katex/dist/katex.min.css";
import katex from "katex";
import { useTranslation } from "react-i18next";
import { markdownTaskMarkerOffsets } from "./codeAgentFilePreviewMode";
import {
  CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME,
  CodeAgentFileTagChipContent,
} from './CodeAgentFileTagChip';
import {
  normalizeCodeAgentMarkdownLinkDestination,
  resolveCodeAgentMarkdownFileLinkMeta,
  rewriteCodeAgentMarkdownFileUriHref,
  type CodeAgentMarkdownFileLinkMeta,
} from '../utils/codeAgentMarkdownLinks';
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from '../utils/codeAgentPierreIcons';
import { isBrowserPreviewFile } from './codeAgentFilePath';
import { CodeAgentPierreEntryIcon } from './CodeAgentPierreEntryIcon';

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
  onTaskListChange?: (change: { markerOffset: number; checked: boolean }) => void;
  onOpenWorkspaceFile?: (path: string) => void;
  onOpenWorkspaceFileInBrowserPreview?: (path: string) => void;
  workspaceRoot?: string | null;
}
interface CodeBlockProps {
  className?: string;
  children: ReactNode;
  fenceTitle?: string | null;
}
interface MathProps {
  children: ReactNode;
  inline?: boolean;
}
type MarkdownCodeElementProps = {
  className?: string;
  children: ReactNode;
} & Record<string, unknown>;

const codeBlockFrameClassName =
  "mb-2 max-w-full min-w-0 overflow-hidden rounded-lg border border-[#dedbd0] bg-[#fbfaf6] text-[#141413] shadow-[0_0_0_1px_rgba(194,192,182,0.18)] dark:border-[#3d3d3a] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-none";

const codeBlockHeaderClassName =
  "flex items-center justify-between border-b border-[#dedbd0] bg-[#f0eee6] px-2.5 py-1.5 text-[#4d4c48] dark:border-[#3d3d3a] dark:bg-[#1d1d1b] dark:text-[#e8e6dc]";

const codeBlockCopyButtonClassName =
  "rounded px-1.5 py-0.5 text-xs font-medium text-[#5e5d59] transition-colors hover:bg-[#dedbd0] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]";

const codeBlockBodyClassName =
  "overflow-x-auto bg-[#fbfaf6] whitespace-pre-wrap break-all dark:bg-[#242421]";

const inlineCodeClassName =
  "rounded-md border border-[#dedbd0] bg-[#f0eee6] px-1.5 py-0.5 font-mono text-[0.92em] font-semibold text-[#7a321f] shadow-[inset_0_0_0_1px_rgba(250,249,245,0.35)] before:content-none after:content-none dark:border-[#4d4c48] dark:bg-[#30302e] dark:text-[#ffd7c2] dark:shadow-none";

const CODE_AGENT_DEFAULT_WORKSPACE_ROOT = '/workspace';
const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)(?:language|lang)-([^\s]+)/;
const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;
const CODE_FENCE_OPENING_LINE_REGEX = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/;
const CODE_FENCE_TITLE_ATTRIBUTE_NAME = 'title';

function readResolvedTheme() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function useResolvedTheme() {
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(readResolvedTheme);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }
    const observer = new MutationObserver(() => setResolvedTheme(readResolvedTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return resolvedTheme;
}

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll('\\', '/')
      .split('/')
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join('/');
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join('/') === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = globalThis.Math.min(segments.length, globalThis.Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join('/'));
    }
  }

  return suffixByPath;
}

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeCodeAgentMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeCodeAgentMarkdownLinkDestination(href);
  return rewriteCodeAgentMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

function buildMarkdownFileLinkLabel(meta: CodeAgentMarkdownFileLinkMeta, parentSuffix: string | undefined): string {
  const labelParts = [meta.basename];
  if (typeof parentSuffix === 'string' && parentSuffix.length > 0) {
    labelParts.push(parentSuffix);
  }
  if (meta.line) {
    labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ''}`);
  }
  return labelParts.join(' · ');
}

function buildMarkdownFileOpenTarget(meta: CodeAgentMarkdownFileLinkMeta): string {
  const path = meta.workspaceRelativePath ?? meta.filePath;
  if (!meta.line) return path;
  return `${path}:${meta.line}${meta.column ? `:${meta.column}` : ''}`;
}

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? 'text';
  return raw === 'gitignore' ? 'ini' : raw;
}

function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function escapeFenceTitleAttribute(value: string): string {
  return value.replaceAll('"', '&quot;');
}

function normalizeCodeFenceTitles(markdown: string): string {
  const lines = markdown.split('\n');
  let activeFence: { marker: '`' | '~'; length: number } | null = null;

  return lines.map((line) => {
    const match = CODE_FENCE_OPENING_LINE_REGEX.exec(line);
    if (!match) {
      return line;
    }

    const fence = match[2]!;
    const marker = fence[0] as '`' | '~';
    const fenceLength = fence.length;

    if (activeFence) {
      if (marker === activeFence.marker && fenceLength >= activeFence.length) {
        activeFence = null;
      }
      return line;
    }

    const info = (match[3] ?? '').trim();
    const language = info.match(/^(\S+)/)?.[1];
    if (!language) {
      activeFence = { marker, length: fenceLength };
      return line;
    }

    const meta = info.slice(language.length).trim();
    const fenceTitle = extractFenceTitle(meta);
    activeFence = { marker, length: fenceLength };
    if (!fenceTitle) {
      return line;
    }

    return `${match[1]}${fence} ${language} ${CODE_FENCE_TITLE_ATTRIBUTE_NAME}="${escapeFenceTitleAttribute(fenceTitle)}"`;
  }).join('\n');
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: 'light' | 'dark';
}) {
  if (fenceTitle) {
    return (
      <>
        <CodeAgentPierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate uppercase tracking-wide">{language}</span>;
  }

  return (
    <Tooltip content={language} placement="top" size="sm" delay={400}>
      <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`}>
        <CodeAgentPierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </span>
    </Tooltip>
  );
}

function extractCodeFenceTitle(props: Record<string, unknown>): string | null {
  for (const key of ['title', 'file', 'filename']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** 预处理：移除仅分割线行 */
const removeSeparators = (content: string): string =>
  content
    .split("\n")
    .filter((line) => !/^\s*[-=]+\s*$/.test(line.trim()))
    .join("\n");

/** 修复引用块：遇到单行引用后插入空行 */
const fixQuoteBlocks = (content: string): string => {
  const lines = content.split("\n"),
    result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>\s*/.test(line)) {
      result.push(line);
      const next = lines[i + 1] || "";
      if (!/^\s*>\s*/.test(next) && next.trim() !== "") result.push("");
    } else result.push(line);
  }
  return result.join("\n");
};

function escapeRawHtmlTags(content: string): string {
  return content.split("<").join("&lt;").split(">").join("&gt;");
}

/** 数学公式解析 */
const parseMath = (content: string): string => {
  let text = content;
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => `<MathBlock>${f.trim()}</MathBlock>`);
  text = text.replace(/(^|[^\\])\$((?:[^$\\]|\\.)+?)\$/g, (_, p, f) => `${p}<MathInline>${f}</MathInline>`);
  return text;
};

/** 综合预处理 */
const preprocessMarkdown = (content: string): string => {
  let text = removeSeparators(content);
  text = fixQuoteBlocks(text);
  return normalizeCodeFenceTitles(text);
};

/** KaTeX 渲染组件 */
const Math: React.FC<MathProps> = ({ children, inline = false }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState<string | null>(null);
  const mathSource = React.useMemo(() => React.Children.toArray(children).join(''), [children]);
  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(mathSource.trim(), ref.current, {
        displayMode: !inline,
        throwOnError: false,
        strict: false,
        trust: false,
        macros: { "\\RR": "\\mathbb{R}" },
        errorColor: "#EF4444",
      });
      setError(null);
    } catch (e) {
      setError(String(e));
      ref.current.textContent = mathSource;
    }
  }, [mathSource, inline]);
  return error ? (
    <span className="rounded bg-danger-50 p-1 text-danger-700">{t('formulaRenderError')}</span>
  ) : (
    <span ref={ref} className={inline ? "inline-block align-middle" : "block text-center my-2"} />
  );
};

/** 块级代码组件（支持 Mermaid 渲染） */
const CodeBlock = memo<CodeBlockProps>(({ className, children, fenceTitle = null }) => {
  const { t } = useTranslation();
  const [themeDark, setThemeDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, []);

  const language = extractFenceLanguage(className);
  const code = String(children).replace(/\n$/, "");

  const copyTimeout = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      copyTimeout.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };
  useEffect(
    () => () => {
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
    },
    []
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [mermaidId] = useState(() => "mermaid-" + globalThis.Math.random().toString(36).substr(2, 9));

  // Mermaid 渲染
  useEffect(() => {
    if (language !== "mermaid" || !containerRef.current) return;

    let isCurrent = true;
    const container = containerRef.current;
    container.innerHTML = "";

    import("mermaid")
      .then(({ default: mermaid }) => {
        if (!isCurrent) return null;
        mermaid.initialize({ startOnLoad: false, theme: themeDark ? "dark" : "default" });
        return mermaid.render(mermaidId, code);
      })
      .then((result) => {
        if (!result || !isCurrent || containerRef.current !== container) return;
        container.innerHTML = result.svg;
      })
      .catch(err => {
        console.error("Mermaid render error:", err);
        if (!isCurrent || containerRef.current !== container) return;

        container.innerHTML = "";
        const errorElement = document.createElement("div");
        errorElement.className = "text-red-500";
        errorElement.textContent = t('mermaidRenderError');
        container.appendChild(errorElement);
      });

    return () => {
      isCurrent = false;
    };
  }, [language, code, themeDark, mermaidId, t]);


  if (language === "mermaid") {
    return (
      <div className={codeBlockFrameClassName}>
        <div className={codeBlockHeaderClassName}>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={themeDark ? 'dark' : 'light'}
            />
          </span>
          <button onClick={handleCopy} className={codeBlockCopyButtonClassName}>
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
        <div
          ref={containerRef}
          className="whitespace-pre-wrap break-all bg-[#faf9f5] p-2 dark:bg-[#1d1d1b]"
        />
      </div>
    );
  }

  // 普通代码高亮
  return (
    // Outer container for border and header
    <div className={codeBlockFrameClassName}>
      {/* Header */}
      <div className={codeBlockHeaderClassName}>
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={themeDark ? 'dark' : 'light'}
          />
        </span>
        <button onClick={handleCopy} className={codeBlockCopyButtonClassName}>
          {copied ? t('copied') : t('copy')}
        </button>
      </div>

      {/* Add this wrapper div for horizontal scrolling */}
      <div className={codeBlockBodyClassName}>
        <SyntaxHighlighter
          language={language}
          style={themeDark ? oneDark : oneLight}
          showLineNumbers
          wrapLines={true} // Keep wrapLines for better readability within the scrollable area
          customStyle={{
            margin: '0',      // Remove default margins
            padding: '0.5rem', // Add some internal padding
            // Ensure background matches the theme if not inherited correctly
            // background: 'transparent', // Or set specific theme background
            boxSizing: 'border-box',
            // Let highlighter itself inherit pre-wrap
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
          // Optional: If styles conflict, force pre tag to behave like a block
          // PreTag="div"
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
});
CodeBlock.displayName = "CodeBlock";

/** 主组件 */
export const MarkdownContent: React.FC<MarkdownContentProps> = memo(({
  content,
  isStreaming,
  onTaskListChange,
  onOpenWorkspaceFile,
  onOpenWorkspaceFileInBrowserPreview,
  workspaceRoot,
}) => {
  const resolvedTheme = useResolvedTheme();
  const resolvedWorkspaceRoot = workspaceRoot === undefined
    ? CODE_AGENT_DEFAULT_WORKSPACE_ROOT
    : workspaceRoot || undefined;
  const processed = React.useMemo(() => {
    const text = escapeRawHtmlTags(preprocessMarkdown(content));
    return parseMath(text);
  }, [content]);
  const canOpenWorkspaceLinks = Boolean(onOpenWorkspaceFile || onOpenWorkspaceFileInBrowserPreview);
  const markdownFileLinkMetaByHref = React.useMemo(() => {
    const metaByHref = new Map<string, CodeAgentMarkdownFileLinkMeta>();
    if (!canOpenWorkspaceLinks) {
      return metaByHref;
    }
    for (const href of extractMarkdownLinkHrefs(content)) {
      const normalizedHref = normalizeCodeAgentMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveCodeAgentMarkdownFileLinkMeta(normalizedHref, resolvedWorkspaceRoot);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [canOpenWorkspaceLinks, content, resolvedWorkspaceRoot]);
  const fileLinkParentSuffixByPath = React.useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const taskMarkerOffsets = React.useMemo(() => markdownTaskMarkerOffsets(content), [content]);
  let taskInputIndex = 0;

  const mdOptions = {
    forceBlock: true,
    // User-authored raw HTML is escaped before this point. Raw parsing remains
    // enabled only so our internal MathInline/MathBlock bridge can render.
    disableParsingRawHTML: false,
    overrides: {
      p: { component: ({ children }: { children: ReactNode }) => <div>{children}</div> },
      MathBlock: { component: ({ children }: any) => <Math inline={false}>{children}</Math> },
      MathInline: { component: ({ children }: any) => <Math inline>{children}</Math> },
      // 将代码块渲染为 CodeBlock
      pre: {
        component: ({ children }: { children: ReactNode }) => {
          // children 是单个 <code> 元素
          const codeElement = React.Children.only(children) as React.ReactElement<MarkdownCodeElementProps>;
          return (
            <CodeBlock
              className={codeElement.props.className}
              fenceTitle={extractCodeFenceTitle(codeElement.props)}
            >
              {codeElement.props.children}
            </CodeBlock>
          );
        }
      },
      // 行内代码统一渲染为普通文本
      code: { component: ({ children }: { children: ReactNode }) => (
        <code className={inlineCodeClassName}>
          {children}
        </code>
      ) },
      a: {
        component: ({ children, href, className, ...props }: any) => {
          const normalizedHref = typeof href === 'string' ? normalizeCodeAgentMarkdownLinkHrefKey(href) : '';
          const fileLinkMeta = canOpenWorkspaceLinks && normalizedHref
            ? markdownFileLinkMetaByHref.get(normalizedHref)
              ?? resolveCodeAgentMarkdownFileLinkMeta(normalizedHref, resolvedWorkspaceRoot)
            : null;
          if (!fileLinkMeta) {
            return <a href={href} className={className} {...props}>{children}</a>;
          }
          const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);

          const fileLinkClassName = [
            CODE_AGENT_CHAT_FILE_TAG_CHIP_CLASS_NAME,
            'cursor-pointer align-middle no-underline transition-colors hover:bg-[#f0eee6] dark:hover:bg-[#242421]',
            className,
          ].filter(Boolean).join(' ');

          return (
            <a
              href={fileLinkMeta.targetPath}
              {...props}
              className={fileLinkClassName}
              title={fileLinkMeta.displayPath}
              data-testid="code-agent-markdown-file-link"
              data-markdown-copy={`[${fileLinkMeta.basename}](${normalizedHref || href || fileLinkMeta.targetPath})`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (
                  onOpenWorkspaceFileInBrowserPreview &&
                  fileLinkMeta.workspaceRelativePath &&
                  isBrowserPreviewFile(fileLinkMeta.workspaceRelativePath)
                ) {
                  onOpenWorkspaceFileInBrowserPreview(fileLinkMeta.workspaceRelativePath);
                  return;
                }
                onOpenWorkspaceFile?.(buildMarkdownFileOpenTarget(fileLinkMeta));
              }}
            >
              <CodeAgentFileTagChipContent
                path={fileLinkMeta.filePath}
                label={buildMarkdownFileLinkLabel(fileLinkMeta, parentSuffix)}
                theme={resolvedTheme}
                selectable
              />
            </a>
          );
        },
      },
      img: {
        component: ({ alt, src }: any) => <Image src={src!} alt={alt} className="max-w-full rounded my-2" isBlurred />,
      },
      input: {
        component: ({ checked, readOnly, type, ...props }: any) => {
          if (type !== 'checkbox' || !onTaskListChange) {
            return <input {...props} checked={checked} readOnly={readOnly} type={type} />;
          }

          const markerOffset = taskMarkerOffsets[taskInputIndex++] ?? -1;
          return (
            <input
              {...props}
              checked={Boolean(checked)}
              readOnly={false}
              type="checkbox"
              onChange={(event) => onTaskListChange({
                markerOffset,
                checked: event.currentTarget.checked,
              })}
            />
          );
        },
      },
    },
  };

  return (
    <div className="markdown-container message-markdown prose prose-sm max-w-full text-current">
      <Markdown options={mdOptions}>{processed}</Markdown>
      {isStreaming && <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5 align-baseline"></span>}
    </div>
  );
});
MarkdownContent.displayName = "MarkdownContent";
