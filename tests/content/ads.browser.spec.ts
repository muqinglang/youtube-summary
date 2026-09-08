import { build } from 'esbuild';
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import type { Reply, VideoInfo } from '../../src/shared/types';
import { browserExecutable } from '../e2e/fixtures';
import { REQUEST_CHANNEL, RESPONSE_CHANNEL } from '../../src/content/protocol';

interface FixtureWindow extends Window {
  __clock: { currentTime: number; duration: number; paused: boolean };
}
let browser: Browser;
let bundle: string;
let page: Page;
test.beforeAll(async () => {
  const output = await build({
    entryPoints: ['src/content/page.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  });
  bundle = output.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
});
test.afterAll(async () => browser?.close());
test.afterEach(async () => page?.close());

async function setup(advertising = false) {
  page = await browser.newPage();
  await page.route('https://www.youtube.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Original video</title><div id="movie_player"><video class="html5-main-video"></video></div>',
    }),
  );
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.evaluate((ad) => {
    const fixture = window as unknown as FixtureWindow;
    const video = document.querySelector('video')!;
    const player = document.querySelector('#movie_player')!;
    if (ad) player.classList.add('ad-showing');
    fixture.__clock = { currentTime: ad ? 4 : 72, duration: ad ? 12 : 360, paused: false };
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => fixture.__clock.currentTime,
        set: (time: number) => {
          fixture.__clock.currentTime = time;
        },
      },
      duration: { configurable: true, get: () => fixture.__clock.duration },
      paused: { configurable: true, get: () => fixture.__clock.paused },
    });
    Object.defineProperty(player, 'getPlayerResponse', {
      value: () => ({
        videoDetails: {
          videoId: 'dQw4w9WgXcQ',
          title: 'Content video',
          author: 'Author',
          lengthSeconds: '360',
        },
      }),
    });
  }, advertising);
  await page.addScriptTag({ content: bundle });
}
function request(body: unknown): Promise<Reply<VideoInfo>> {
  return page.evaluate(
    ({ body, requestChannel, responseChannel }) =>
      new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          window.removeEventListener('message', receive);
          reject(new Error('Bridge timeout'));
        }, 3000);
        function receive(event: MessageEvent) {
          if (
            event.source !== window ||
            event.origin !== location.origin ||
            event.data?.channel !== responseChannel ||
            event.data.id !== id
          )
            return;
          clearTimeout(timer);
          window.removeEventListener('message', receive);
          resolve(event.data.reply);
        }
        window.addEventListener('message', receive);
        window.postMessage({ channel: requestChannel, id, request: body }, location.origin);
      }),
    { body, requestChannel: REQUEST_CHANNEL, responseChannel: RESPONSE_CHANNEL },
  );
}

test('mid-roll advertisements preserve the original video clock and reject content seeks', async () => {
  await setup();
  expect(await request({ type: 'video:get' })).toMatchObject({
    ok: true,
    data: { duration: 360, currentTime: 72 },
  });
  await page.evaluate(() => {
    document.querySelector('#movie_player')!.classList.add('ad-showing');
    (window as unknown as FixtureWindow).__clock = { currentTime: 8, duration: 15, paused: false };
  });
  expect(await request({ type: 'video:get' })).toMatchObject({
    ok: true,
    data: { duration: 360, currentTime: 72, paused: true },
  });
  expect(
    await request({ type: 'player:command', command: { action: 'seek', time: 100 } }),
  ).toMatchObject({ ok: false, error: expect.stringContaining('广告') });
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__clock.currentTime)).toBe(
    8,
  );
  await page.evaluate(() => {
    document.querySelector('#movie_player')!.classList.remove('ad-showing');
    (window as unknown as FixtureWindow).__clock = {
      currentTime: 82,
      duration: 360,
      paused: false,
    };
  });
  expect(await request({ type: 'video:get' })).toMatchObject({
    ok: true,
    data: { duration: 360, currentTime: 82, paused: false },
  });
  expect(
    await request({ type: 'player:command', command: { action: 'seek', time: 100 } }),
  ).toMatchObject({ ok: true });
  expect(await page.evaluate(() => (window as unknown as FixtureWindow).__clock.currentTime)).toBe(
    100,
  );
});

test('opening during pre-roll uses content metadata rather than advertisement duration', async () => {
  await setup(true);
  expect(await request({ type: 'video:get' })).toMatchObject({
    ok: true,
    data: { duration: 360, currentTime: 0, paused: true },
  });
});
