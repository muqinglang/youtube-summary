import type { AiRequest, AiResult, Settings } from '../shared/types';
import { runAi, testConnection, type ProgressCallback } from './ai-service';
import { AiClient } from './client';
import { HostedClient, type HostedOptions } from './hosted';

/**
 * The seam between the two ways a job can run. It sits at the job level rather than around the
 * HTTP client on purpose: in hosted mode the extension never talks to a model at all, the server
 * runs the whole pipeline, so there is no per-call client to swap.
 */
export interface AiRunner {
  run(request: AiRequest, signal: AbortSignal, onProgress: ProgressCallback): Promise<AiResult>;
  /** Confirms the configuration works before the user spends a long job discovering it does not. */
  test(signal: AbortSignal): Promise<{ message: string }>;
}

/** Bring-your-own-key: the pipeline runs here and calls the provider directly. */
export function createLocalRunner(settings: Settings): AiRunner {
  return {
    run: (request, signal, onProgress) =>
      runAi(request, settings, signal, onProgress, new AiClient(settings)),
    test: (signal) => testConnection(settings, signal),
  };
}

/** Hosted: the server runs the pipeline, spends its own key, and shares results between users. */
export function createHostedRunner(settings: Settings, options: HostedOptions = {}): AiRunner {
  const client = new HostedClient(settings.serverUrl, settings.sessionToken, options);
  return {
    run: (request, signal, onProgress) => client.run(request, signal, onProgress),
    test: async (signal) => {
      const status = await client.me(signal);
      const left = Math.max(0, status.usage.dailyJobLimit - status.usage.jobsToday);
      return { message: `已登录 ${status.user.email}，今日还可发起 ${left} 个任务。` };
    },
  };
}

export function createRunner(settings: Settings, options: HostedOptions = {}): AiRunner {
  return settings.mode === 'hosted'
    ? createHostedRunner(settings, options)
    : createLocalRunner(settings);
}
