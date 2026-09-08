import type { AiProvider } from './types';

export interface ProviderModel {
  id: string;
  label: string;
  maxOutputTokens: number;
  supportsTemperature: boolean;
}

export interface ProviderDefinition {
  id: Exclude<AiProvider, 'custom'>;
  label: string;
  baseUrl: string;
  defaultModel: string;
  models: readonly ProviderModel[];
}

/** Curated from official model documentation on 2026-09-07; availability still depends on the account. */
export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    // https://developers.openai.com/api/docs/models/gpt-4.1-mini
    // https://developers.openai.com/api/docs/models/gpt-4.1
    models: [
      {
        id: 'gpt-4.1-mini',
        label: 'GPT-4.1 mini',
        maxOutputTokens: 32768,
        supportsTemperature: true,
      },
      { id: 'gpt-4.1', label: 'GPT-4.1', maxOutputTokens: 32768, supportsTemperature: true },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    // https://api-docs.deepseek.com/quick_start/pricing/
    models: [
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        maxOutputTokens: 384000,
        supportsTemperature: true,
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        maxOutputTokens: 384000,
        supportsTemperature: true,
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Claude · Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-haiku-4-5-20251001',
    // https://platform.claude.com/docs/en/models/overview
    // https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5
    models: [
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        maxOutputTokens: 64000,
        supportsTemperature: true,
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        maxOutputTokens: 128000,
        supportsTemperature: false,
      },
    ],
  },
];

export function getProvider(id: AiProvider): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Unknown old models/endpoints remain explicit legacy configurations until the user chooses a preset. */
export function inferProvider(baseUrl: string, model: string): AiProvider {
  const provider = PROVIDERS.find(
    (item) =>
      item.baseUrl === baseUrl ||
      (item.id === 'deepseek' && baseUrl === 'https://api.deepseek.com/v1'),
  );
  return provider && (!model || provider.models.some((item) => item.id === model))
    ? provider.id
    : 'custom';
}
