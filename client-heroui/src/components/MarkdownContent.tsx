import React, { useState, ReactNode, useEffect, useRef, memo } from "react";
import Markdown from "markdown-to-jsx";
import { Icon } from "@iconify/react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
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

/**
 * 把 $$...$$ => <MathBlock>...</MathBlock>
 *    $...$   => <MathInline>...</MathInline>
 */
const parseMath = (content: string) => {
  let result = content;

  // 块级公式
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => {
    return `<MathBlock>${formula.trim()}</MathBlock>`;
  });

  // 行内公式
  // 用 (^|[^\\])\$((?:[^$\\]|\\.)+?)\$ 以排除 \$ 转义
  result = result.replace(/(^|[^\\])\$((?:[^$\\]|\\.)+?)\$/g, (_match, prefix, formula) => {
    return `${prefix}<MathInline>${formula}</MathInline>`;
  });

  return result;
};

/**
 * 修复Markdown引用问题：确保只有以 > 开头的行被视为引用，
 * 并在每个引用行后添加空行，防止后续行被错误识别为引用的一部分
 */
const fixQuoteBlocks = (content: string): string => {
  const lines = content.split("\n");
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 检测是否以 > 开头（考虑前导空格）
    if (/^\s*>\s*/.test(line)) {
      // 添加当前引用行
      result.push(line);

      // 检查下一行是否也是引用
      if (i + 1 < lines.length && !/^\s*>\s*/.test(lines[i + 1]) && lines[i + 1].trim() !== "") {
        // 下一行不是引用且不是空行，添加空行以结束引用块
        result.push("");
      }
    } else {
      // 非引用行直接添加
      result.push(line);
    }
    i++;
  }

  return result.join("\n");
};

/** KaTeX 数学组件 */
const Math: React.FC<MathProps> = ({ children, inline = false }) => {
  const mathRef = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mathRef.current) {
      try {
        const formula = (typeof children === "string" ? children : "").trim();
        katex.render(formula, mathRef.current, {
          throwOnError: false,
          displayMode: !inline,
          strict: false,
          trust: true,
          macros: {
            "\\RR": "\\mathbb{R}",
            "\\NN": "\\mathbb{N}",
            "\\ZZ": "\\mathbb{Z}",
            "\\CC": "\\mathbb{C}",
          },
          errorColor: "#EF4444", // Changed to new danger color
        });
        setError(null);
      } catch (err) {
        console.error("Error rendering LaTeX:", err);
        setError(String(err));
        if (mathRef.current) {
          mathRef.current.textContent = typeof children === "string" ? children : "";
        }
      }
    }
  }, [children, inline]);

  if (error) {
    return <span className="katex-error p-1 rounded text-red-500 bg-red-50">Error rendering formula: {children}</span>;
  }

  return (
    <span
      ref={mathRef}
      className={inline ? "inline-block align-middle katex-container" : "block text-center my-1 katex-container"}
    />
  );
};

