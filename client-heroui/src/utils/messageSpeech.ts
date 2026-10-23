import { Children, isValidElement, type ReactNode } from 'react';
import { compiler } from 'markdown-to-jsx';

// Read prose and link labels, without code blocks or Markdown syntax.
export function getMessageSpeechText(markdown: string): string {
  const read = (node: ReactNode): string => Children.toArray(node).map(child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return String(child);
    if (['pre', 'img', 'script', 'style'].includes(String(child.type))) return '';
    const text = read(child.props.children);
    return ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'tr'].includes(String(child.type))
      ? `${text}\n` : text;
  }).join('');
  return read(compiler(markdown)).replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

export function getMessageSpeechParts(text: string): { text: string; lang: string }[] {
  // Short sentence-sized utterances also keep long replies within engine limits.
  return (text.match(/[^.!?。！？\n]{1,180}[.!?。！？]?/gu) || [])
    .map(part => ({ text: part.trim(), lang: /\p{Script=Han}/u.test(part) ? 'zh-CN' : 'en-US' }))
    .filter(part => part.text.length > 0);
}
