/* ------------------------------------------------------------------
   MarkdownContent.tsx  v10.0.0  (2025-02-20 + theme support)
   ------------------------------------------------------------------ */

import React, { memo, useState, useEffect, useRef, ReactNode } from "react";
import Markdown from "markdown-to-jsx";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Icon } from "@iconify/react";
import { Image } from "@heroui/react";
import "katex/dist/katex.min.css";
import katex from "katex";
import { Tooltip } from "@heroui/react";
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
  children: string;
  inline?: boolean;
}

const tooltipClassNames = {
  content: "border border-[#dedbd0] bg-[#faf9f5] px-2 py-1 text-xs font-medium text-[#141413] shadow-lg dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]",
};

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
  useEffect(() => {
    if (!ref.current) return;
    try {
      katex.render(children.trim(), ref.current, {
        displayMode: !inline,
        throwOnError: false,
        strict: false,
        trust: true,
        macros: { "\\RR": "\\mathbb{R}" },
        errorColor: "#EF4444",
      });
      setError(null);
    } catch (e) {
      setError(String(e));
      ref.current.textContent = children;
    }
  }, [children, inline]);
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
      <div className="mb-2 max-w-full min-w-0 overflow-hidden rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#141413] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]">
        <div className="flex items-center justify-between bg-[#30302e] px-2 py-1 text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]">
          <span className="text-xs uppercase">{language}</span>
          <button onClick={handleCopy} className="rounded px-1 text-xs transition-colors hover:bg-white/10 dark:hover:bg-black/10">
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
    <div className="mb-2 max-w-full min-w-0 overflow-hidden rounded-lg border border-[#dedbd0] bg-[#faf9f5] text-[#141413] dark:border-[#30302e] dark:bg-[#1d1d1b] dark:text-[#faf9f5]">
      {/* Header */}
      <div className="flex items-center justify-between bg-[#30302e] px-2 py-1 text-[#faf9f5] dark:bg-[#faf9f5] dark:text-[#141413]">
        <span className="text-xs uppercase">{language}</span>
        <button onClick={handleCopy} className="rounded px-1 text-xs transition-colors hover:bg-white/10 dark:hover:bg-black/10">
          {copied ? t('copied') : t('copy')}
        </button>
      </div>

      {/* Add this wrapper div for horizontal scrolling */}
      <div
        className="overflow-x-auto bg-[#faf9f5] whitespace-pre-wrap break-all dark:bg-[#1d1d1b]"
      > {/* Apply background here too */}
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

/** 操作按钮（复制/点赞/点踩） */
const ContentActionButtons: React.FC<{ content: string }> = memo(({ content }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const copyRef = useRef<number | null>(null);
  const handleCopyRaw = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (copyRef.current) clearTimeout(copyRef.current);
      copyRef.current = window.setTimeout(() => setCopied(false), 2000);
    });
  };
  const toggleLike = () => {
    setLiked((v) => !v);
    if (!liked) setDisliked(false);
  };
  const toggleDislike = () => {
    setDisliked((v) => !v);
    if (!disliked) setLiked(false);
  };
  useEffect(
    () => () => {
      if (copyRef.current) clearTimeout(copyRef.current);
    },
    []
  );
  const renderButton = ({
    onClick,
    icon,
    activeIcon,
    isActive,
    disabled,
    tooltip,
    activeTooltip,
  }: {
    onClick: () => void;
    icon: ReactNode;
    activeIcon?: ReactNode;
    isActive?: boolean;
    disabled?: boolean;
    tooltip: string;
    activeTooltip?: string;
  }) => (
    <Tooltip content={t(isActive && activeTooltip ? activeTooltip : tooltip)} classNames={tooltipClassNames}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={
          `p-0.5 rounded-full transition active:scale-95 ` +
          (disabled
            ? "opacity-40 cursor-not-allowed"
            : `text-current opacity-70 hover:bg-current/10 hover:opacity-100 ${isActive ? "text-[#c96442] opacity-100 dark:text-[#d97757]" : ""}`)
        }
        aria-label={t(isActive && activeTooltip ? activeTooltip : tooltip)}
      >
        {isActive && activeIcon ? activeIcon : icon}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-3 mt-1">
      {renderButton({
        onClick: handleCopyRaw,
        icon: <Icon icon="lucide:copy" />,
        activeIcon: <Icon icon="lucide:check" />,
        isActive: copied,
        tooltip: "copy",
        activeTooltip: "copied",
      })}
      {renderButton({
        onClick: toggleLike,
        icon: <Icon icon="tabler:thumb-up" />,
        activeIcon: <Icon icon="tabler:thumb-up" />,
        isActive: liked,
        tooltip: "like",
        activeTooltip: "cancelLike",
      })}
      {renderButton({
        onClick: toggleDislike,
        icon: <Icon icon="tabler:thumb-down" />,
        activeIcon: <Icon icon="tabler:thumb-down" />,
        isActive: disliked,
        tooltip: "dislike",
        activeTooltip: "cancelDislike",
      })}
    </div>
  );
});
ContentActionButtons.displayName = "ContentActionButtons";

/** 主组件 */
export const MarkdownContent: React.FC<MarkdownContentProps> = memo(({ content, isStreaming }) => {
  const processed = React.useMemo(() => {
    let text = preprocessMarkdown(content);
    return parseMath(text);
  }, [content]);

  const mdOptions = {
    forceBlock: true,
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
        <code className="rounded bg-current/10 px-1 font-mono text-xs text-inherit">
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
      {isStreaming
        ? <span className="inline-block w-1.5 h-3 bg-current animate-pulse ml-0.5 align-baseline"></span>
        : <ContentActionButtons content={content} />
      }
    </div>
  );
});
MarkdownContent.displayName = "MarkdownContent";
