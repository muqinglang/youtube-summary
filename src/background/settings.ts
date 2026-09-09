import { z } from 'zod';
import type { PublicSettings, Settings } from '../shared/types';
import { validateBaseUrl } from '../shared/endpoint';
import { getProvider, inferProvider } from '../shared/providers';
import { DEFAULT_HOSTED_URL, isAllowedHostedUrl } from '../shared/hosted';
export { getOriginPattern, validateBaseUrl } from '../shared/endpoint';

const SETTINGS_KEY = 'sidenote:settings';
const API_KEY = 'sidenote:apiKey';
const SESSION_KEY = 'sidenote:session';
let pendingSettings = Promise.resolve();
const DEFAULT_PROVIDER = getProvider('openai')!;

/** Keep settings and credentials consistent across concurrent panels. */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingSettings.then(operation, operation);
  pendingSettings = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'byok',
  serverUrl: DEFAULT_HOSTED_URL,
  sessionToken: '',
  accountEmail: '',
  provider: 'openai',
  baseUrl: DEFAULT_PROVIDER.baseUrl,
  model: DEFAULT_PROVIDER.defaultModel,
  apiKey: '',
  rememberKey: false,
  translationEngine: 'auto',
  autoTranslate: true,
  targetLanguage: '简体中文',
  prompt:
    '请完整总结视频中的核心观点、章节、案例和可执行建议，保留相关时间戳。只依据视频内容，不编造信息。',
  temperature: 0.3,
};

const settingsSchema = z.object({
  mode: z.enum(['byok', 'hosted']),
  serverUrl: z.string().max(2000).refine(isAllowedHostedUrl, '托管服务地址不在允许列表中。'),
  sessionToken: z.string().trim().max(4096),
  accountEmail: z.string().trim().max(320),
  provider: z.enum(['openai', 'deepseek', 'anthropic', 'custom']),
  baseUrl: z.string().max(2000),
  model: z.string().trim().max(200),
  apiKey: z.string().trim().max(8192),
  rememberKey: z.boolean(),
  translationEngine: z.enum(['auto', 'google', 'ai']),
  autoTranslate: z.boolean(),
  targetLanguage: z.string().trim().min(1).max(100),
  prompt: z.string().max(8000),
  temperature: z.number().min(0).max(2),
});

/** Both stores contain private data and must never be exposed to content scripts. */
export async function restrictStorageAccess(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
}

async function readSettings(): Promise<Settings> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([SETTINGS_KEY, API_KEY, SESSION_KEY]),
    chrome.storage.session.get(API_KEY),
  ]);
  const saved = settingsSchema
    .omit({ apiKey: true, sessionToken: true })
    .partial()
    .safeParse(local[SETTINGS_KEY]);
  const result = { ...DEFAULT_SETTINGS, ...(saved.success ? saved.data : {}) };
  try {
    result.baseUrl = validateBaseUrl(result.baseUrl);
  } catch {
    result.baseUrl = DEFAULT_SETTINGS.baseUrl;
  }
  result.provider =
    (saved.success ? saved.data.provider : undefined) ??
    inferProvider(result.baseUrl, saved.success ? (saved.data.model ?? '') : '');
  const provider = getProvider(result.provider);
  if (provider) {
    result.baseUrl = provider.baseUrl;
    result.model = (saved.success ? saved.data.model : '') || provider.defaultModel;
    if (!provider.models.some((model) => model.id === result.model)) result.provider = 'custom';
  } else result.model = saved.success ? (saved.data.model ?? '') : '';
  if (!isAllowedHostedUrl(result.serverUrl)) result.serverUrl = DEFAULT_SETTINGS.serverUrl;
  const bound = z.object({ value: z.string().max(8192), origin: z.string() });
  const key: unknown = result.rememberKey ? local[API_KEY] : session[API_KEY];
  const secret = bound.safeParse(key);
  // Origin binding remains safe even if the worker stops between storage writes.
  const apiKey =
    secret.success && secret.data.origin === new URL(result.baseUrl).origin
      ? secret.data.value
      : '';
  // The session is a bearer token with a server-side expiry, so staying signed in across restarts
  // is the expected behaviour; it is still pinned to the server it was issued by.
  const stored = bound.safeParse(local[SESSION_KEY]);
  const sessionToken =
    stored.success && stored.data.origin === new URL(result.serverUrl).origin
      ? stored.data.value
      : '';
  return { ...result, apiKey, sessionToken };
}

