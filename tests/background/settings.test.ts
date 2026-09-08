import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../src/shared/types';
import { PROVIDERS } from '../../src/shared/providers';
import {
  clearKey,
  DEFAULT_SETTINGS,
  getOriginPattern,
  getPrivateSettings,
  getPublicSettings,
  restrictStorageAccess,
  saveSettings,
  validateBaseUrl,
} from '../../src/background/settings';

function storageArea() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: vi.fn(async (keys: string | string[]) =>
      Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]])),
    ),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
    setAccessLevel: vi.fn(async () => undefined),
  };
}

describe('private settings', () => {
  let local: ReturnType<typeof storageArea>;
  let session: ReturnType<typeof storageArea>;
  beforeEach(() => {
    local = storageArea();
    session = storageArea();
    vi.stubGlobal('chrome', { storage: { local, session } });
  });

  it('starts with empty credentials and a selectable default model', async () => {
    expect(await getPublicSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      apiKey: undefined,
      hasApiKey: false,
    });
    expect(await getPrivateSettings()).toEqual(DEFAULT_SETTINGS);
    expect((await getPublicSettings()).translationEngine).toBe('auto');
  });

  it('defaults legacy settings to automatic translation without changing saved preferences or keys', async () => {
    local.data['sidenote:settings'] = {
      baseUrl: 'https://example.com/v1',
      model: 'saved-model',
      rememberKey: true,
      targetLanguage: '日本語',
      prompt: 'Saved prompt',
      temperature: 0.7,
    };
    local.data['sidenote:apiKey'] = { value: 'saved-key', origin: 'https://example.com' };

    expect(await getPublicSettings()).toMatchObject({
      ...(local.data['sidenote:settings'] as Record<string, unknown>),
      translationEngine: 'auto',
      provider: 'custom',
      hasApiKey: true,
    });
    await saveSettings({ prompt: 'Updated prompt' });
    expect(local.data['sidenote:settings']).toMatchObject({ translationEngine: 'auto' });
    expect((await getPrivateSettings()).apiKey).toBe('saved-key');
  });

  it.each(['auto', 'google', 'ai'] as const)(
    'persists and publicly exposes the %s translation preference',
    async (translationEngine) => {
      await saveSettings({ apiKey: 'private-test-key', model: 'gpt-4.1' });
      const result = await saveSettings({ translationEngine });

      expect(result).toMatchObject({ translationEngine, hasApiKey: true, model: 'gpt-4.1' });
      expect(result).not.toHaveProperty('apiKey');
      expect(local.data['sidenote:settings']).toMatchObject({ translationEngine });
      expect(await getPrivateSettings()).toMatchObject({
        translationEngine,
        apiKey: 'private-test-key',
      });
      await saveSettings({ targetLanguage: 'English' });
      expect((await getPublicSettings()).translationEngine).toBe(translationEngine);
    },
  );

  it.each(['unsupported', '', 'AI', null, true, {}])(
    'rejects invalid translation engine %j without partially saving',
    async (translationEngine) => {
      await saveSettings({ translationEngine: 'google', prompt: 'Keep this prompt' });
      const before = structuredClone(local.data);

      await expect(
        saveSettings({
          translationEngine: translationEngine as Settings['translationEngine'],
          prompt: 'Never saved',
        }),
      ).rejects.toThrow('翻译方式');
      expect(local.data).toEqual(before);
      expect(await getPublicSettings()).toMatchObject({
        translationEngine: 'google',
        prompt: 'Keep this prompt',
      });
    },
  );

  it('stores keys in session by default and never returns one to the panel', async () => {
    const result = await saveSettings({ apiKey: 'private-test-key', model: 'gpt-4.1-mini' });
    expect(result).not.toHaveProperty('apiKey');
    expect(result.hasApiKey).toBe(true);
    expect(JSON.stringify(local.data)).not.toContain('private-test-key');
    expect(session.data['sidenote:apiKey']).toEqual({
      value: 'private-test-key',
      origin: 'https://api.openai.com',
    });
    expect((await getPrivateSettings()).apiKey).toBe('private-test-key');
    await saveSettings({ apiKey: '', prompt: 'Changed' });
    expect((await getPrivateSettings()).apiKey).toBe('private-test-key');
  });

  it('moves credentials between stores and clears both explicitly', async () => {
    await saveSettings({ apiKey: 'private-test-key', rememberKey: true });
    expect(local.data['sidenote:apiKey']).toEqual({
      value: 'private-test-key',
      origin: 'https://api.openai.com',
    });
    expect(session.data['sidenote:apiKey']).toBeUndefined();
    await saveSettings({ rememberKey: false });
    expect(local.data['sidenote:apiKey']).toBeUndefined();
    expect(session.data['sidenote:apiKey']).toEqual({
      value: 'private-test-key',
      origin: 'https://api.openai.com',
    });
    expect((await clearKey()).hasApiKey).toBe(false);
    expect(local.data['sidenote:apiKey']).toBeUndefined();
    expect(session.data['sidenote:apiKey']).toBeUndefined();
  });

  it('does not send existing credentials to a different provider', async () => {
    await saveSettings({ apiKey: 'provider-a-key' });
    expect((await saveSettings({ baseUrl: 'https://provider-b.example/v1' })).hasApiKey).toBe(
      false,
    );
    expect((await getPrivateSettings()).apiKey).toBe('');
    expect(
      (await saveSettings({ baseUrl: 'https://provider-c.example/v1', apiKey: 'provider-c-key' }))
        .hasApiKey,
    ).toBe(true);
  });

  it('restricts local and session stores to trusted extension pages', async () => {
    await restrictStorageAccess();
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('never pairs a new provider with an old credential after an interrupted write', async () => {
    await saveSettings({ apiKey: 'provider-a-key' });
    const fields = local.data['sidenote:settings'] as Record<string, unknown>;
    // Simulate MV3 stopping after public config commits but before the credential commits.
    local.data['sidenote:settings'] = {
      ...fields,
      provider: 'custom',
      baseUrl: 'https://provider-b.example/v1',
    };
    expect((await getPrivateSettings()).apiKey).toBe('');
    expect((await getPublicSettings()).hasApiKey).toBe(false);
  });

  it('does not resurrect a key when another panel clears it during a settings save', async () => {
    await saveSettings({ apiKey: 'private-test-key' });
    const save = saveSettings({ prompt: 'New prompt' });
    const clear = clearKey();
    await Promise.all([save, clear]);
    expect((await getPrivateSettings()).apiKey).toBe('');
    expect(session.data['sidenote:apiKey']).toBeUndefined();
  });

  it('serializes reads behind a provider change and preserves parallel field updates', async () => {
    await saveSettings({ apiKey: 'private-test-key' });
    let enterWrite!: () => void;
    let releaseWrite!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterWrite = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    local.set.mockImplementationOnce(async (fields) => {
      Object.assign(local.data, fields);
      enterWrite();
      await blocked;
    });
    const change = saveSettings({ baseUrl: 'https://provider-b.example/v1' });
    await entered;
    let readFinished = false;
    const read = getPrivateSettings().then((value) => {
      readFinished = true;
      return value;
    });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    releaseWrite();
    await change;
    expect((await read).apiKey).toBe('');
    await Promise.all([
      saveSettings({ model: 'new-model' }),
      saveSettings({ targetLanguage: '日本語' }),
    ]);
    expect(await getPublicSettings()).toMatchObject({
      model: 'new-model',
      targetLanguage: '日本語',
    });
  });

  it.each([
    'http://remote.example/v1',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=secret',
    'https://example.com/v1#secret',
    'file:///etc/passwd',
    'invalid',
  ])('rejects unsafe endpoint %s', (url) => {
    expect(() => validateBaseUrl(url)).toThrow();
  });

  it('normalizes API roots and produces Chrome match patterns without ports', () => {
    expect(validateBaseUrl(' https://example.com/v1/// ')).toBe('https://example.com/v1');
    expect(getOriginPattern('http://127.0.0.1:8181/v1')).toBe('http://127.0.0.1/*');
    expect(getOriginPattern('http://localhost:8181/v1')).toBe('http://localhost/*');
  });

  it('rejects oversized prompts and invalid settings instead of partially saving', async () => {
    await expect(
      saveSettings({ prompt: 'a'.repeat(8001), apiKey: 'never-saved' }),
    ).rejects.toThrow();
    expect((await getPublicSettings()).hasApiKey).toBe(false);
    await expect(saveSettings({ temperature: -1 })).rejects.toThrow();
  });

  it.each(PROVIDERS)(
    'stores a preset with its fixed endpoint and default model: $id',
    async (provider) => {
      const saved = await saveSettings({ provider: provider.id });
      expect(saved).toMatchObject({
        provider: provider.id,
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        hasApiKey: false,
      });
      expect(await getPublicSettings()).toEqual(saved);
      expect(saved).not.toHaveProperty('apiKey');
    },
  );

  it.each(PROVIDERS)(
    'migrates a known legacy provider without losing its key: $id',
    async (provider) => {
      local.data['sidenote:settings'] = {
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        prompt: 'Keep my prompt',
      };
      session.data['sidenote:apiKey'] = {
        value: 'legacy-key',
        origin: new URL(provider.baseUrl).origin,
      };
      expect(await getPrivateSettings()).toMatchObject({
        provider: provider.id,
        model: provider.defaultModel,
        apiKey: 'legacy-key',
        prompt: 'Keep my prompt',
      });
    },
  );

  it('normalizes a known legacy DeepSeek /v1 root while retaining its same-origin key', async () => {
    local.data['sidenote:settings'] = {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    };
    session.data['sidenote:apiKey'] = { value: 'legacy-key', origin: 'https://api.deepseek.com' };
    expect(await getPrivateSettings()).toMatchObject({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      apiKey: 'legacy-key',
    });
  });

  it('keeps unknown old models as explicit legacy data instead of substituting another model', async () => {
    local.data['sidenote:settings'] = {
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      model: 'old-model-name',
    };
    session.data['sidenote:apiKey'] = { value: 'legacy-key', origin: 'https://api.openai.com' };
    expect(await getPrivateSettings()).toMatchObject({
      provider: 'custom',
      model: 'old-model-name',
      apiKey: 'legacy-key',
    });
    expect(await saveSettings({ targetLanguage: 'English' })).toMatchObject({
      provider: 'custom',
      model: 'old-model-name',
    });
  });

  it('does not invent a model for a legacy endpoint whose model was never configured', async () => {
    local.data['sidenote:settings'] = { baseUrl: 'https://old-provider.example/v1' };
    expect(await getPrivateSettings()).toMatchObject({ provider: 'custom', model: '' });
  });

  it('clears credentials when changing preset or leaving a same-origin legacy configuration', async () => {
    await saveSettings({ apiKey: 'openai-key', rememberKey: true });
    expect((await saveSettings({ provider: 'deepseek' })).hasApiKey).toBe(false);
    expect(JSON.stringify([local.data, session.data])).not.toContain('openai-key');
    await saveSettings({
      provider: 'custom',
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      model: 'gpt-4.1-mini',
      apiKey: 'legacy-key',
    });
    expect((await saveSettings({ provider: 'openai' })).hasApiKey).toBe(false);
    expect(JSON.stringify([local.data, session.data])).not.toContain('legacy-key');
    expect(
      (await saveSettings({ provider: 'anthropic', apiKey: 'new-claude-key' })).hasApiKey,
    ).toBe(true);
    expect((await getPrivateSettings()).apiKey).toBe('new-claude-key');
  });

  it('rejects a wrong provider model or endpoint before altering settings or credentials', async () => {
    await saveSettings({ apiKey: 'keep-key' });
    const before = structuredClone([local.data, session.data]);
    await expect(
      saveSettings({ provider: 'openai', model: 'deepseek-v4-flash', apiKey: 'never-saved' }),
    ).rejects.toThrow('模型');
    await expect(
      saveSettings({
        provider: 'anthropic',
        baseUrl: 'https://attacker.example/v1',
        apiKey: 'never-saved',
      }),
    ).rejects.toThrow('固定');
    expect([local.data, session.data]).toEqual(before);
  });

  it('clears the old key before a provider switch commits even if storage then fails', async () => {
    await saveSettings({ apiKey: 'old-key', rememberKey: true });
    local.set.mockRejectedValueOnce(new Error('Write interrupted'));
    await expect(saveSettings({ provider: 'anthropic' })).rejects.toThrow('Write interrupted');
    expect((await getPrivateSettings()).apiKey).toBe('');
    expect(JSON.stringify([local.data, session.data])).not.toContain('old-key');
  });
});
