import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type FrameLocator,
  type Page,
} from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import {
  actionBarFixture,
  browserExecutable,
  CAPTIONS,
  CHAPTERS,
  CUSTOM_PROMPT,
  IMPORTED_SRT,
  providerTransportScript,
  silentMedia,
  startProvider,
  SUMMARY,
  VIDEO_ID,
  VIDEO_TITLE,
  VIDEO_URL,
  youtubeEmbedFixture,
  youtubeFixture,
} from './fixtures';

test.describe.configure({ mode: 'serial' });
let context: BrowserContext;
let source: Page;
let learning: Page;
let panel: FrameLocator;
let embed: FrameLocator;
let provider: Awaited<ReturnType<typeof startProvider>>;
const browserErrors: string[] = [];
const diagnostics: string[] = [];
const captionRequests: string[] = [];
const FALLBACK_ID = 'TESTVIDEO03';
const FALLBACK_TITLE = '原生转录回退 · 延迟字幕轨道';

/** 翻译设置 live in a collapsible drawer, so its controls have to be revealed before use. */
async function openSubtitleSettings(): Promise<void> {
  const toggle = panel.locator('#settings-drawer-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(panel.locator('#settings-drawer')).toBeVisible();
}

async function captionCommands() {
  return embed.locator('body').evaluate(() => {
    const commands =
      (window as Window & { __playerCommands?: { func: string; args: unknown[] }[] })
        .__playerCommands ?? [];
    return commands.filter(({ func }) => func === 'loadModule' || func === 'unloadModule');
  });
}

async function expectDesktopTheater() {
  const layout = await learning.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`Missing lesson element: ${selector}`);
      const rect = node.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      title: box('#lesson-title'),
      screen: box('.screen'),
      player: box('.player-wrap'),
      controls: box('.playback'),
      width: innerWidth,
      height: innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
    };
  });
  expect(layout.title.bottom).toBeLessThanOrEqual(layout.screen.top);
  expect(layout.screen.height).toBeGreaterThan(layout.height * 0.75);
  expect(layout.controls.bottom).toBeLessThanOrEqual(layout.height + 1);
  expect(layout.controls.top).toBeGreaterThan(layout.player.bottom);
  expect(layout.player.width / layout.player.height).toBeCloseTo(16 / 9, 2);
  expect(layout.player.left).toBeGreaterThan(layout.screen.left);
  expect(layout.player.right).toBeLessThan(layout.screen.right);
  expect(layout.pageWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.pageHeight).toBeLessThanOrEqual(layout.height + 1);
}

function learningPages() {
  return context.pages().filter((page) => /\/learn\.html\?/.test(page.url()) && !page.isClosed());
}
async function learningState() {
  const worker = context.serviceWorkers()[0];
  return worker?.evaluate(async () => ({
    index: (await chrome.storage.session.get('learning:tabs'))['learning:tabs'],
    tabs: (await chrome.tabs.query({})).map(({ id, url, pendingUrl }) => ({ id, url, pendingUrl })),
  }));
}
async function openLearning(videoTitle = VIDEO_TITLE) {
  const opened = context.waitForEvent('page');
  await source.getByRole('button', { name: '打开旁听学习页面' }).click();
  learning = await opened;
  await learning.waitForURL(/chrome-extension:\/\/[^/]+\/learn\.html\?/);
  panel = learning.frameLocator('#study-panel');
  embed = learning.frameLocator('#player');
  await expect(learning.locator('#lesson-title')).toHaveText(videoTitle);
  await expect(panel.locator('#video-title')).toHaveText(videoTitle);
  await expect(embed.locator('video')).toHaveAttribute('data-connected', 'true');
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.duration))
    .toBe(45);
}

