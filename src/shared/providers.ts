import type { AiProvider } from './types';

/**
 * Which request shape the model answers to. Most speak OpenAI's Chat Completions; Claude speaks
 * its own Messages API; and a few reasoning models are only reachable through Responses, which is
 * a property of the model rather than of the service hosting it.
 */
export type ModelProtocol = 'chat' | 'messages' | 'responses';

export interface ProviderModel {
  id: string;
  label: string;
  maxOutputTokens: number;
  supportsTemperature: boolean;
  protocol?: ModelProtocol;
}

export interface ProviderDefinition {
  id: Exclude<AiProvider, 'custom'>;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** Shown under the picker when what the account needs is not obvious from the name. */
  note?: string;
  models: readonly ProviderModel[];
}

/**
 * A ceiling, not a documented per-model figure: the client sends min(budget, this), and the longest
 * budget in the pipeline is 8000 tokens, so it only has to stay above that.
 */
const GO = { maxOutputTokens: 16384, supportsTemperature: true } as const;

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
    id: 'opencode',
    label: 'opencode Zen · 按量',
    baseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'claude-haiku-4-5',
    note: '按量计费，要先在 opencode 控制台充值；订阅了 Go 的请改选「opencode Go」。',
    // One key for models from several vendors, OpenAI-compatible on /chat/completions.
    // https://opencode.ai/docs/zen/ — model ids from https://opencode.ai/zen/v1/models
    models: [
      {
        id: 'claude-haiku-4-5',
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
      {
        id: 'gemini-3.5-flash',
        label: 'Gemini 3.5 Flash',
        maxOutputTokens: 65536,
        supportsTemperature: true,
      },
      {
        id: 'gpt-5.4-mini',
        label: 'GPT-5.4 mini',
        maxOutputTokens: 32768,
        supportsTemperature: false,
      },
    ],
  },
  {
    id: 'opencode-go',
    label: 'opencode Go · 订阅',
    // Same key as Zen, different endpoint and a different catalogue: a Go subscription spends its
    // monthly allowance here, while the same key on the Zen endpoint draws on a balance it has none of.
    baseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'glm-5.3-flash',
    note: '$10/月订阅，与 Zen 同一把 Key、不同模型目录。标「需开启」的要先在 opencode 工作区的 Go 页面开启中国区托管。',
    /**
     * Every one of these answered a real request on 2026-09-20, through the same OpenAI-compatible
     * path and JSON mode this tool uses. Left out of the catalogue at https://opencode.ai/zen/go/v1/models:
     * the code-only, vision-experimental, preview and contributor builds, and the older minor
     * versions of what is here. The last two answer on Responses rather than Chat Completions. The
     * DeepSeek entries answer only once the workspace has opted in to China-hosted models, which is
     * a click on the page their error links to.
     *
     * GO below is a ceiling, not a documented per-model limit: the longest thing this pipeline ever
     * asks for is 8000 tokens, so every model here is capped well above what it is sent.
     */
    models: [
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', ...GO },
      { id: 'glm-5.3', label: 'GLM-5.3', ...GO },
      { id: 'glm-5.2', label: 'GLM-5.2', ...GO },
      { id: 'qwen3.8-flash', label: 'Qwen 3.8 Flash', ...GO },
      { id: 'qwen3.8-max', label: 'Qwen 3.8 Max', ...GO },
      { id: 'kimi-k3', label: 'Kimi K3', ...GO },
      { id: 'minimax-m3', label: 'MiniMax M3', ...GO },
      { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro', ...GO },
      { id: 'longcat-2.0', label: 'LongCat 2.0', ...GO },
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash · 需开启', ...GO },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro · 需开启', ...GO },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash · 需开启', ...GO },
      // Reachable only through Responses; the chat path answers "not supported for format oa-compat".
      { id: 'grok-4.6', label: 'Grok 4.6', ...GO, protocol: 'responses' },
      // And this one refuses a temperature on top of that.
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        ...GO,
        protocol: 'responses',
        supportsTemperature: false,
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
