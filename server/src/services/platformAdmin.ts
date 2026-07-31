export const MAX_PLATFORM_ADMIN_EMAILS = 32;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export const resolvePlatformAdminEmails = (
  value = process.env.PLATFORM_ADMIN_EMAILS || '',
): string[] => {
  const emails = [...new Set(value.split(',').map(normalizeEmail).filter(Boolean))];
  if (emails.length > MAX_PLATFORM_ADMIN_EMAILS) {
    throw new Error(`PLATFORM_ADMIN_EMAILS supports at most ${MAX_PLATFORM_ADMIN_EMAILS} addresses`);
  }
  for (const email of emails) {
    if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error('PLATFORM_ADMIN_EMAILS must contain valid comma-separated email addresses');
    }
  }
  return emails;
};

export const accountMatchesPlatformAdminEmail = (
  account: { email?: string; emailVerified?: boolean },
  configuredEmails: ReadonlySet<string>,
) => account.emailVerified === true
  && typeof account.email === 'string'
  && configuredEmails.has(normalizeEmail(account.email));