test.beforeAll(async () => {
  const output = resolve('test-results');
  await mkdir(output, { recursive: true });
  const runDirectory = await mkdtemp(join(output, 'extension-run-'));
  const extension = join(runDirectory, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  // Only the test copy grants fixture/API origins. Chrome APIs are never mocked.
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push(
    'http://127.0.0.1/*',
    'https://api.openai.com/*',
    'https://api.deepseek.com/*',
    'https://api.anthropic.com/*',
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  provider = await startProvider();
  const workerPath = join(extension, 'background.js');
  await writeFile(
    workerPath,
    providerTransportScript(provider.origin) + (await readFile(workerPath, 'utf8')),
  );
  context = await chromium.launchPersistentContext(join(runDirectory, 'profile'), {
    executablePath: browserExecutable(),
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message)));
  context.on('requestfailed', (request) =>
    diagnostics.push(request.url() + ': ' + request.failure()?.errorText),
  );
  context.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  const media = silentMedia();
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/watch') {
      await route.fulfill({
        contentType: 'text/html',
        body:
          url.searchParams.get('v') === FALLBACK_ID
            ? youtubeFixture({
                videoId: FALLBACK_ID,
                title: FALLBACK_TITLE,
                nativeTranscript: true,
                lateTracks: true,
                chapters: false,
              })
            : youtubeFixture(),
      });
    } else if (url.pathname.startsWith('/embed/')) {
      expect(url.searchParams.get('enablejsapi')).toBe('1');
      expect(url.searchParams.get('origin')).toMatch(/^chrome-extension:\/\//);
      expect(url.searchParams.get('cc_load_policy')).toBe('0');
      await route.fulfill({ contentType: 'text/html', body: youtubeEmbedFixture() });
    } else if (url.pathname === '/fixture.wav') {
      const range = route
        .request()
        .headers()
        .range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = Number(range?.[1] || 0);
      const end = Number(range?.[2] || media.length - 1);
      await route.fulfill({
        status: range ? 206 : 200,
        contentType: 'audio/wav',
        body: media.subarray(start, end + 1),
        headers: {
          'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + media.length } : {}),
        },
      });
    } else if (url.pathname === '/api/timedtext') {
      captionRequests.push(url.href);
      expect([VIDEO_ID, 'TESTVIDEO02', FALLBACK_ID]).toContain(url.searchParams.get('v'));
      expect(url.searchParams.get('signature')).toBe('fixture');
      // The signed fixture URL has no fmt; preserve its native parameters.
      expect(url.searchParams.get('fmt')).toBeNull();
      await route.fulfill({
        contentType: 'application/json',
        body: url.searchParams.get('v') === FALLBACK_ID ? '' : JSON.stringify(CAPTIONS),
      });
    } else await route.fulfill({ status: 204 });
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  expect(worker.url()).toMatch(/^chrome-extension:\/\/[^/]+\/background\.js$/);
  source = await context.newPage();
  await source.goto(VIDEO_URL);
  await expect
    .poll(() => source.locator('video').evaluate((video: HTMLVideoElement) => video.duration))
    .toBe(45);
  await source.locator('video').evaluate((video: HTMLVideoElement) => {
    video.currentTime = 7;
    video.pause();
  });
  await openLearning();
  await expect(panel.locator('#source-state')).toHaveText('已读取原生字幕');
});
test.afterAll(async () => {
  await context?.close();
  await provider?.close();
});
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  const path = testInfo.outputPath('diagnostics.json');
  await writeFile(
    path,
    JSON.stringify(
      {
        diagnostics,
        browserErrors,
        providerCalls: provider?.calls,
        learningState: await learningState(),
      },
      null,
      2,
    ),
  );
  await testInfo.attach('browser-diagnostics', { path, contentType: 'application/json' });
});

