/* ------------------------------------------------------------------
   MarkdownContent.tsx  v10.0.0  (2025-02-20 + theme support)
   ------------------------------------------------------------------ */

import React, { memo, useState, useEffect, useRef, ReactNode } from "react";
import Markdown from "markdown-to-jsx";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Image } from "@heroui/react";
import "katex/dist/katex.min.css";
import katex from "katex";
import { useTranslation } from "react-i18next";

interface MarkdownContentProps {
  content: string;
  isStreaming?: boolean;
}
interface CodeBlockProps {
  className?: string;
  children: ReactNode;
}
interface MathProps {
  children: ReactNode;
  inline?: boolean;
}

const codeBlockFrameClassName =
  "mb-2 max-w-full min-w-0 overflow-hidden rounded-lg border border-[#dedbd0] bg-[#fbfaf6] text-[#141413] shadow-[0_0_0_1px_rgba(194,192,182,0.18)] dark:border-[#3d3d3a] dark:bg-[#242421] dark:text-[#faf9f5] dark:shadow-none";

const codeBlockHeaderClassName =
  "flex items-center justify-between border-b border-[#dedbd0] bg-[#f0eee6] px-2.5 py-1.5 text-[#4d4c48] dark:border-[#3d3d3a] dark:bg-[#1d1d1b] dark:text-[#e8e6dc]";

const codeBlockCopyButtonClassName =
  "rounded px-1.5 py-0.5 text-xs font-medium text-[#5e5d59] transition-colors hover:bg-[#dedbd0] hover:text-[#141413] dark:text-[#b0aea5] dark:hover:bg-[#30302e] dark:hover:text-[#faf9f5]";

const codeBlockBodyClassName =
  "overflow-x-auto bg-[#fbfaf6] whitespace-pre-wrap break-all dark:bg-[#242421]";

const inlineCodeClassName =
  "rounded-md border border-[#dedbd0] bg-[#f0eee6] px-1.5 py-0.5 font-mono text-[0.92em] font-semibold text-[#7a321f] shadow-[inset_0_0_0_1px_rgba(250,249,245,0.35)] dark:border-[#4d4c48] dark:bg-[#30302e] dark:text-[#ffd7c2] dark:shadow-none";

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
  return fixQuoteBlocks(text);
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
const CodeBlock = memo<CodeBlockProps>(({ className, children }) => {
  const { t } = useTranslation();
  const [themeDark, setThemeDark] = useState(
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  );
  useEffect(() => {
    const obs = new MutationObserver(() => setThemeDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true });
    return () => obs.disconnect();
  }, []);

  const match = /(?:language|lang)-(\w+)/.exec(className || "");
  const language = match ? match[1] : "text";
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
          <span className="text-xs font-semibold uppercase tracking-wide">{language}</span>
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
        <span className="text-xs font-semibold uppercase tracking-wide">{language}</span>
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
export const MarkdownContent: React.FC<MarkdownContentProps> = memo(({ content, isStreaming }) => {
  const processed = React.useMemo(() => {
    const text = escapeRawHtmlTags(preprocessMarkdown(content));
    return parseMath(text);
  }, [content]);

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
          const codeElement = React.Children.only(children) as React.ReactElement & { props: { className?: string; children: ReactNode } };
          return <CodeBlock className={codeElement.props.className}>{codeElement.props.children}</CodeBlock>;
        }
      },
      // 行内代码统一渲染为普通文本
      code: { component: ({ children }: { children: ReactNode }) => (
        <code className={inlineCodeClassName}>
          {children}
        </code>
      ) },
      img: {
        component: ({ alt, src }: any) => <Image src={src!} alt={alt} className="max-w-full rounded my-2" isBlurred />,
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
