import { describe, expect, it } from 'vitest';
import { buildCodeAgentBaseRefChoices, filterCodeAgentBaseRefChoices } from './codeWorkspaceRefs';

describe('code workspace base ref choices', () => {
  it('pairs local refs with matching remote refs and prefers origin', () => {
    const choices = buildCodeAgentBaseRefChoices(
      [
        { name: 'main', kind: 'local' },
        { name: 'release', kind: 'local' },
      ],
      [
        { name: 'upstream/main', kind: 'remote', remoteName: 'upstream' },
        { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
        { name: 'origin/feature/search', kind: 'remote', remoteName: 'origin' },
      ],
    );

    expect(choices).toEqual([
      {
        id: 'local:main',
        label: 'main',
        local: { name: 'main', kind: 'local' },
        remote: { name: 'origin/main', kind: 'remote', remoteName: 'origin' },
      },
      {
        id: 'local:release',
        label: 'release',
        local: { name: 'release', kind: 'local' },
        remote: null,
      },
      {
        id: 'remote:upstream/main',
        label: 'upstream/main',
        local: null,
        remote: { name: 'upstream/main', kind: 'remote', remoteName: 'upstream' },
      },
      {
        id: 'remote:origin/feature/search',
        label: 'origin/feature/search',
        local: null,
        remote: { name: 'origin/feature/search', kind: 'remote', remoteName: 'origin' },
      },
    ]);
  });

  it('filters choices by label, local ref, or remote ref', () => {
    const choices = buildCodeAgentBaseRefChoices(
      [{ name: 'main', kind: 'local' }],
      [{ name: 'origin/main', kind: 'remote', remoteName: 'origin' }],
    );

    expect(filterCodeAgentBaseRefChoices(choices, 'origin')).toHaveLength(1);
    expect(filterCodeAgentBaseRefChoices(choices, 'main')).toHaveLength(1);
    expect(filterCodeAgentBaseRefChoices(choices, 'missing')).toHaveLength(0);
  });
});