// eslint-disable-next-line no-empty-pattern
test('independent learning page: source untouched, embedded playback, real API, summary, translation, Q&A and exports', async ({}, testInfo) => {
  const launcher = source.getByRole('button', { name: '打开旁听学习页面' });
  await expect(source.locator('#sidenote-launcher')).toHaveCount(1);
  await expect(
    source.locator('#sidenote-launcher + segmented-like-dislike-button-view-model'),
  ).toHaveCount(1);
  await expect(launcher).toHaveText(/旁听\s*AI/);
  await expect(launcher).not.toHaveCSS('position', 'fixed');
  await expect(source.locator('iframe')).toHaveCount(0);
  await expect(source.locator('html')).not.toHaveAttribute('data-sidenote-open');
  expect(new URL(learning.url()).searchParams.get('videoId')).toBe(VIDEO_ID);
  expect(new URL(learning.url()).searchParams.get('start')).toBe('7');
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(7, 0);
  const existingLearning = learning;
  diagnostics.push(JSON.stringify({ beforeRepeatedOpen: await learningState() }));
  await launcher.click();
  await expect(launcher).toBeEnabled();
  await expect.poll(() => learningPages().length).toBe(1);
  expect(learningPages()[0]).toBe(existingLearning);
  await source.screenshot({ path: testInfo.outputPath('source-launcher.png'), fullPage: true });
  await expect(panel.locator('.cue')).toHaveCount(4);
  expect(await panel.getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.id))).toEqual([
    'tab-transcript',
    'tab-chapters',
    'tab-guide',
    'tab-summary',
    'tab-chat',
  ]);
  await panel.locator('#tab-transcript').focus();
  await learning.keyboard.press('ArrowRight');
  await expect(panel.locator('#tab-chapters')).toBeFocused();
  await expect(panel.locator('#tab-chapters')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('#view-chapters')).toBeVisible();
  await expect(panel.locator('#view-transcript')).toBeHidden();
  await expect(panel.locator('.chapter-card')).toHaveCount(CHAPTERS.length);
  await expect(panel.locator('#chapter-count')).toHaveText('3 章');
  for (const [index, chapter] of CHAPTERS.entries())
    await expect(panel.locator('.chapter-card').nth(index)).toContainText(chapter.title);
  await expect(panel.locator('#chapter-empty')).not.toBeVisible();
  await expect(panel.locator('#chapter-source')).toContainText('视频原生章节');
  await panel.locator('.chapter-card').nth(2).focus();
  await learning.keyboard.press('Enter');
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(35, 0);
  await expect(panel.locator('.chapter-card').nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.chapter-card').nth(2)).toBeFocused();
  await expect(learning.locator('#original')).toContainText('学以致用');
  await panel.locator('.chapter-card').nth(1).click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  await expect(panel.locator('.chapter-card').nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(embed.locator('#native-captions')).toBeHidden();
  await expect.poll(captionCommands).toEqual([
    { func: 'unloadModule', args: ['captions'] },
    { func: 'unloadModule', args: ['captions'] },
  ]);
  // The real source metadata bridge supplies a longer native chapter list for scroll coverage.
  await source.evaluate((videoId) => {
    (window as Window & { ytInitialData?: unknown }).ytInitialData = {
      currentVideoEndpoint: { watchEndpoint: { videoId } },
      playerOverlays: {
        chapters: Array.from({ length: 57 }, (_, index) => ({
          chapterRenderer: {
            title: { simpleText: `滚动章节 ${index + 1}` },
            timeRangeStartMillis: index * 750,
          },
        })),
      },
    };
  }, VIDEO_ID);
  await expect(panel.locator('.chapter-card')).toHaveCount(57);
  await expect(panel.locator('#chapter-count')).toHaveText('57 章');
  await panel.locator('.chapter-card').last().scrollIntoViewIfNeeded();
  await panel.locator('.chapter-card').last().focus();
  await learning.keyboard.press('Enter');
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(42, 0);
  await expect(panel.locator('.chapter-card').last()).toHaveAttribute('aria-current', 'true');
  await expect(panel.locator('.chapter-card').last()).toBeFocused();
  await panel.locator('#chapter-list').evaluate((list) => {
    list.scrollTop = 0;
  });
  await panel.locator('#tab-transcript').click();
  await panel.locator('#tab-chapters').click();
  await expect
    .poll(() => panel.locator('#chapter-list').evaluate((list) => list.scrollTop))
    .toBeGreaterThan(0);
  await learning.screenshot({ path: testInfo.outputPath('learning-57-chapters.png') });
  await source.evaluate(() => {
    delete (window as Window & { ytInitialData?: unknown }).ytInitialData;
  });
  await expect(panel.locator('.chapter-card')).toHaveCount(CHAPTERS.length);
  await expectDesktopTheater();
  await expect(
    learning.locator(
      '.course-heading, .language-bar, .chapters, .local-note, #lesson-language, #lesson-display, #translate',
    ),
  ).toHaveCount(0);
  await panel.locator('#tab-transcript').click();
  await panel.locator('[data-cue="2"]').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  expect(
    await source.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime),
  ).toBe(7);
  await expect(panel.locator('[data-cue="2"]')).toHaveAttribute('aria-current', 'true');
  await learning.locator('#speed').selectOption('1.5');
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.playbackRate))
    .toBe(1.5);
  expect(
    await source.locator('video').evaluate((video: HTMLVideoElement) => video.playbackRate),
  ).toBe(1);
  await learning.locator('#play').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(false);
  await learning.locator('#play').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true);
  expect(await source.locator('video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(
    true,
  );

  await learning.locator('#settings').click();
  await expect(panel.locator('input#base-url')).toHaveCount(0);
  await panel.locator('#provider').selectOption('openai');
  await panel.locator('#model').selectOption('gpt-4.1-mini');
  await panel.locator('#api-key').fill('sidenote-test-key');
  await panel.locator('#remember-key').check();
  await panel.locator('#save-settings').click();
  await expect(panel.locator('#settings-dialog')).not.toBeVisible();
  await learning.locator('#settings').click();
  await expect(panel.locator('#api-key')).toHaveValue('');
  await panel.locator('#test-connection').click();
  await expect(panel.locator('#settings-error')).toContainText('连接成功');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  expect(provider.calls.at(-1)).toMatchObject({
    model: 'gpt-4.1-mini',
    authorization: 'Bearer sidenote-test-key',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  });
  expect(await source.locator('body').innerText()).not.toContain('sidenote-test-key');

  await panel.locator('#tab-summary').click();
  await panel.locator('#prompt-open').click();
  await panel.locator('#prompt-text').fill(CUSTOM_PROMPT);
  await panel.locator('#save-prompt').click();
  await panel.locator('#summarize-btn').click();
  await expect(panel.locator('.summary-title')).toHaveText(SUMMARY.title);
  expect(
    provider.calls.some(
      (call) => call.data.userPreferences === CUSTOM_PROMPT && call.data.sourceCues?.length === 4,
    ),
  ).toBe(true);

  await panel.locator('#tab-transcript').click();
  await openSubtitleSettings();
  // 'auto' resolves to the browser's built-in Google engine, whose availability depends on the
  // machine's downloaded language packs. This block exercises AI translation, so pick it.
  await panel.locator('#engine-ai').click();
  await panel.locator('#translate-btn').click();
  await expect(panel.locator('.translation')).toHaveCount(4);
  await panel.locator('[data-cue="2"]').click();
  await expect(learning.locator('#original')).toHaveText('Check evidence before deciding.');
  // The mock echoes each cue, so pairing is what matters; the number is only a batch position.
  await expect(learning.locator('#translated')).toContainText('译文');
  await expect(learning.locator('#translated')).toContainText('Check evidence before deciding.');
  await panel.locator('#display-mode').selectOption('original');
  await expect(panel.locator('#display-mode')).toHaveValue('original');
  await expect(learning.locator('#original')).toBeVisible();
  await expect(learning.locator('#translated')).toBeHidden();
  await panel.locator('#display-mode').selectOption('translated');
  await expect(learning.locator('#original')).toBeHidden();
  await expect(learning.locator('#translated')).toBeVisible();
  await panel.locator('#display-mode').selectOption('bilingual');
  await expect(learning.locator('#original')).toBeVisible();
  await expect(learning.locator('#translated')).toBeVisible();
  await learning.locator('#captions-toggle').click();
  await expect(learning.locator('#captions-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(panel.locator('#overlay-enabled')).not.toBeChecked();
  await expect(learning.locator('#subtitles')).toBeHidden();
  await expect(embed.locator('#native-captions')).toBeHidden();
  await panel.locator('#overlay-enabled').check();
  await expect(learning.locator('#captions-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(learning.locator('#subtitles')).toBeVisible();
  await expect.poll(captionCommands).toEqual([
    { func: 'unloadModule', args: ['captions'] },
    { func: 'unloadModule', args: ['captions'] },
    { func: 'unloadModule', args: ['captions'] },
    { func: 'unloadModule', args: ['captions'] },
  ]);
  await expect(source.locator('html')).not.toHaveAttribute('data-sidenote-overlay');
  await panel.locator('#search').fill('evidence');
  await expect(panel.locator('.cue')).toHaveCount(1);
  await panel.locator('#search').fill('');

  await panel.locator('#tab-chat').click();
  await panel.locator('#question').fill('应该如何核对证据？');
  await panel.locator('#ask-btn').click();
  await expect(panel.locator('.answer')).toContainText('先核对证据，再采取行动。');
  await panel.locator('.citation').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  await expect(learning.locator('#translated')).toContainText('Check evidence before deciding.');

  await panel.locator('#export-open').click();
  const downloading = learning.waitForEvent('download');
  await panel.locator('[data-export="xmind"]').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.xmind$/);
  const xmindPath = testInfo.outputPath('export.xmind');
  await download.saveAs(xmindPath);
  const archive = unzipSync(await readFile(xmindPath));
  expect(strFromU8(archive['content.json']!)).toContain(SUMMARY.title);
  // The exported map must carry the summary substance, not just chapter labels.
  expect(strFromU8(archive['content.json']!)).toContain(SUMMARY.sections[0]!.points[0]!);
  expect(strFromU8(archive['content.json']!)).toContain(SUMMARY.takeaways[0]!);
  // PDF is generated by the extension itself now, so it downloads like the other formats.
  await panel.locator('#export-open').click();
  const pdfDownloading = learning.waitForEvent('download');
  await panel.locator('[data-export="pdf"]').click();
  const pdfDownload = await pdfDownloading;
  expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
  const pdfPath = testInfo.outputPath('export.pdf');
  await pdfDownload.saveAs(pdfPath);
  const pdfBytes = await readFile(pdfPath);
  expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  // Proves the whole path really ran: the lazy PDF chunk loaded, the bundled font was fetched,
  // and the Chinese went in as searchable CID text rather than an image or missing glyphs.
  const reopened = await PDFDocument.load(pdfBytes);
  const flattened = Buffer.from(await reopened.save({ useObjectStreams: false })).toString(
    'latin1',
  );
  expect(flattened).toContain('/ToUnicode');
  expect(flattened).toContain('/Identity-H');

  await panel.locator('#export-open').click();
  const opening = context.waitForEvent('page');
  await panel.locator('[data-export="print"]').click();
  const printPage = await opening;
  await expect(printPage.locator('#document')).toContainText(SUMMARY.title);
  await expect(printPage.locator('#document')).toContainText(CUSTOM_PROMPT);
  await expect(printPage.locator('#print-button')).toBeEnabled();
  await expect(printPage.locator('#pdf-button')).toBeEnabled();
  await printPage.close();
  await panel.locator('#tab-summary').click();
  await learning.screenshot({ path: testInfo.outputPath('learning-summary.png'), fullPage: true });
  await panel.locator('#tab-chapters').click();
  await learning.screenshot({ path: testInfo.outputPath('learning-chapters-1440.png') });
  await learning.setViewportSize({ width: 1920, height: 1080 });
  await expectDesktopTheater();
  await learning.screenshot({ path: testInfo.outputPath('learning-chapters-1920.png') });
  await learning.setViewportSize({ width: 390, height: 844 });
  await expect(learning.locator('#lesson-title')).toBeVisible();
  // A summary exists by now, so the tab shows its chapters rather than the native ones.
  await expect(panel.locator('.chapter-card')).toHaveCount(SUMMARY.sections.length);
  expect(
    await learning.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
  await learning.screenshot({
    path: testInfo.outputPath('learning-mobile-390.png'),
    fullPage: true,
  });
  await learning.setViewportSize({ width: 1440, height: 1000 });
  await panel.locator('#tab-summary').click();
  expect(browserErrors).toEqual([]);
});

// eslint-disable-next-line no-empty-pattern
test('provider and model dropdowns use fixed official endpoints and matching native protocols', async ({}, testInfo) => {
  const presets = [
    {
      id: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
      model: 'deepseek-v4-pro',
      endpoint: 'https://api.deepseek.com/chat/completions',
    },
    {
      id: 'anthropic',
      defaultModel: 'claude-haiku-4-5-20251001',
      model: 'claude-sonnet-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
    },
    {
      id: 'openai',
      defaultModel: 'gpt-4.1-mini',
      model: 'gpt-4.1-mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
    },
  ];
  for (const preset of presets) {
    await learning.locator('#settings').click();
    await expect(panel.locator('input#base-url')).toHaveCount(0);
    await expect(panel.locator('#provider option')).toHaveCount(3);
    await panel.locator('#provider').selectOption(preset.id);
    await expect(panel.locator('#test-connection')).toBeDisabled();
    await expect(panel.locator('#model')).toHaveValue(preset.defaultModel);
    await expect(panel.locator('#model option')).toHaveCount(2);
    await panel.locator('#model').selectOption(preset.model);
    await panel.locator('#api-key').fill(`fixture-${preset.id}-key`);
    await expect(panel.locator('#test-connection')).toBeDisabled();
    await panel.locator('#save-settings').click();
    await expect(panel.locator('#settings-dialog')).not.toBeVisible();
    await learning.locator('#settings').click();
    await expect(panel.locator('#provider')).toHaveValue(preset.id);
    await expect(panel.locator('#model')).toHaveValue(preset.model);
    await expect(panel.locator('#api-key')).toHaveValue('');
    await expect(panel.locator('#test-connection')).toBeEnabled();
    await learning.screenshot({
      path: testInfo.outputPath(`settings-${preset.id}.png`),
      fullPage: true,
    });
    await panel.locator('#test-connection').click();
    await expect(panel.locator('#settings-error')).toContainText('连接成功');
    const call = provider.calls.at(-1);
    expect(call).toMatchObject({ endpoint: preset.endpoint, model: preset.model });
    if (preset.id === 'anthropic') {
      expect(call).toMatchObject({
        apiKey: 'fixture-anthropic-key',
        anthropicVersion: '2023-06-01',
        anthropicBrowserAccess: 'true',
      });
      expect(call?.authorization).toBeUndefined();
      expect(call?.body).toMatchObject({
        system: expect.any(String),
        max_tokens: 6000,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: expect.any(String) }],
      });
      expect(call?.body).not.toHaveProperty('temperature');
      expect(call?.body).not.toHaveProperty('response_format');
    } else {
      expect(call?.authorization).toBe(`Bearer fixture-${preset.id}-key`);
      expect(call?.apiKey).toBeUndefined();
      expect(call?.body).toMatchObject({
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: expect.any(String) },
        ],
      });
      expect(call?.body).toMatchObject(
        preset.id === 'openai'
          ? { max_completion_tokens: 6000, store: false }
          : { max_tokens: 6000, thinking: { type: 'disabled' } },
      );
    }
    await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  }
  expect(browserErrors).toEqual([]);
});

