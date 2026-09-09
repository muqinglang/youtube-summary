import { runAi, type JsonClient, type ProgressCallback } from '../../src/background/ai-service';
import { AiClient } from '../../src/background/client';
import type { AiRequest, AiResult, Cue, Settings } from '../../src/shared/types';
import type { Store } from '../store/types';

/**
 * Bump whenever a prompt, schema or pipeline rule changes. It is part of every cache key, so a
 * change retires the old artifacts instead of serving results the current code would not produce.
 */
export const PIPELINE_VERSION = 3;

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Identifies the exact subtitle text an artifact was derived from. */
export function cuesFingerprint(cues: Cue[]): Promise<string> {
  return sha256(cues.map((cue) => [cue.id, cue.start, cue.text]));
}

/**
 * What actually makes two requests interchangeable. Deliberately excludes the user: an outline of
 * a video is the same outline for everyone, which is the whole point of a shared cache.
 */
export async function artifactKey(
  request: AiRequest,
  model: string,
  fingerprint: string,
): Promise<string> {
  const base = {
    version: PIPELINE_VERSION,
    task: request.task,
    model,
    language: request.language,
    fingerprint,
  };
  if (request.task === 'summarize') return sha256({ ...base, prompt: request.prompt.trim() });
  if (request.task === 'ask') return sha256({ ...base, question: request.question.trim() });
  return sha256(base);
}

export interface GatewayResult {
  result: AiResult;
  cached: boolean;
}

export interface Gateway {
  /** Cache lookup only. Never calls a provider, so it is safe on the request path. */
  peek(request: AiRequest): Promise<AiResult | undefined>;
  run(
    request: AiRequest,
    onProgress: ProgressCallback,
    signal: AbortSignal,
  ): Promise<GatewayResult>;
}

export function createGateway(store: Store, settings: Settings, client?: JsonClient): Gateway {
  const keyFor = async (request: AiRequest): Promise<string> =>
    artifactKey(request, settings.model, await cuesFingerprint(request.transcript.cues));
  return {
    async peek(request) {
      const hit = await store.artifacts.get(await keyFor(request));
      return hit ? (hit.payload as AiResult) : undefined;
    },
    async run(request, onProgress, signal) {
      const key = await keyFor(request);
      const hit = await store.artifacts.get(key);
      if (hit) {
        // A hit is the common path once a video has been processed once by anyone.
        return { result: hit.payload as AiResult, cached: true };
      }
      const result = await runAi(
        request,
        settings,
        signal,
        onProgress,
        // The server is not an extension: it has no permission model to consult, and the default
        // check calls chrome.permissions, which does not exist in Node.
        client ?? new AiClient(settings, { permissionCheck: async () => true }),
        {
          // Fragment digests outlive a single task: outline and guide read identical evidence, so
          // the second of them costs one call instead of thirty.
          digests: store.digests,
        },
      );
      await store.artifacts.put({
        key,
        videoId: request.transcript.videoId,
        task: request.task,
        payload: result,
        ...('notice' in result && result.notice ? { notice: result.notice } : {}),
        createdAt: new Date().toISOString(),
      });
      return { result, cached: false };
    },
  };
}