/** 块级代码组件（带复制） - 使用memo优化渲染 */
const CodeBlock = memo<CodeBlockProps>(({ className, children }) => {
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  // 提取语言
  let language = "text";
  const match = /(lang(?:uage)?)-(\w+)/.exec(className || "");
  if (match) {
    language = match[2];
  }

  const code = String(children).replace(/\n$/, "");

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    });
  };

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  return (
    // 添加一个宽度为100%的容器，防止溢出
    <div className="w-full my-2">
      <div className="border border-gray-600 text-sm rounded-md">
        {/* 代码块顶部栏 */}
        <div className="flex items-center justify-between px-2 py-1 bg-gray-800 text-gray-300 border-b border-gray-600">
          <div className="flex items-center gap-2">
            {language === "python" ? (
              <Icon icon="tabler:brand-python" className="w-3.5 h-3.5" />
            ) : language === "javascript" || language === "js" ? (
              <Icon icon="tabler:brand-javascript" className="w-3.5 h-3.5" />
            ) : language === "typescript" || language === "ts" ? (
              <Icon icon="tabler:brand-typescript" className="w-3.5 h-3.5" />
            ) : language === "html" ? (
              <Icon icon="tabler:brand-html5" className="w-3.5 h-3.5" />
            ) : language === "css" ? (
              <Icon icon="tabler:brand-css3" className="w-3.5 h-3.5" />
            ) : (
              <Icon icon="tabler:code" className="w-3.5 h-3.5" />
            )}
            <span className="text-xs font-medium uppercase">{language}</span>
          </div>
          <button
            className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 transition-colors min-w-[52px]"
            onClick={handleCopyCode}
            type="button"
          >
            {copied ? (
              <>
                <Icon icon="lucide:check" className="w-3 h-3" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Icon icon="lucide:copy" className="w-3 h-3" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        {/* 添加内部滚动容器，允许代码内容可滚动 */}
        <div className="overflow-x-auto">
          <SyntaxHighlighter
            language={language}
            style={oneDark}
            customStyle={{
              margin: 0,
              padding: "0.5rem 0.75rem",
              fontSize: "0.8125rem",
              lineHeight: "1.5",
              background: "#282c34",
              borderRadius: 0,
            }}
            showLineNumbers
            wrapLines
            codeTagProps={{
              className: `language-${language}`,
              style: {
                fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
                fontSize: "0.8125rem",
              },
            }}
          >
            {code}
          </SyntaxHighlighter>
        </div>
      </div>
    </div>
  );
});

CodeBlock.displayName = "CodeBlock";

/** 行内代码组件 */
const InlineCode: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <code className="text-gray-800 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm">
      {children}
    </code>
  );
};

/**
 * 移除只包含分隔符（如 --- 或仅连字符）的行
 */
const removeSeparators = (content: string): string => {
  const lines = content.split("\n");
  const filtered = lines.filter((line) => !/^\s*[-=]+\s*$/.test(line.trim()));
  return filtered.join("\n");
};

/**
 * 简化的预处理Markdown内容：
 * 1. 移除分隔线
 * 2. 确保引用块格式正确
 * 3. 确保代码块格式正确
 */
const preprocessMarkdown = (content: string): string => {
  // 移除分隔符行
  let processed = removeSeparators(content);
  // 修复引用块问题
  processed = fixQuoteBlocks(processed);
  return processed;
};

// 空心点赞SVG图标
const ThumbsUpOutlineSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);

// 实心点赞SVG图标 - 完全使用fill来填充
const ThumbsUpFilledSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="0.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);

// 自定义点踩SVG图标
const ThumbsDownOutlineSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
  </svg>
);

// 实心点踩SVG图标 - 完全使用fill来填充
const ThumbsDownFilledSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="0.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22h0a3.13 3.13 0 0 1-3-3.88Z" />
  </svg>
);

// 自定义复制SVG图标
const CopySvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

// 自定义对号SVG图标
const CheckSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

// 刷新SVG图标
const RefreshSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);

// 编辑SVG图标
const EditSvg = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-4 h-4"
  >
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

