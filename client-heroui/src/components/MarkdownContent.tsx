// MarkdownContent.tsx
import React, { useState, ReactNode, useEffect, useRef } from 'react';
import Markdown from 'markdown-to-jsx';
import { Icon } from '@iconify/react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Image } from '@heroui/react';
import 'katex/dist/katex.min.css';
import katex from 'katex';
import { Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
// 如果要用 tailwindcss 的插件，在全局样式里 import：

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
 * （可选）在渲染前做些预处理，如保证```lang\n code```格式化
 */
const preprocessMarkdown = (content: string): string => {
  const codeBlockRegex = /(```[\w-]*)\n([\s\S]*?)```/g;
  let result = content;

  result = result.replace(codeBlockRegex, (match, fence, code) => {
    const lang = fence.slice(3).trim();
    if (lang) {
      return `\`\`\`${lang}\n${code}\`\`\``;
    }
    return match;
  });

  return result;
};

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

/** KaTeX 数学组件 */
const Math: React.FC<MathProps> = ({ children, inline = false }) => {
  const mathRef = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mathRef.current) {
      try {
        const formula = (typeof children === 'string' ? children : '').trim();
        katex.render(formula, mathRef.current, {
          throwOnError: false,
          displayMode: !inline,
          strict: false,
          trust: true,
          macros: {
            '\\RR': '\\mathbb{R}',
            '\\NN': '\\mathbb{N}',
            '\\ZZ': '\\mathbb{Z}',
            '\\CC': '\\mathbb{C}'
          },
          errorColor: '#EF4444' // Changed to new danger color
        });
        setError(null);
      } catch (err) {
        console.error('Error rendering LaTeX:', err);
        setError(String(err));
        if (mathRef.current) {
          mathRef.current.textContent = typeof children === 'string' ? children : '';
        }
      }
    }
  }, [children, inline]);

  if (error) {
    return (
      <span className="katex-error p-1 rounded text-red-500 bg-red-50">
        Error rendering formula: {children}
      </span>
    );
  }

  return (
    <span
      ref={mathRef}
      className={
        inline
          ? 'inline-block align-middle katex-container'
          : 'block text-center my-2 katex-container'
      }
    />
  );
};

/** 块级代码组件（带复制） */
const CodeBlock: React.FC<CodeBlockProps> = ({ className, children }) => {
  const [copied, setCopied] = useState(false);

  // 提取语言
  let language = 'text';
  const match = /(lang(?:uage)?)-(\w+)/.exec(className || '');
  if (match) {
    language = match[2];
  }

  const code = String(children).replace(/\n$/, '');

  const handleCopyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="border border-gray-600 my-2 text-sm rounded-md overflow-hidden">
      {/* 代码块顶部栏 - 改小一点 */}
      <div className="flex items-center justify-between px-2 py-1 bg-gray-800 text-gray-300 border-b border-gray-600">
        <div className="flex items-center gap-2">
          {language === 'python' ? (
            <Icon icon="tabler:brand-python" className="w-3.5 h-3.5" />
          ) : language === 'javascript' || language === 'js' ? (
            <Icon icon="tabler:brand-javascript" className="w-3.5 h-3.5" />
          ) : language === 'typescript' || language === 'ts' ? (
            <Icon icon="tabler:brand-typescript" className="w-3.5 h-3.5" />
          ) : language === 'html' ? (
            <Icon icon="tabler:brand-html5" className="w-3.5 h-3.5" />
          ) : language === 'css' ? (
            <Icon icon="tabler:brand-css3" className="w-3.5 h-3.5" />
          ) : (
            <Icon icon="tabler:code" className="w-3.5 h-3.5" />
          )}
          <span className="text-xs font-medium uppercase">{language}</span>
        </div>
        <button
          className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded hover:bg-gray-200 transition-colors"
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
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '0.5rem 0.75rem',
          fontSize: '0.8125rem',
          lineHeight: '1.5',
          background: '#282c34',
          borderRadius: 0
        }}
        showLineNumbers
        wrapLines
        codeTagProps={{
          className: `language-${language}`,
          style: {
            fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
            fontSize: '0.8125rem'
          }
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

/** 行内代码组件 */
const InlineCode: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <code className="text-gray-800 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-sm">
      {children}
    </code>
  );
};

