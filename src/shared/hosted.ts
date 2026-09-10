/**
 * Hosted mode may only talk to origins listed here, and each must also appear in the manifest's
 * optional_host_permissions. Keeping it to a fixed list is what lets the extension avoid asking
 * for "access to every site you visit", which is the permission reviewers push back on hardest.
 *
 * Deploying your own server means changing this list and the manifest together; the manifest test
 * fails if they drift apart. `npm run set-hosted-origin -- https://your-app.example` edits both,
 * which matters when the platform hands you a different app name than you asked for.
 */
export const HOSTED_ORIGINS = [
  'https://sidenote.fly.dev',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
] as const;

export const DEFAULT_HOSTED_URL = HOSTED_ORIGINS[0];

export function isAllowedHostedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
      return false;
    return HOSTED_ORIGINS.some((origin) => new URL(origin).origin === url.origin);
  } catch {
    return false;
  }
}
