import { describe, expect, it } from 'vitest';
import { codeAgentFaviconUrlForOrigin } from './codeAgentFavicon';

describe('codeAgentFaviconUrlForOrigin', () => {
  it('builds favicon URLs for http origins', () => {
    expect(codeAgentFaviconUrlForOrigin('https://example.com/path?query=1')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=32',
    );
    expect(codeAgentFaviconUrlForOrigin('http://localhost:3011', 16)).toBe(
      'https://www.google.com/s2/favicons?domain=localhost%3A3011&sz=16',
    );
  });

  it('rejects unsupported or malformed URLs', () => {
    expect(codeAgentFaviconUrlForOrigin(null)).toBeNull();
    expect(codeAgentFaviconUrlForOrigin('')).toBeNull();
    expect(codeAgentFaviconUrlForOrigin('workspace/file.html')).toBeNull();
    expect(codeAgentFaviconUrlForOrigin('ftp://example.com/file')).toBeNull();
  });
});
