export type CorsOrigin = string | string[] | boolean;

const parseOriginList = (value?: string): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
};

export const resolveCorsOrigin = (env: NodeJS.ProcessEnv = process.env): CorsOrigin => {
  const configuredOrigins = [
    ...parseOriginList(env.CLIENT_URLS),
    ...parseOriginList(env.CLIENT_URL),
  ];

  const uniqueOrigins = Array.from(new Set(configuredOrigins));
  if (uniqueOrigins.length === 1) {
    return uniqueOrigins[0];
  }
  if (uniqueOrigins.length > 1) {
    return uniqueOrigins;
  }

  return (env.NODE_ENV || 'development') === 'production' ? false : '*';
};