test('a delayed connection test cannot repeat or label a newly selected provider as connected', async () => {
  await learning.locator('#settings').click();
  await expect(panel.locator('#provider')).toHaveValue('openai');
  provider.setMode('hold');
  const beforeCalls = provider.calls.length;
  await panel.locator('#test-connection').click();
  await expect.poll(() => provider.held.size).toBe(1);
  await panel.locator('#provider').selectOption('deepseek');
  await panel.locator('#provider').selectOption('openai');
  await expect(panel.locator('#test-connection')).toBeDisabled();
  // Native .click() on the disabled control must not dispatch a duplicate request.
  await panel.locator('#test-connection').evaluate((button: HTMLButtonElement) => button.click());
  await panel.locator('#provider').selectOption('deepseek');
  provider.releaseHeld();
  await expect.poll(() => provider.held.size).toBe(0);
  await expect(panel.locator('#test-connection')).toHaveText('保存后测试此模型');
  await expect(panel.locator('#test-connection')).toBeDisabled();
  await expect(panel.locator('#settings-error')).toBeHidden();
  expect(provider.calls).toHaveLength(beforeCalls + 1);
  provider.setMode('normal');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await learning.locator('#settings').click();
  await expect(panel.locator('#provider')).toHaveValue('openai');
  await expect(panel.locator('#test-connection')).toBeEnabled();
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  expect(browserErrors).toEqual([]);
});

