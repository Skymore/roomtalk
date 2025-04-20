/* ------------------------------------------------------------------
   MarkdownContent.tsx  v10.0.0  (2025-02-20 + theme support)
   ------------------------------------------------------------------ */

import React, { memo, useState, useEffect, useRef, ReactNode } from "react";
import Markdown from "markdown-to-jsx";
import mermaid from "mermaid";
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
}
interface CodeBlockProps {
  className?: string;
  children: ReactNode;
}
interface MathProps {
  children: string;
  inline?: boolean;
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
    <span className="katex-error p-1 rounded text-red-500 bg-red-50">Error rendering formula</span>
  ) : (
    <span ref={ref} className={inline ? "inline-block align-middle" : "block text-center my-2"} />
  );
};

/** 块级代码组件（支持 Mermaid 渲染） */
const CodeBlock = memo<CodeBlockProps>(({ className, children }) => {
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
  console.log(`▶️ mermaid effect run: ${language}, |${code}|, ${containerRef.current}`);

  if (language === "mermaid" && containerRef.current) {
    console.log("▶️ mermaid effect run: initialize mermaid");
    mermaid.initialize({ startOnLoad: false, theme: themeDark ? "dark" : "default" });
    containerRef.current.innerHTML = "";
    // 只传 id 和 脚本，拿到 svg 字符串后自己插
    mermaid
      .render(mermaidId, code)
      .then(({ svg }) => {
        console.log(`▶️ mermaid render success: ${svg}`);
        if (containerRef.current) {
           console.log("Container exists. Setting innerHTML...");
           containerRef.current.innerHTML = svg;
           // Check immediately after setting
           console.log("Container innerHTML length AFTER set:", containerRef.current.innerHTML.length);
           // Check if the SVG element is queryable
           console.log("SVG element found in container:", !!containerRef.current.querySelector('svg'));
        } else {
           console.error("Container ref was NULL when trying to set innerHTML!");
        }
      })
      .catch(err => {
          console.error("Mermaid render error:", err); // Ensure errors are caught and logged
          if (containerRef.current) {
            containerRef.current.innerHTML = '<div class="text-red-500">Error rendering Mermaid diagram</div>'; // Show error in UI
          }
      });
  }
}, [language, code, themeDark, mermaidId]);


  if (language === "mermaid") {
    return (
      <div className="border border-gray-600 rounded overflow-hidden mb-2">
        <div className="flex items-center justify-between bg-gray-800 text-gray-300 px-2 py-1">
          <span className="text-xs uppercase">{language}</span>
          <button onClick={handleCopy} className="text-xs">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div ref={containerRef} className="p-2 bg-white dark:bg-gray-800" />
      </div>
    );
  }

  // 普通代码高亮
  return (
    <div className="border border-gray-600 rounded overflow-hidden mb-2">
      <div className="flex items-center justify-between bg-gray-800 text-gray-300 px-2 py-1">
        <span className="text-xs uppercase">{language}</span>
        <button onClick={handleCopy} className="text-xs">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={themeDark ? oneDark : oneLight}
        showLineNumbers
        wrapLines
        customStyle={{
          margin: '0px',
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
});
CodeBlock.displayName = "CodeBlock";

/** 行内代码 */
const InlineCode: React.FC<{ children: ReactNode }> = ({ children }) => (
  <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded text-sm">{children}</code>
);

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
    <Tooltip content={t(isActive && activeTooltip ? activeTooltip : tooltip)}>
      <button
        onClick={onClick}
        disabled={disabled}
        className={
          `p-1 rounded-full transition active:scale-95 ` +
          (disabled
            ? "opacity-40 cursor-not-allowed"
            : `hover:bg-gray-200 dark:hover:bg-gray-700 ${isActive ? "text-blue-500" : "text-gray-500"}`)
        }
        aria-label={t(isActive && activeTooltip ? activeTooltip : tooltip)}
      >
        {isActive && activeIcon ? activeIcon : icon}
      </button>
    </Tooltip>
  );
  return (
    <div className="flex items-center gap-4 mt-2">
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
export const MarkdownContent: React.FC<MarkdownContentProps> = memo(({ content }) => {
  const processed = React.useMemo(() => {
    let text = preprocessMarkdown(content);
    return parseMath(text);
  }, [content]);

  const mdOptions = {
    forceBlock: true,
    disableParsingRawHTML: false, // 允许渲染 SVG 等原始 HTML :contentReference[oaicite:13]{index=13}
    overrides: {
      p: { component: ({ children }: { children: ReactNode }) => <div>{children}</div> },
      MathBlock: { component: ({ children }: any) => <Math inline={false}>{children}</Math> },
      MathInline: { component: ({ children }: any) => <Math inline>{children}</Math> },
      pre: { component: ({ children }: { children: ReactNode }) => <>{children}</> },
      code: { component: CodeBlock },
      inlineCode: { component: InlineCode },
      img: {
        component: ({ alt, src }: any) => <Image src={src!} alt={alt} className="max-w-full rounded my-2" isBlurred />,
      },
    },
  };

  return (
    <div className="markdown-container prose dark:prose-invert max-w-full">
      <Markdown options={mdOptions}>{processed}</Markdown>
      <ContentActionButtons content={content} />
    </div>
  );
});
MarkdownContent.displayName = "MarkdownContent";
