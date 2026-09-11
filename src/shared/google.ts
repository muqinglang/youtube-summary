/**
 * The OAuth client this extension signs in with. It must match SIDENOTE_GOOGLE_CLIENT_ID on the
 * server, which checks that every token it accepts was issued for this exact client — a token
 * minted for some other application is refused there.
 *
 * Creating it is a step only the operator can do: Google Cloud Console → APIs & Services →
 * Credentials → OAuth client ID → Web application, with
 * `https://<extension-id>.chromiumapp.org/` as an authorised redirect URI. The extension id has
 * to be stable first, which for an unpacked build means pinning `key` in the manifest.
 */
export const GOOGLE_CLIENT_ID =
  '349741359370-7rgnpaarq2ukd8ej6e6ssh3tun4tp1a1.apps.googleusercontent.com';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export function isConfiguredClientId(value: string = GOOGLE_CLIENT_ID): boolean {
  return !value.includes('replace-me') && value.endsWith('.apps.googleusercontent.com');
}

/**
 * Builds the sign-in URL. `nonce` ties the token that comes back to this one request, and the
 * server refuses a token carrying any other value.
 */
export function googleAuthUrl(
  redirectUri: string,
  nonce: string,
  clientId = GOOGLE_CLIENT_ID,
): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    // No profile, no Drive, nothing else: an address is all this service needs to know you by.
    scope: 'openid email',
    nonce,
    // Always offer the account chooser, since a browser profile may hold several.
    prompt: 'select_account',
  }).toString();
  return url.href;
}

/** Google returns the token in the fragment, which never reaches a server or a log. */
export function idTokenFromRedirect(redirect: string): string {
  let fragment: string;
  try {
    fragment = new URL(redirect).hash.replace(/^#/, '');
  } catch {
    throw new Error('Google 登录返回了无法解析的地址。');
  }
  const params = new URLSearchParams(fragment);
  const error = params.get('error');
  if (error) throw new Error(`Google 拒绝了这次登录：${error}`);
  const token = params.get('id_token');
  if (!token) throw new Error('Google 没有返回登录凭证，请重试。');
  return token;
}