test('API errors and cancellation recover; imported captions remain honest; closing learning leaves the source page intact', async () => {
  await panel.locator('#tab-chat').click();
  provider.setMode('unauthorized');
  await panel.locator('#question').fill('错误恢复测试：这段视频的证据是什么？');
  await panel.locator('#ask-btn').click();
  await expect(panel.locator('#notice')).toContainText('AI 服务拒绝访问');
  await expect(panel.locator('#ask-btn')).toBeEnabled();
  provider.setMode('normal');
  await panel.locator('#ask-btn').click();
  await expect(panel.locator('.answer')).toHaveCount(2);
  provider.setMode('hold');
  await panel.locator('#question').fill('取消测试：请提供更多解释。');
  await panel.locator('#ask-btn').click();
  await expect.poll(() => provider.held.size).toBe(1);
  await expect(learning.locator('#settings')).toBeDisabled();
  await expect(panel.locator('#settings-open')).toBeDisabled();
  await learning.locator('#settings').evaluate((button: HTMLButtonElement) => button.click());
  // Exercise the parent message route too, rather than relying only on its button state.
  await learning.evaluate(() => {
    document
      .querySelector<HTMLIFrameElement>('#study-panel')
      ?.contentWindow?.postMessage(
        { type: 'sidenote:learning-action', action: 'settings' },
        location.origin,
      );
  });
  await expect(panel.locator('#settings-dialog')).not.toBeVisible();
  expect(provider.held.size).toBe(1);
  await panel.locator('#cancel-job').click();
  await expect(panel.locator('#job-status')).not.toBeVisible();
  await expect(panel.locator('#ask-btn')).toBeEnabled();
  await expect.poll(() => provider.held.size).toBe(0);
  await expect(learning.locator('#settings')).toBeEnabled();
  provider.setMode('normal');
  await panel.locator('#tab-transcript').click();
  await panel.locator('#subtitle-file').setInputFiles({
    name: 'lesson.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from(IMPORTED_SRT),
  });
  await expect(panel.locator('#source-state')).toHaveText('已导入字幕');
  await expect(panel.locator('.cue')).toHaveCount(2);
  await expect(panel.locator('#notice')).toContainText('字幕覆盖范围未验证');
  await expect(panel.locator('#export-open')).toBeDisabled();
  await panel.locator('#tab-summary').click();
  await panel.locator('#summarize-btn').click();
  await expect(panel.locator('.result-badge')).toHaveText('当前字幕范围总结');
  await learning.close();
  await expect(source.locator('iframe')).toHaveCount(0);
  await expect(source.locator('html')).not.toHaveAttribute('data-sidenote-open');
  await expect(source.getByRole('button', { name: '打开旁听学习页面' })).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test('source SPA changes cannot replace the learning video; closing the learning tab cancels its active API task', async () => {
  await openLearning();
  await expect(panel.locator('#source-state')).toHaveText('已读取原生字幕');
  await expect(panel.locator('.cue')).toHaveCount(4);
  provider.setMode('hold');
  await panel.locator('#tab-chat').click();
  await panel.locator('#question').fill('独立学习保留测试：请解释当前视频。');
  await panel.locator('#ask-btn').click();
  await expect.poll(() => provider.held.size).toBe(1);
  const originalLauncher = await source.locator('#sidenote-launcher').elementHandle();
  if (!originalLauncher) throw new Error('Source launcher is missing');
  await source.locator('ytd-watch-metadata #actions').evaluate((actions, markup) => {
    const replacement = document.createElement('template');
    replacement.innerHTML = markup;
    actions.replaceWith(replacement.content);
  }, actionBarFixture(true));
  await expect(
    source.locator('#sidenote-launcher + ytd-segmented-like-dislike-button-renderer'),
  ).toHaveCount(1);
  await expect(source.locator('#sidenote-launcher')).toHaveCount(1);
  expect(await originalLauncher.evaluate((launcher) => launcher.isConnected)).toBe(true);
  await expect(panel.locator('#question')).toHaveValue('独立学习保留测试：请解释当前视频。');
  expect(provider.held.size).toBe(1);

  await source.evaluate(() => {
    const fixtureWindow = window as Window & {
      ytInitialPlayerResponse?: {
        videoDetails: { videoId: string; title: string };
        captions: { playerCaptionsTracklistRenderer: { captionTracks: { baseUrl: string }[] } };
      };
      __metadataReadAfterNavigation?: boolean;
    };
    document.dispatchEvent(new Event('yt-navigate-start'));
    history.pushState(null, '', '/watch?v=TESTVIDEO02');
    const response = fixtureWindow.ytInitialPlayerResponse;
    if (!response) throw new Error('Fixture player response is missing');
    response.videoDetails.videoId = 'TESTVIDEO02';
    response.videoDetails.title = '新视频：源页已切换';
    const player = document.querySelector('#movie_player') as HTMLElement & {
      getPlayerResponse: () => unknown;
    };
    const previousRead = player.getPlayerResponse;
    player.getPlayerResponse = () => {
      fixtureWindow.__metadataReadAfterNavigation = true;
      return previousRead();
    };
    for (const track of response.captions.playerCaptionsTracklistRenderer.captionTracks) {
      const url = new URL(track.baseUrl);
      url.searchParams.set('v', 'TESTVIDEO02');
      track.baseUrl = url.href;
    }
    document.dispatchEvent(new Event('yt-navigate-finish'));
  });
  await expect(source).toHaveURL(/TESTVIDEO02/);
  await expect
    .poll(() =>
      source.evaluate(
        () =>
          (window as Window & { __metadataReadAfterNavigation?: boolean })
            .__metadataReadAfterNavigation,
      ),
    )
    .toBe(true);
  await expect(panel.locator('#video-title')).toHaveText(VIDEO_TITLE);
  await expect(learning.locator('#lesson-title')).toHaveText(VIDEO_TITLE);
  expect(provider.held.size).toBe(1);
  await panel.locator('#cancel-job').click();
  await expect.poll(() => provider.held.size).toBe(0);
  await panel.locator('#tab-transcript').click();
  await openSubtitleSettings();
  await panel.locator('#reload-transcript').click();
  await expect(panel.locator('.cue')).toHaveCount(4);
  await panel.locator('[data-cue="2"]').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  expect(
    await source.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime),
  ).toBe(7);
  await panel.locator('#tab-chat').click();
  await panel.locator('#question').fill('关闭独立学习页取消测试。');
  await panel.locator('#ask-btn').click();
  await expect.poll(() => provider.held.size).toBe(1);
  await learning.close();
  await expect.poll(() => provider.held.size).toBe(0);
  provider.setMode('normal');
  expect(browserErrors).toEqual([]);
});

test('empty timedtext and delayed tracks recover through the native modern transcript panel', async () => {
  source = await context.newPage();
  await source.goto('https://www.youtube.com/watch?v=' + FALLBACK_ID);
  await openLearning(FALLBACK_TITLE);
  await expect(panel.locator('#source-state')).toHaveText('已读取原生字幕');
  await expect(panel.locator('.cue')).toHaveCount(4);
  await panel.locator('#tab-chapters').click();
  await expect(panel.locator('.chapter-card')).toHaveCount(0);
  await expect(panel.locator('#chapter-empty')).toBeVisible();
  await panel.locator('#tab-transcript').click();
  await expect(source.locator('#native-transcript')).toHaveAttribute(
    'visibility',
    'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED',
  );
  await expect(panel.locator('[data-cue="3"]')).toContainText('学以致用');
  // The first read can recover before tracks arrive. A second read exercises HTTP 200 + empty body.
  await expect
    .poll(() =>
      source.evaluate(() => {
        const response = (window as Window & { ytInitialPlayerResponse?: { captions?: unknown } })
          .ytInitialPlayerResponse;
        return Boolean(response?.captions);
      }),
    )
    .toBe(true);
  await openSubtitleSettings();
  await panel.locator('#reload-transcript').click();
  await expect
    .poll(() => captionRequests.some((url) => new URL(url).searchParams.get('v') === FALLBACK_ID))
    .toBe(true);
  await expect(panel.locator('.cue')).toHaveCount(4);
  await panel.locator('[data-cue="2"]').click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  expect(
    await source.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime),
  ).toBe(0);
  await panel.locator('#tab-summary').click();
  await panel.locator('#summarize-btn').click();
  await expect(panel.locator('.result-badge')).toHaveText('当前字幕范围总结');
  await panel.locator('#tab-chapters').click();
  await expect(panel.locator('.chapter-card')).toHaveCount(SUMMARY.sections.length);
  await expect(panel.locator('#chapter-source')).toContainText('AI 总结章节');
  await panel.locator('.chapter-card').first().click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(0, 0);
  await panel.locator('.chapter-card').nth(1).click();
  await expect
    .poll(() => embed.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime))
    .toBeCloseTo(20, 0);
  await expect(panel.locator('.chapter-card').nth(1)).toHaveAttribute('aria-current', 'true');
  expect(browserErrors).toEqual([]);
});

