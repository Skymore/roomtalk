export interface GitHubConnectionConfig {
  enabled: boolean;
  authEncryptionKey?: string;
}

export function resolveGitHubConnectionConfig(env: NodeJS.ProcessEnv = process.env): GitHubConnectionConfig {
  const enabled = env.GITHUB_CONNECTIONS_ENABLED === 'true';
  const authEncryptionKey = env.GITHUB_AUTH_ENCRYPTION_KEY?.trim()
    || env.CODEX_AUTH_ENCRYPTION_KEY?.trim()
    || undefined;
  if (enabled && !authEncryptionKey) {
    throw new Error('GITHUB_AUTH_ENCRYPTION_KEY or CODEX_AUTH_ENCRYPTION_KEY is required when GITHUB_CONNECTIONS_ENABLED=true');
  }
  return { enabled, authEncryptionKey };
}