export async function getPrivateSettings(): Promise<Settings> {
  return serialize(readSettings);
}

function toPublic(settings: Settings): PublicSettings {
  const { apiKey, sessionToken, ...rest } = settings;
  return { ...rest, hasApiKey: Boolean(apiKey), hasSession: Boolean(sessionToken) };
}

export async function getPublicSettings(): Promise<PublicSettings> {
  return toPublic(await getPrivateSettings());
}

export async function saveSettings(patch: Partial<Settings>): Promise<PublicSettings> {
  return serialize(() => updateSettings(patch));
}

async function updateSettings(patch: Partial<Settings>): Promise<PublicSettings> {
  const parsed = settingsSchema.partial().safeParse(patch);
  if (!parsed.success) throw new Error('设置格式不正确，请检查翻译方式、模型、语言和提示词长度。');
  const current = await readSettings();
  const suppliedBaseUrl =
    parsed.data.baseUrl === undefined ? undefined : validateBaseUrl(parsed.data.baseUrl);
  const providerId =
    parsed.data.provider ??
    (suppliedBaseUrl !== undefined && suppliedBaseUrl !== current.baseUrl
      ? inferProvider(suppliedBaseUrl, parsed.data.model ?? '')
      : current.provider);
  const provider = getProvider(providerId);
  if (provider && suppliedBaseUrl !== undefined && suppliedBaseUrl !== provider.baseUrl)
    throw new Error('此提供商使用固定 API 地址，请重新选择提供商。');
  const baseUrl = provider?.baseUrl ?? suppliedBaseUrl ?? current.baseUrl;
  const providerChanged = providerId !== current.provider;
  const model =
    parsed.data.model ?? (providerChanged && provider ? provider.defaultModel : current.model);
  if (provider && !provider.models.some((option) => option.id === model))
    throw new Error('所选模型不属于此提供商，请从模型列表中重新选择。');
  const originChanged = new URL(baseUrl).origin !== new URL(current.baseUrl).origin;
  // A blank key field means "keep existing". A dedicated action clears the key.
  // Changing providers never silently sends the previous provider's credential.
  const apiKey = parsed.data.apiKey || (originChanged || providerChanged ? '' : current.apiKey);
  const settings = settingsSchema.parse({
    ...current,
    ...parsed.data,
    provider: providerId,
    baseUrl,
    model,
    apiKey,
  });
  const { apiKey: secret, ...publicFields } = settings;
  const credential = { value: secret, origin: new URL(baseUrl).origin };
  if (providerChanged || originChanged) {
    await Promise.all([
      chrome.storage.local.remove(API_KEY),
      chrome.storage.session.remove(API_KEY),
    ]);
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: publicFields });
  if (settings.rememberKey) {
    await chrome.storage.local.set({ [API_KEY]: credential });
    await chrome.storage.session.remove(API_KEY);
  } else {
    await chrome.storage.session.set({ [API_KEY]: credential });
    await chrome.storage.local.remove(API_KEY);
  }
  return toPublic(settings);
}

/** Stores the hosted session pinned to the server that issued it. */
export async function saveSession(token: string, email: string): Promise<PublicSettings> {
  return serialize(async () => {
    const current = await readSettings();
    const { apiKey, sessionToken, ...publicFields } = { ...current, accountEmail: email };
    void apiKey;
    void sessionToken;
    await chrome.storage.local.set({
      [SETTINGS_KEY]: publicFields,
      [SESSION_KEY]: { value: token, origin: new URL(current.serverUrl).origin },
    });
    return toPublic({ ...current, accountEmail: email, sessionToken: token });
  });
}

export async function clearSession(): Promise<PublicSettings> {
  return serialize(async () => {
    await chrome.storage.local.remove(SESSION_KEY);
    const current = await readSettings();
    const { apiKey, sessionToken, ...publicFields } = { ...current, accountEmail: '' };
    void apiKey;
    void sessionToken;
    await chrome.storage.local.set({ [SETTINGS_KEY]: publicFields });
    return toPublic({ ...current, accountEmail: '', sessionToken: '' });
  });
}

export async function clearKey(): Promise<PublicSettings> {
  return serialize(async () => {
    await Promise.all([
      chrome.storage.local.remove(API_KEY),
      chrome.storage.session.remove(API_KEY),
    ]);
    return toPublic(await readSettings());
  });
}
