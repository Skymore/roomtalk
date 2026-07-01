import { describe, expect, it } from 'vitest';
import { fileContentRevision, projectFileCacheKey } from './codeAgentFileContentRevision';

describe('fileContentRevision', () => {
  it('changes for same-length edits', () => {
    expect(fileContentRevision('nodeVersion')).not.toBe(fileContentRevision('nodeVeasdrs'));
  });

  it('keeps identical contents stable', () => {
    expect(projectFileCacheKey('/repo', 'file.json', 'contents')).toBe(
      projectFileCacheKey('/repo', 'file.json', 'contents'),
    );
  });
});