// 直接在MarkdownContent中使用的操作按钮 - 能够访问内容
const ContentActionButtons = memo(({ content }: { content: string }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  // 底部复制原文
  const handleCopyRaw = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      // 清除之前的timeout
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      // 设置新的timeout
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    });
  };

  // 处理点赞
  const handleLike = () => {
    setLiked(!liked);
    if (!liked) {
      setDisliked(false);
    }
  };

  // 处理点踩
  const handleDislike = () => {
    setDisliked(!disliked);
    if (!disliked) {
      setLiked(false);
    }
  };

  // 清理timeout
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  // 渲染单个按钮
  const renderButton = ({
    onClick,
    icon,
    activeIcon,
    isActive,
    disabled = false,
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
  }) => {
    const actualIcon = isActive && activeIcon ? activeIcon : icon;
    const actualTooltip = isActive && activeTooltip ? activeTooltip : tooltip;

    return (
      <Tooltip content={t(actualTooltip)}>
        <button
          onClick={onClick}
          className={`flex items-center justify-center p-1 rounded-full transition-all active:scale-95 active:bg-gray-100 dark:active:bg-gray-800 ${
            disabled
              ? "opacity-40 cursor-not-allowed dark:text-gray-500"
              : `hover:text-gray-700 dark:hover:text-gray-300 ${isActive ? "text-blue-500 dark:text-blue-400" : ""}`
          }`}
          disabled={disabled}
          aria-label={t(actualTooltip)}
        >
          {actualIcon}
        </button>
      </Tooltip>
    );
  };

  return (
    <div className="mt-2 flex items-center space-x-4 text-gray-500 dark:text-gray-400">
      {renderButton({
        onClick: handleCopyRaw,
        icon: <CopySvg />,
        activeIcon: <CheckSvg />,
        isActive: copied,
        tooltip: "copy",
        activeTooltip: "copied",
      })}

      {renderButton({
        onClick: handleLike,
        icon: <ThumbsUpOutlineSvg />,
        activeIcon: <ThumbsUpFilledSvg />,
        isActive: liked,
        tooltip: "like",
        activeTooltip: "cancelLike",
      })}

      {renderButton({
        onClick: handleDislike,
        icon: <ThumbsDownOutlineSvg />,
        activeIcon: <ThumbsDownFilledSvg />,
        isActive: disliked,
        tooltip: "dislike",
        activeTooltip: "cancelDislike",
      })}

      {renderButton({
        onClick: () => {},
        icon: <RefreshSvg />,
        disabled: true,
        tooltip: "refresh",
      })}

      {renderButton({
        onClick: () => {},
        icon: <EditSvg />,
        disabled: true,
        tooltip: "edit",
      })}
    </div>
  );
});

ContentActionButtons.displayName = "ContentActionButtons";