/** 入口组件 */
const MarkdownContent: React.FC<MarkdownContentProps> = ({ content}) => {
  const { t } = useTranslation();
  // 1. 预处理
  let processed = preprocessMarkdown(content);
  // 2. 数学公式 parse
  processed = parseMath(processed);

  // 底部复制原文
  const handleCopyRaw = () => {
    navigator.clipboard.writeText(content);
  };

  // 注入全局样式（移除蓝色，改成灰色等）
  useEffect(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      .markdown-container * {
        background: none !important;
      }
      .markdown-container pre, .markdown-container code.hljs {
        background: #282c34 !important;
      }
      .katex-container .katex-display {
        overflow-x: hidden;
        overflow-y: hidden;
        padding: 0.5em 0;
        margin: 0.5em 0;
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
          let formula = '';
          if (typeof children === 'string') {
            formula = children;
          } else if (Array.isArray(children)) {
            formula = children.map((c) => (typeof c === 'string' ? c : '')).join('');
          }
          return <Math inline={false}>{formula}</Math>;
        }
      },
      // 自定义行内公式
      MathInline: {
        component: ({ children }: { children: ReactNode }) => {
          let formula = '';
          if (typeof children === 'string') {
            formula = children;
          } else if (Array.isArray(children)) {
            formula = children.map((c) => (typeof c === 'string' ? c : '')).join('');
          }
          return <Math inline>{formula}</Math>;
        }
      },
      // 检测是否是 "行内代码" 还是 "块级代码"
      code: {
        component: ({ className, children, ...props }: { className?: string; children: ReactNode }) => {
          if (!className) {
            // 没语言标识 => 行内代码
            return <InlineCode>{children}</InlineCode>;
          }
          return <CodeBlock className={className} {...props}>{children}</CodeBlock>;
        }
      },
      pre: {
        component: ({ children, ...props }: { children: ReactNode }) => {
          if (React.isValidElement(children) && children.type === CodeBlock) {
            return children;
          }
          return <pre {...props}>{children}</pre>;
        }
      },
      // 示例: 图片 -> 自定义 Image 组件
      img: {
        component: ({ alt, src }: { alt?: string; src?: string }) => (
          <Image
            src={src || ''}
            alt={alt || 'Shared image'}
            className="max-h-[300px] max-w-full object-contain rounded my-2"
            isBlurred
          />
        )
      }
    }
  };

  return (
    <div className="markdown-container text-gray-800 dark:text-gray-200">
      {/* 主体内容 */}
      <Markdown options={mdOptions}>{processed}</Markdown>

      {/* 底部按钮栏（示例：复制原文） */}
      <div className="mt-2 flex items-center space-x-4 text-gray-500 dark:text-gray-400">
        <Tooltip content={t('copy')}>
        <button
          onClick={handleCopyRaw}
          className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <Icon icon="lucide:copy" className="w-4 h-4" />
        </button>
        </Tooltip>
        <Tooltip content={t('like')}>
        <button
          onClick={() => {}}
          className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <Icon icon="lucide:thumbs-up" className="w-4 h-4" />
        </button>
        </Tooltip>
        <Tooltip content={t('dislike')}>
        <button
          onClick={() => {}}
          className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
        >
          <Icon icon="lucide:thumbs-down" className="w-4 h-4" />
        </button>
        </Tooltip>
        <Tooltip content={t('refresh')}>
        <button
          onClick={() => {}}
          className="flex items-center gap-1 opacity-40 cursor-not-allowed dark:text-gray-500"
          disabled={true}
        >
          <Icon icon="lucide:refresh-cw" className="w-4 h-4" />
        </button>
        </Tooltip>
        <Tooltip content={t('edit')}>
        <button
          onClick={() => {}}
          className="flex items-center gap-1 opacity-40 cursor-not-allowed dark:text-gray-500"
          disabled={true}
        >
          <Icon icon="lucide:edit" className="w-4 h-4" />
        </button>
        </Tooltip>
        {/* 其它按钮都可以加到这里，如你之前的"点赞"、"踩"等临时禁用 */}
      </div>
    </div>
  );
};

export default MarkdownContent;