import { describe, expect, it } from 'vitest';
import {
  resolveCodeAgentMarkdownFileLinkMeta,
  resolveCodeAgentMarkdownFileLinkTarget,
  rewriteCodeAgentMarkdownFileUriHref,
} from './codeAgentMarkdownLinks';

describe('rewriteCodeAgentMarkdownFileUriHref', () => {
  it('rewrites file uri hrefs into direct path hrefs like T3', () => {
    expect(rewriteCodeAgentMarkdownFileUriHref('file:///workspace/src/main.ts#L42')).toBe(
      '/workspace/src/main.ts#L42',
    );
  });

  it('preserves encoded octets so file paths are decoded only once later', () => {
    expect(rewriteCodeAgentMarkdownFileUriHref('file:///workspace/file%2520name.md')).toBe(
      '/workspace/file%2520name.md',
    );
  });

  it('normalizes file uri hrefs for windows drive paths', () => {
    expect(
      rewriteCodeAgentMarkdownFileUriHref(
        'file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69',
      ),
    ).toBe('D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69');
  });
});

describe('resolveCodeAgentMarkdownFileLinkTarget', () => {
  it('resolves absolute sandbox file paths', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('/workspace/AGENTS.md')).toBe('/workspace/AGENTS.md');
  });

  it('resolves relative file paths against the sandbox workspace root', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('src/processRunner.ts:71', '/workspace')).toBe(
      '/workspace/src/processRunner.ts:71',
    );
  });

  it('does not treat filename line references as external schemes', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('script.ts:10', '/workspace')).toBe(
      '/workspace/script.ts:10',
    );
  });

  it('resolves bare file names against the workspace root', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('AGENTS.md', '/workspace')).toBe('/workspace/AGENTS.md');
  });

  it('maps #L line anchors to editor line suffixes', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('/workspace/src/main.ts#L42C7')).toBe(
      '/workspace/src/main.ts:42:7',
    );
  });

  it('ignores external urls', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('https://example.com/docs', '/workspace')).toBeNull();
  });

  it('does not double-decode file URLs', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('file:///workspace/file%2520name.md')).toBe(
      '/workspace/file%20name.md',
    );
  });

  it('formats display paths relative to the workspace root', () => {
    expect(
      resolveCodeAgentMarkdownFileLinkMeta(
        'file:///workspace/apps/web/src/session-logic.ts#L501',
        '/workspace',
      ),
    ).toMatchObject({
      displayPath: 'workspace/apps/web/src/session-logic.ts:501',
      workspaceRelativePath: 'apps/web/src/session-logic.ts',
      basename: 'session-logic.ts',
      line: 501,
    });
  });

  it('does not create a preview path for files outside the workspace', () => {
    expect(resolveCodeAgentMarkdownFileLinkMeta('/tmp/report.ts', '/workspace')).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it('normalizes slash-prefixed windows drive paths before resolving', () => {
    expect(
      resolveCodeAgentMarkdownFileLinkTarget(
        '/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69',
      ),
    ).toBe('D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69');
  });

  it('resolves angle-bracketed windows drive paths', () => {
    expect(
      resolveCodeAgentMarkdownFileLinkTarget(
        '</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>',
      ),
    ).toBe('D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1');
  });

  it('does not treat app routes as file links', () => {
    expect(resolveCodeAgentMarkdownFileLinkTarget('/chat/settings', '/workspace')).toBeNull();
  });
});