/** 入口组件 - 使用memo避免不必要的重新渲染 */
export const MarkdownContent: React.FC<MarkdownContentProps> = memo(({ content }) => {
  // 使用useRef和useMemo来缓存处理后的内容，避免重复处理
  const contentRef = useRef(content);
  const processedRef = useRef<string | null>(null);

  // 只有当content发生变化时才重新处理
  if (content !== contentRef.current || processedRef.current === null) {
    contentRef.current = content;
    // 1. 预处理
    let processed = preprocessMarkdown(content);
    // 2. 数学公式解析
    processed = parseMath(processed);
    processedRef.current = processed;
  }

  // 注入全局样式
  useEffect(() => {
    const style = document.createElement("style");
    style.innerHTML = `
      /* 确保代码块容器不会导致页面水平滚动 */
      .markdown-container {
        max-width: 100%;
        overflow-x: hidden;
        overflow-y: visible;
        box-sizing: border-box;
      }
      
/* 让代码块自身不要超过父容器 */
.markdown-container pre {
  max-width: 100%;
  overflow-x: auto;
  overflow-y: visible;
  box-sizing: border-box;
}

      
      /* 确保表格也不会导致页面水平滚动 */
      .markdown-container table {
        display: block;
        width: 100%;
        overflow-x: auto;
        overflow-y: visible;
        -webkit-overflow-scrolling: touch;
      }
      
      /* 确保长文本（如链接）不会破坏布局 */
      .markdown-container p, 
      .markdown-container li, 
      .markdown-container a {
        overflow-wrap: break-word;
        word-wrap: break-word;
        word-break: break-word;
        hyphens: auto;
      }
      
      /* 确保预格式化的文本不超出容器 */
      .markdown-container code {
        overflow-wrap: break-word;
        white-space: pre-wrap;
      }
      
      /* 确保图片不超出容器宽度 */
      .markdown-container img {
        max-width: 100%;
        height: auto;
      }

      .markdown-container * {
        background: none !important;
      }
      .markdown-container pre, .markdown-container code.hljs {
        background: #282c34 !important;
      }
        /* 数学公式的容器同理 */
      .katex-container .katex-display {
        max-width: 100%;
        overflow-x: auto !important;
        overflow-y: hidden !important;
      }
      .katex-error {
        color: #EF4444;
        background: rgba(239,68,68,0.1) !important;
        padding: 2px 4px;
        border-radius: 2px;
      }
      .markdown-container :not(pre) > code {
        background: #F3F4F6 !important;
      }
      .dark .markdown-container :not(pre) > code {
        background: #374151 !important;
      }
      
      /* 表格样式 */
      .markdown-container table {
        width: 100%;
        border-collapse: collapse;
        margin: 1rem 0;
        font-size: 0.9rem;
      }
      .markdown-container th {
        background: #F3F4F6 !important;
        font-weight: 600;
        text-align: left;
        padding: 0.5rem 0.75rem;
        border: 1px solid #E5E7EB;
      }
      .dark .markdown-container th {
        background: #374151 !important;
        border-color: #4B5563;
      }
      .markdown-container td {
        padding: 0.5rem 0.75rem;
        border: 1px solid #E5E7EB;
      }
      .dark .markdown-container td {
        border-color: #4B5563;
      }
      .markdown-container tr:nth-child(even) {
        background: #F9FAFB !important;
      }
      .dark .markdown-container tr:nth-child(even) {
        background: #1F2937 !important;
      }
      
      /* 列表样式 */
      .markdown-container ul, .markdown-container ol {
        padding-left: 1.5rem;
        margin: 0.5rem 0;
      }
      .markdown-container ul {
        list-style-type: disc;
      }
      .markdown-container ul ul {
        list-style-type: circle;
      }
      .markdown-container ul ul ul {
        list-style-type: square;
      }
      .markdown-container ol {
        list-style-type: decimal;
      }
      .markdown-container ol ol {
        list-style-type: lower-alpha;
      }
      .markdown-container ol ol ol {
        list-style-type: lower-roman;
      }
      .markdown-container li {
        margin: 0.25rem 0;
      }
      
      /* 引用块样式 */
      .markdown-container blockquote {
        border-left: 4px solid #E5E7EB;
        padding: 0.5rem 1rem;
        margin: 1rem 0;
        color: #6B7280;
        font-style: italic;
      }
      .dark .markdown-container blockquote {
        border-left-color: #4B5563;
        color: #9CA3AF;
      }
      
      /* 标题样式 */
      .markdown-container h1, 
      .markdown-container h2, 
      .markdown-container h3, 
      .markdown-container h4, 
      .markdown-container h5, 
      .markdown-container h6 {
        margin-top: 1.5rem;
        margin-bottom: 0.75rem;
        font-weight: 600;
        line-height: 1.25;
      }
      .markdown-container h1 {
        font-size: 1.875rem;
        border-bottom: 1px solid #E5E7EB;
        padding-bottom: 0.25rem;
      }
      .markdown-container h2 {
        font-size: 1.5rem;
        border-bottom: 1px solid #E5E7EB;
        padding-bottom: 0.25rem;
      }
      .markdown-container h3 {
        font-size: 1.25rem;
      }
      .markdown-container h4 {
        font-size: 1.125rem;
      }
      .markdown-container h5 {
        font-size: 1rem;
      }
      .markdown-container h6 {
        font-size: 0.875rem;
        color: #6B7280;
      }
      .dark .markdown-container h1,
      .dark .markdown-container h2 {
        border-bottom-color: #4B5563;
      }
      
      /* 水平线样式 */
      .markdown-container hr {
        height: 1px;
        background-color: #E5E7EB !important;
        border: none;
        margin: 1.5rem 0;
      }
      .dark .markdown-container hr {
        background-color: #4B5563 !important;
      }
      
      /* 链接样式 */
      .markdown-container a {
        color: #2563EB;
        text-decoration: none;
      }
      .markdown-container a:hover {
        text-decoration: underline;
      }
      .dark .markdown-container a {
        color: #3B82F6;
      }
      
      /* 图片样式 - 补充 */
      .markdown-container img {
        border-radius: 0.25rem;
      }
      
      /* 段落间距 */
      .markdown-container p {
        margin: 0.75rem 0;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // markdown-to-jsx 的自定义渲染
  const mdOptions = {
    forceBlock: true,
    overrides: {
      // 自定义块级公式
      MathBlock: {
        component: ({ children }: { children: ReactNode }) => {
          let formula = "";
          if (typeof children === "string") {
            formula = children;
          } else if (Array.isArray(children)) {
            formula = children.map((c) => (typeof c === "string" ? c : "")).join("");
          }
          return <Math inline={false}>{formula}</Math>;
        },
      },
      // 自定义行内公式
      MathInline: {
        component: ({ children }: { children: ReactNode }) => {
          let formula = "";
          if (typeof children === "string") {
            formula = children;
          } else if (Array.isArray(children)) {
            formula = children.map((c) => (typeof c === "string" ? c : "")).join("");
          }
          return <Math inline>{formula}</Math>;
        },
      },
      // 处理代码块和行内代码
      code: {
        component: ({ className, children, ...props }: { className?: string; children: ReactNode }) => {
          const codeStr = typeof children === "string" ? children : "";
          // 如果没有语言标识，但内容是多行，则当做块级代码处理
          if (!className && codeStr.includes("\n")) {
            return (
              <CodeBlock className="" {...props}>
                {children}
              </CodeBlock>
            );
          }
          // 如果没有语言标识且为单行，则当做行内代码处理
          if (!className) {
            return <InlineCode>{children}</InlineCode>;
          }
          // 如果有语言标识则统一走 CodeBlock
          return (
            <CodeBlock className={className} {...props}>
              {children}
            </CodeBlock>
          );
        },
      },
      pre: {
        component: ({ children, ...props }: { children: ReactNode }) => {
          if (React.isValidElement(children) && children.type === CodeBlock) {
            return children;
          }
          return <pre {...props}>{children}</pre>;
        },
      },
      // 图片 -> 自定义 Image 组件
      img: {
        component: ({ alt, src }: { alt?: string; src?: string }) => (
          <Image
            src={src || ""}
            alt={alt || "Shared image"}
            className="max-h-[300px] max-w-full object-contain rounded my-2"
            isBlurred
          />
        ),
      },
      // 表格组件
      table: {
        component: (props: any) => (
          <div className="overflow-x-auto">
            <table {...props} className="min-w-full" />
          </div>
        ),
      },
      // 列表样式定制
      ul: {
        component: (props: any) => <ul {...props} className="list-disc pl-6 my-3" />,
      },
      ol: {
        component: (props: any) => <ol {...props} className="list-decimal pl-6 my-3" />,
      },
      // 引用块
      blockquote: {
        component: (props: any) => (
          <blockquote
            {...props}
            className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 py-1 my-4 italic text-gray-600 dark:text-gray-400"
          />
        ),
      },
      // 标题样式
      h1: {
        component: (props: any) => (
          <h1 {...props} className="text-2xl font-bold mt-6 mb-3 pb-1 border-b border-gray-200 dark:border-gray-700" />
        ),
      },
      h2: {
        component: (props: any) => (
          <h2 {...props} className="text-xl font-bold mt-5 mb-3 pb-1 border-b border-gray-200 dark:border-gray-700" />
        ),
      },
      h3: {
        component: (props: any) => <h3 {...props} className="text-lg font-bold mt-4 mb-2" />,
      },
    },
  };

  return (
    <div className="markdown-container text-gray-800 dark:text-gray-200 max-w-full">
      {/* 主体内容 */}
      <Markdown options={mdOptions}>{processedRef.current}</Markdown>

      {/* 完全封装的底部按钮栏 */}
      <ContentActionButtons content={content} />
    </div>
  );
});

MarkdownContent.displayName = "MarkdownContent";
