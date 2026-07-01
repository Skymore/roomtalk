import type { CodeAgentWorkspaceRef } from './cocoWorkspace';

export interface CodeAgentBaseRefChoice {
  readonly id: string;
  readonly label: string;
  readonly local: CodeAgentWorkspaceRef | null;
  readonly remote: CodeAgentWorkspaceRef | null;
}

function remoteBranchName(ref: CodeAgentWorkspaceRef): string {
  if (ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)) {
    return ref.name.slice(ref.remoteName.length + 1);
  }
  return ref.name;
}

export function buildCodeAgentBaseRefChoices(
  localRefs: ReadonlyArray<CodeAgentWorkspaceRef>,
  remoteRefs: ReadonlyArray<CodeAgentWorkspaceRef>,
): ReadonlyArray<CodeAgentBaseRefChoice> {
  const unusedRemoteRefs = new Set(remoteRefs);
  const pairedChoices = localRefs.map((local) => {
    const matches = remoteRefs.filter(
      (remote) => unusedRemoteRefs.has(remote) && remoteBranchName(remote) === local.name,
    );
    const remote =
      matches.find((candidate) => candidate.remoteName === 'origin') ?? matches[0] ?? null;
    if (remote) unusedRemoteRefs.delete(remote);
    return {
      id: `local:${local.name}`,
      label: local.name,
      local,
      remote,
    };
  });

  const remoteOnlyChoices = remoteRefs
    .filter((remote) => unusedRemoteRefs.has(remote))
    .map((remote) => ({
      id: `remote:${remote.name}`,
      label: remote.name,
      local: null,
      remote,
    }));

  return [...pairedChoices, ...remoteOnlyChoices];
}

export function filterCodeAgentBaseRefChoices(
  choices: ReadonlyArray<CodeAgentBaseRefChoice>,
  query: string,
): ReadonlyArray<CodeAgentBaseRefChoice> {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) return choices;
  return choices.filter(
    (choice) =>
      choice.label.toLocaleLowerCase().includes(normalizedQuery) ||
      choice.local?.name.toLocaleLowerCase().includes(normalizedQuery) === true ||
      choice.remote?.name.toLocaleLowerCase().includes(normalizedQuery) === true,
  );
}
