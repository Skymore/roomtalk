export { isMarkdownPreviewFile } from './codeAgentFilePath';

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== '[' ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? '') ||
    markdown[markerOffset + 2] !== ']'
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? 'x' : ' '}${markdown.slice(markerOffset + 2)}`;
}

export function markdownTaskMarkerOffsets(markdown: string): number[] {
  const offsets: number[] = [];
  let lineStart = 0;

  for (const line of markdown.split('\n')) {
    const match = /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.exec(line);
    if (match) {
      const markerIndex = line.indexOf('[', match[0].indexOf('['));
      if (markerIndex >= 0) {
        offsets.push(lineStart + markerIndex);
      }
    }
    lineStart += line.length + 1;
  }

  return offsets;
}