// Self-contained on purpose: it opens its own learning page, clears the key and resets the engine
// rather than inheriting any of that from a neighbour.
test('choosing AI without a configured key opens settings and sends nothing', async () => {
  // Opens its own learning page: the setup this used to inherit lives in a skipped test above.
  await learning.close();
  source = await context.newPage();
  await source.goto(VIDEO_URL);
  await openLearning();
  await expect(panel.locator('.cue')).toHaveCount(4);

  // The panel's own header is hidden inside the learning page; its toolbar owns the entry.
  await learning.locator('#settings').click();
  await panel.locator('#clear-key').click();
  await expect(panel.locator('#key-status')).toContainText('密钥已清除');
  await panel.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(panel.locator('#settings-dialog')).not.toBeVisible();

  await openSubtitleSettings();
  // The engine preference persists across tests, and switching to the engine already selected is
  // a no-op, so start from Google explicitly rather than assuming where a neighbour left it.
  await panel.locator('#engine-google').click();
  await expect(panel.locator('#engine-google')).toHaveAttribute('aria-selected', 'true');
  const beforeCalls = provider.calls.length;
  // Settings open immediately and the engine stays on Google, so nothing is ever sent to a
  // provider that cannot answer.
  await panel.locator('#engine-ai').click();
  await expect(panel.locator('#settings-dialog')).toBeVisible();
  await expect(panel.locator('#notice')).toContainText('Key');
  await expect(panel.locator('#engine-google')).toHaveAttribute('aria-selected', 'true');
  expect(provider.calls).toHaveLength(beforeCalls);
  expect(browserErrors).toEqual([]);
});
