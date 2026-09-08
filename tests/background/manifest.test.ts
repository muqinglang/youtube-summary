import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../../src/shared/providers';
import { getOriginPattern } from '../../src/shared/endpoint';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8')) as {
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
};

describe('extension permissions', () => {
  it('can request every built-in provider endpoint', () => {
    // A provider whose origin is missing here fails at runtime with an opaque authorization
    // error, so the manifest and the provider catalogue must not drift apart.
    for (const provider of PROVIDERS) {
      expect(manifest.optional_host_permissions).toContain(getOriginPattern(provider.baseUrl));
    }
  });

  it('asks for no broader host access than those endpoints and the local test server', () => {
    // "https://*/*" reads as "every site you visit" during store review, and nothing reachable
    // through the settings UI needs it: the provider list is fixed.
    expect(manifest.optional_host_permissions).not.toContain('https://*/*');
    const providerOrigins = PROVIDERS.map((provider) => getOriginPattern(provider.baseUrl));
    const allowed = new Set([...providerOrigins, 'http://localhost/*', 'http://127.0.0.1/*']);
    for (const origin of manifest.optional_host_permissions) expect(allowed).toContain(origin);
  });

  it('keeps the always-on host access limited to YouTube and the translation endpoint', () => {
    expect(manifest.host_permissions).toEqual([
      'https://www.youtube.com/*',
      'https://m.youtube.com/*',
      'https://translate.googleapis.com/*',
    ]);
    expect(manifest.permissions).toEqual([
      'storage',
      'activeTab',
      'declarativeNetRequestWithHostAccess',
    ]);
  });
});
