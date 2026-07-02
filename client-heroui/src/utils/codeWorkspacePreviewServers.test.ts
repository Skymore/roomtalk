import { describe, expect, it, vi } from 'vitest';
import {
  isLoopbackPreviewHost,
  listCodeWorkspacePreviewServers,
  mergeCodeWorkspacePreviewServers,
  previewPortTargetFromLocalUrl,
  validateCodeWorkspacePreviewServer,
} from './codeWorkspacePreviewServers';

const requestCodeWorkspacePreviewServersMock = vi.hoisted(() => vi.fn());

vi.mock('./socket', () => ({
  requestCodeWorkspacePreviewServers: requestCodeWorkspacePreviewServersMock,
}));

describe('codeWorkspacePreviewServers', () => {
  it('validates server payloads from the socket', () => {
    expect(validateCodeWorkspacePreviewServer({
      host: ' localhost ',
      port: 5173,
      url: 'http://localhost:5173',
      processName: ' vite ',
      pid: 1234,
    })).toEqual({
      host: 'localhost',
      port: 5173,
      url: 'http://localhost:5173/',
      processName: 'vite',
      pid: 1234,
    });
    expect(() => validateCodeWorkspacePreviewServer({ port: 70000 })).toThrow(/invalid/i);
  });

  it('loads and validates preview servers through the socket wrapper', async () => {
    requestCodeWorkspacePreviewServersMock.mockResolvedValueOnce([
      { host: 'localhost', port: 3000, url: 'http://localhost:3000/' },
    ]);

    await expect(listCodeWorkspacePreviewServers('room-1')).resolves.toEqual([
      {
        host: 'localhost',
        port: 3000,
        url: 'http://localhost:3000/',
        processName: null,
        pid: null,
      },
    ]);
    expect(requestCodeWorkspacePreviewServersMock).toHaveBeenCalledWith('room-1');
  });

  it('merges scanner and recent loopback servers without duplicating ports', () => {
    const result = mergeCodeWorkspacePreviewServers({
      scanner: [
        { host: 'localhost', port: 5173, url: 'http://localhost:5173/', processName: 'vite', pid: 123 },
        { host: 'localhost', port: 3000, url: 'http://localhost:3000/', processName: null, pid: null },
      ],
      configuredUrls: ['http://localhost:8080/'],
      recentlySeenUrls: ['http://localhost:5173/', 'https://example.com/', 'http://127.0.0.1:4321/app'],
    });

    expect(result.map(server => `${server.source}:${server.port}:${server.processName ?? ''}`)).toEqual([
      'configured:8080:',
      'scanner:3000:',
      'scanner:5173:vite',
      'recent:4321:',
    ]);
  });

  it('converts loopback URLs to environment-port navigation targets', () => {
    expect(previewPortTargetFromLocalUrl('http://localhost:5173/dashboard?tab=preview#details')).toEqual({
      kind: 'environment-port',
      port: 5173,
      protocol: 'http',
      path: '/dashboard?tab=preview#details',
    });
    expect(previewPortTargetFromLocalUrl('https://example.com')).toBeNull();
    expect(isLoopbackPreviewHost('127.0.0.1')).toBe(true);
    expect(isLoopbackPreviewHost('api.example.com')).toBe(false);
  });
});
