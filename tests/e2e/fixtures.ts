import { existsSync, readdirSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import type { Summary } from '../../src/shared/types';

export const VIDEO_ID = 'TESTVIDEO01';
export const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
export const VIDEO_TITLE = 'Learning clearly — 集成测试视频';
export const CHAPTERS = [
  { title: '提出问题', start: 0 },
  { title: '核对证据', start: 20 },
  { title: '采取行动', start: 35 },
];
export const CUSTOM_PROMPT = '请保留所有章节，用简体中文整理可执行建议。E2E 自定义提示词。';
export const SUMMARY: Summary = {
  title: '清晰学习：视频笔记',
  overview: '从问题出发，整理证据，再采取行动。',
  sections: [
    { title: '提出问题', start: 0, points: ['先说明学习问题。'] },
    { title: '核对证据', start: 20, points: ['保留案例和依据。'] },
  ],
  takeaways: ['把下一步写成行动清单。'],
  mindmap: {
    title: '清晰学习',
    children: [
      { title: '提出问题', start: 0, children: [{ title: '明确目标' }] },
      { title: '核对证据', start: 20, children: [{ title: '记录案例' }] },
    ],
  },
};
export const CAPTIONS = {
  events: [
    { tStartMs: 0, dDurationMs: 10_000, segs: [{ utf8: 'Start with a clear question.' }] },
    { tStartMs: 10_000, dDurationMs: 10_000, segs: [{ utf8: 'Keep important examples.' }] },
    { tStartMs: 20_000, dDurationMs: 15_000, segs: [{ utf8: 'Check evidence before deciding.' }] },
    {
      tStartMs: 35_000,
      dDurationMs: 10_000,
      segs: [{ utf8: 'Take one useful action. 学以致用。' }],
    },
  ],
};
export const IMPORTED_SRT =
  '1\n00:00:00,000 --> 00:00:10,000\nImported introduction.\n\n2\n00:00:20,000 --> 00:00:30,000\nImported evidence.\n';

/** PCM audio gives a real, seekable HTMLVideoElement without generated browser mocks. */
export function silentMedia(): Buffer {
  const samples = 8_000 * 45;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

export function actionBarFixture(legacy = false): string {
  const likeGroup = legacy
    ? 'ytd-segmented-like-dislike-button-renderer'
    : 'segmented-like-dislike-button-view-model';
  return `<div id="actions"><div id="top-level-buttons-computed"><${likeGroup}><button aria-label="赞">👍 128</button><button aria-label="不喜欢">👎</button></${likeGroup}><button aria-label="分享">分享 ↗</button><button aria-label="更多操作">···</button></div></div>`;
}

export function youtubeFixture(
  options: {
    videoId?: string;
    title?: string;
    nativeTranscript?: boolean;
    lateTracks?: boolean;
    chapters?: boolean;
  } = {},
): string {
  const videoId = options.videoId ?? VIDEO_ID;
  const title = options.title ?? VIDEO_TITLE;
  const response = {
    videoDetails: {
      videoId,
      title,
      author: 'Sidenote Test Channel',
      lengthSeconds: '45',
      shortDescription:
        options.chapters === false
          ? '学习清晰表达与思考。'
          : '学习清晰表达与思考。\n\n0:00 提出问题\n0:20 核对证据\n0:35 采取行动',
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            vssId: '.en',
            languageCode: 'en',
            name: { simpleText: 'English' },
            baseUrl: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&signature=fixture`,
          },
        ],
      },
    },
  };
  const nativeRows = CAPTIONS.events
    .map(
      (event) =>
        `<transcript-segment-view-model style="display:block;padding:8px"><span class="ytwTranscriptSegmentViewModelTimestamp">0:${String(event.tStartMs / 1000).padStart(2, '0')}</span><span role="text">${event.segs[0]!.utf8}</span></transcript-segment-view-model>`,
    )
    .join('');
  const nativeButton = options.nativeTranscript
    ? '<ytd-video-description-transcript-section-renderer style="display:block"><button id="show-transcript">显示转录文字</button></ytd-video-description-transcript-section-renderer>'
    : '';
  const nativePanel = options.nativeTranscript
    ? `<ytd-engagement-panel-section-list-renderer id="native-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" hidden style="display:block">${nativeRows}</ytd-engagement-panel-section-list-renderer>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} - YouTube</title>
    <style>body{margin:0;background:#101010;color:white;font:16px system-ui}ytd-app{display:block;padding:50px;box-sizing:border-box}#movie_player{position:relative;background:#252525;width:100%;height:480px}video{width:100%;height:100%}h1{font-size:24px;margin:22px 0 18px}#secondary{padding:20px}ytd-watch-metadata{display:block}.metadata-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.channel{font-size:14px}.channel small{display:block;color:#aaa;margin-top:5px}#actions,#top-level-buttons-computed{display:flex;align-items:center;gap:8px}#actions button{height:36px;border:0;border-radius:18px;padding:0 16px;background:#292929;color:white;font:14px system-ui;white-space:nowrap}segmented-like-dislike-button-view-model,ytd-segmented-like-dislike-button-renderer{display:inline-flex;align-items:center;background:#292929;border-radius:18px}#actions [aria-label="不喜欢"]{border-left:1px solid #555;border-radius:0 18px 18px 0}</style>
    </head><body><ytd-app><ytd-watch-flexy><div id="movie_player"><video class="html5-main-video" controls preload="auto" src="/fixture.wav"></video><div class="ytp-caption-window-container">Native captions</div></div><ytd-watch-metadata><h1>${title}</h1><div class="metadata-row"><div class="channel">Sidenote Test Channel<small>学习清晰表达与思考</small></div>${actionBarFixture()}</div>${nativeButton}</ytd-watch-metadata>${nativePanel}<div id="secondary">Related videos</div></ytd-watch-flexy></ytd-app>
    <script>window.ytInitialPlayerResponse=${JSON.stringify(response)};document.querySelector('#movie_player').getPlayerResponse=()=>window.ytInitialPlayerResponse;
    ${options.lateTracks ? 'const delayedTracks=window.ytInitialPlayerResponse.captions;delete window.ytInitialPlayerResponse.captions;setTimeout(()=>{window.ytInitialPlayerResponse.captions=delayedTracks;},1500);' : ''}
    document.querySelector('#show-transcript')?.addEventListener('click',()=>{const panel=document.querySelector('#native-transcript');panel.hidden=false;panel.setAttribute('visibility','ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');});
    </script></body></html>`;
}

/** A real media element implementing the embedded player's documented postMessage exchange. */
export function youtubeEmbedFixture(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:#151515}video{width:100%;height:100%;object-fit:contain}#native-captions{position:absolute;bottom:50px;left:25%;color:white;background:#000b;padding:4px}</style></head><body><video controls preload="auto" src="/fixture.wav"></video><div id="native-captions">Native captions should disappear</div><script>
    const video=document.querySelector('video');
    const captions=document.querySelector('#native-captions');
    window.__playerCommands=[];
    const parentOrigin=new URL(location.href).searchParams.get('origin');
    let connected=false;
    function send(event,info){if(connected&&parentOrigin)parent.postMessage(JSON.stringify({event,info}),parentOrigin);}
    function report(){if(video.readyState)send('infoDelivery',{currentTime:video.currentTime,duration:video.duration,playerState:video.ended?0:video.paused?2:1,videoData:{video_id:location.pathname.split('/').pop()}});}
    video.addEventListener('loadedmetadata',()=>{video.currentTime=Math.min(Number(new URL(location.href).searchParams.get('start'))||0,video.duration);report();});
    for(const name of ['timeupdate','seeked','play','pause','ratechange','durationchange'])video.addEventListener(name,report);
    window.addEventListener('message',async(event)=>{
      if(event.source!==parent||event.origin!==parentOrigin)return;
      let data;try{data=typeof event.data==='string'?JSON.parse(event.data):event.data;}catch{return;}
      if(data.event==='listening'){connected=true;video.dataset.connected='true';send('onReady');send('initialDelivery',{apiInterface:['playVideo','pauseVideo','seekTo','setPlaybackRate','loadModule','unloadModule'],videoData:{video_id:location.pathname.split('/').pop()}});report();return;}
      if(data.event!=='command')return;
      window.__playerCommands.push({func:data.func,args:data.args});
      if(data.func==='seekTo')video.currentTime=Math.max(0,Math.min(Number(data.args[0]),video.duration||45));
      else if(data.func==='playVideo'){try{await video.play();}catch{send('onAutoplayBlocked');}}
      else if(data.func==='pauseVideo')video.pause();
      else if(data.func==='setPlaybackRate')video.playbackRate=Number(data.args[0]);
      else if(data.func==='unloadModule'&&data.args[0]==='captions'){captions.hidden=true;send('onApiChange');}
      else if(data.func==='loadModule'&&data.args[0]==='captions'){captions.hidden=false;send('onApiChange');}
      report();
    });
    setInterval(report,200);
  </script></body></html>`;
}

interface SourceCue {
  id: string;
  start: number;
  text: string;
}
interface ProviderData {
  sourceCues?: SourceCue[];
  userPreferences?: string;
  question?: string;
  language?: string;
}
export interface ProviderCall {
  system: string;
  data: ProviderData;
  model: string;
  authorization?: string;
  endpoint: string;
  apiKey?: string;
  anthropicVersion?: string;
  anthropicBrowserAccess?: string;
  body: Record<string, unknown>;
}

/** Test-copy transport only. It survives worker restarts and prevents paid API calls. */
export function providerTransportScript(origin: string): string {
  const install = (fixtureOrigin: string) => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const endpoints = new Set([
      'https://api.openai.com/v1/chat/completions',
      'https://api.deepseek.com/chat/completions',
      'https://api.anthropic.com/v1/messages',
    ]);
    const hosts = new Set(['api.openai.com', 'api.deepseek.com', 'api.anthropic.com']);
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!hosts.has(url.hostname)) {
        if (/^https?:$/.test(url.protocol) && url.origin !== fixtureOrigin)
          throw new Error('External worker networking is disabled in the E2E transport fixture');
        return nativeFetch(input, options);
      }
      if (!endpoints.has(url.href) || input instanceof Request)
        throw new Error('Unexpected provider request in the E2E transport fixture');
      const headers = new Headers(options?.headers);
      headers.set('x-sidenote-fixture-endpoint', url.href);
      return nativeFetch(fixtureOrigin + url.pathname, { ...options, headers });
    };
  };
  return `;(${install.toString()})(${JSON.stringify(origin)});\n`;
}

/** A local HTTP API exercises the actual service worker fetch, validation and cancellation. */
export async function startProvider() {
  const calls: ProviderCall[] = [];
  const held = new Map<ServerResponse, () => void>();
  let mode: 'normal' | 'unauthorized' | 'hold' = 'normal';
  const server = createServer((request, response) => {
    if (
      !['/v1/chat/completions', '/chat/completions', '/v1/messages'].includes(request.url ?? '') ||
      request.method !== 'POST'
    ) {
      response.writeHead(404).end();
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      raw += chunk;
    });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as {
          model: string;
          system?: string;
          messages: { role: string; content: string }[];
        };
        const anthropic = request.url === '/v1/messages';
        const system =
          body.system || body.messages.find((message) => message.role === 'system')?.content || '';
        const data = JSON.parse(
          body.messages.find((message) => message.role === 'user')?.content || '{}',
        ) as ProviderData;
        calls.push({
          system,
          data,
          model: body.model,
          authorization: request.headers.authorization,
          endpoint: String(request.headers['x-sidenote-fixture-endpoint'] ?? ''),
          apiKey: request.headers['x-api-key'] as string | undefined,
          anthropicVersion: request.headers['anthropic-version'] as string | undefined,
          anthropicBrowserAccess: request.headers['anthropic-dangerous-direct-browser-access'] as
            string | undefined,
          body,
        });
        if (mode === 'unauthorized') {
          response.writeHead(401).end('{"error":"test rejection"}');
          return;
        }
        const content = system.includes('connection test')
          ? { ok: true }
          : system.includes('Translate each source cue')
            ? {
                translations: data.sourceCues?.map((cue, index) => ({
                  id: cue.id,
                  text: `译文 ${index + 1}：${cue.text}`,
                })),
              }
            : system.includes('Answer the user question')
              ? { text: '先核对证据，再采取行动。', citations: [{ start: 20, label: '核对证据' }] }
              : SUMMARY;
        const send = () =>
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify(
              anthropic
                ? {
                    content: [{ type: 'text', text: JSON.stringify(content) }],
                    stop_reason: 'end_turn',
                  }
                : {
                    choices: [
                      {
                        finish_reason: 'stop',
                        message: { role: 'assistant', content: JSON.stringify(content) },
                      },
                    ],
                  },
            ),
          );
        if (mode === 'hold') {
          held.set(response, send);
          response.on('close', () => held.delete(response));
        } else send();
      } catch {
        response.writeHead(400).end('Invalid test request');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test provider failed to start');
  return {
    calls,
    held,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    origin: `http://127.0.0.1:${address.port}`,
    setMode(next: typeof mode) {
      mode = next;
    },
    releaseHeld() {
      for (const send of held.values()) send();
    },
    async close() {
      for (const response of held.keys()) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function browserExecutable(): string {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (configured && existsSync(configured)) return configured;
  const expected = chromium.executablePath();
  if (existsSync(expected)) return expected;
  const cache = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'ms-playwright')
    : join(
        homedir(),
        process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright',
      );
  if (existsSync(cache)) {
    for (const directory of readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort()
      .reverse()) {
      for (const binary of [
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const candidate = join(cache, directory, binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(
    'No local Chromium binary. Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.',
  );
}
