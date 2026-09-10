import { readFileSync, writeFileSync } from 'node:fs';
import { validateBaseUrl, getOriginPattern } from '../src/shared/endpoint';

/**
 * Points the extension at your own hosted server.
 *
 * The origin lives in two places that must agree: the allow-list in src/shared/hosted.ts, which
 * decides what the extension will talk to, and optional_host_permissions in the manifest, which
 * decides what Chrome will let it talk to. Drift between them fails at runtime with an opaque
 * authorization error, so a test enforces it — and editing both by hand is exactly the step
 * people get wrong when a platform hands them a different app name than they expected.
 *
 *   npm run set-hosted-origin -- https://your-app.fly.dev
 */

const input = process.argv[2];
if (!input) {
  console.error('用法：npm run set-hosted-origin -- https://your-app.fly.dev');
  process.exit(1);
}

let origin: string;
try {
  const url = new URL(validateBaseUrl(input));
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('只要来源，不要路径或查询参数。');
  origin = url.origin;
} catch (error) {
  console.error(`地址无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const HOSTED = 'src/shared/hosted.ts';
const MANIFEST = 'extension/manifest.json';

const hosted = readFileSync(HOSTED, 'utf8');
// The first entry is DEFAULT_HOSTED_URL; the localhost entries below it are left alone.
const current = /export const HOSTED_ORIGINS = \[\s*'([^']+)'/.exec(hosted);
if (!current) {
  console.error(`没能在 ${HOSTED} 里找到 HOSTED_ORIGINS 的第一项，请手动修改。`);
  process.exit(1);
}
const previous = current[1]!;
if (previous === origin) {
  console.log(`已经是 ${origin}，无需修改。`);
  process.exit(0);
}

writeFileSync(HOSTED, hosted.replace(`'${previous}'`, `'${origin}'`));

const manifest = readFileSync(MANIFEST, 'utf8');
const from = getOriginPattern(previous);
const to = getOriginPattern(origin);
if (!manifest.includes(`"${from}"`)) {
  console.error(`${MANIFEST} 里没有 ${from}，两处已经不一致，请手动检查。`);
  process.exit(1);
}
writeFileSync(MANIFEST, manifest.replace(`"${from}"`, `"${to}"`));

console.log(`托管来源：${previous} → ${origin}`);
console.log(`  ${HOSTED}      HOSTED_ORIGINS[0]`);
console.log(`  ${MANIFEST}  ${from} → ${to}`);
console.log('\n跑一次 npm test 确认两处没有漂移，然后重新 npm run build 打包扩展。');
