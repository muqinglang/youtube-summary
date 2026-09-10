import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config';

/** The minimum a deployment must supply; every test starts from this and changes one thing. */
const BASE = {
  SIDENOTE_SESSION_SECRET: 'a-secret-long-enough-to-pass-the-length-check',
  SIDENOTE_PROVIDER: 'openai',
  SIDENOTE_MODEL: 'gpt-4.1-mini',
  SIDENOTE_API_KEY: 'server-side-key',
  SIDENOTE_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
} satisfies NodeJS.ProcessEnv;

const load = (extra: NodeJS.ProcessEnv = {}) => loadConfig({ ...BASE, ...extra });

describe('server configuration', () => {
  it('refuses a deployment that cannot run safely rather than guessing', () => {
    expect(() => loadConfig({ ...BASE, SIDENOTE_SESSION_SECRET: 'too-short' })).toThrow(
      'SIDENOTE_SESSION_SECRET',
    );
    // 33 characters, so the length check alone waves it through — and it is published here.
    expect(() =>
      loadConfig({ ...BASE, SIDENOTE_SESSION_SECRET: 'change-me-to-a-long-random-string' }),
    ).toThrow('占位值');
    expect(() =>
      loadConfig({ ...BASE, SIDENOTE_SESSION_SECRET: '  CHANGE-ME-TO-A-LONG-RANDOM-STRING  ' }),
    ).toThrow('占位值');
    expect(() => loadConfig({ ...BASE, SIDENOTE_PROVIDER: 'gemini' })).toThrow('SIDENOTE_PROVIDER');
    // A custom provider has no official endpoint to fall back on.
    expect(() => loadConfig({ ...BASE, SIDENOTE_PROVIDER: 'custom' })).toThrow('SIDENOTE_BASE_URL');
    expect(() => loadConfig({ ...BASE, SIDENOTE_API_KEY: '  ' })).toThrow('SIDENOTE_API_KEY');
    // Sign-in is the only way in, so a deployment without a client id can serve nobody.
    expect(() => loadConfig({ ...BASE, SIDENOTE_GOOGLE_CLIENT_ID: '' })).toThrow(
      'SIDENOTE_GOOGLE_CLIENT_ID',
    );
  });

  it('leaves cross-video search off when no embedding key is supplied', () => {
    // The whole feature is opt-in: a deployment without a second provider still runs everything
    // else, so its absence must not be an error.
    expect(load().embedding).toBeUndefined();
    expect(load({ SIDENOTE_EMBEDDING_API_KEY: '   ' }).embedding).toBeUndefined();
    // Setting the other variables alone is not enough to switch it on.
    expect(load({ SIDENOTE_EMBEDDING_MODEL: 'text-embedding-v4' }).embedding).toBeUndefined();
  });

  it('defaults an embedding provider to Bailian at the dimensions the column is built for', () => {
    expect(load({ SIDENOTE_EMBEDDING_API_KEY: 'embed-key' }).embedding).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'text-embedding-v3',
      apiKey: 'embed-key',
      dimensions: 1024,
      batchSize: 10,
    });
  });

  it('takes an override for every part, so switching provider is not a code change', () => {
    expect(
      load({
        SIDENOTE_EMBEDDING_API_KEY: 'embed-key',
        SIDENOTE_EMBEDDING_BASE_URL: 'https://api.openai.com/v1/',
        SIDENOTE_EMBEDDING_MODEL: 'text-embedding-3-small',
        SIDENOTE_EMBEDDING_DIMENSIONS: '1536',
        SIDENOTE_EMBEDDING_BATCH: '32',
      }).embedding,
    ).toEqual({
      // The trailing slash is normalised away, because the path is appended to it.
      baseUrl: 'https://api.openai.com/v1',
      model: 'text-embedding-3-small',
      apiKey: 'embed-key',
      dimensions: 1536,
      batchSize: 32,
    });
  });

  it.each(['0', '32', '8192', '1024.5', 'lots'])(
    'refuses %j as a vector dimension, naming the variable to change',
    (dimensions) => {
      // This value reaches a CREATE TABLE as a literal, so it is never taken on trust.
      expect(() =>
        load({
          SIDENOTE_EMBEDDING_API_KEY: 'embed-key',
          SIDENOTE_EMBEDDING_DIMENSIONS: dimensions,
        }),
      ).toThrow('SIDENOTE_EMBEDDING_DIMENSIONS');
    },
  );

  it.each(['0', '101', '2.5'])('refuses %j as a batch size', (batch) => {
    expect(() =>
      load({ SIDENOTE_EMBEDDING_API_KEY: 'embed-key', SIDENOTE_EMBEDDING_BATCH: batch }),
    ).toThrow('SIDENOTE_EMBEDDING_BATCH');
  });

  it('refuses an embedding endpoint that would send the key in the clear', () => {
    expect(() =>
      load({
        SIDENOTE_EMBEDDING_API_KEY: 'embed-key',
        SIDENOTE_EMBEDDING_BASE_URL: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    ).toThrow('HTTPS');
    // Localhost over HTTP stays allowed, which is how a mock is pointed at during development.
    expect(
      load({
        SIDENOTE_EMBEDDING_API_KEY: 'embed-key',
        SIDENOTE_EMBEDDING_BASE_URL: 'http://127.0.0.1:9999/v1',
      }).embedding?.baseUrl,
    ).toBe('http://127.0.0.1:9999/v1');
  });
});
