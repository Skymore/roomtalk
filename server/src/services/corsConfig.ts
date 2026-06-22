export const resolveCorsOrigin = (env: NodeJS.ProcessEnv = process.env): string | boolean => {
  const clientUrl = env.CLIENT_URL?.trim();
  if (clientUrl) {
    return clientUrl;
  }

  return (env.NODE_ENV || 'development') === 'production' ? false : '*';
};
