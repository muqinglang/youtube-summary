import { build, type BuildOptions } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
// Only the generated dist directory is replaced. Never accept arbitrary output paths.
if (dirname(output) !== root || basename(output) !== 'dist') throw new Error('Invalid build path');
/**
 * Chrome holds files in dist while a development copy is loaded there, so replacing it can fail
 * partway and leave old and new files side by side — which loads as an extension whose page and
 * script came from different builds, and dies on the first missing element. Retrying usually wins;
 * saying so plainly is what matters when it does not.
 */
async function replaceOutput(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(output, { recursive: true, force: true });
      await mkdir(output, { recursive: true });
      await cp(join(root, 'extension'), output, { recursive: true });
      return;
    } catch (error) {
      if (attempt >= 2)
        throw new Error(
          `无法重建 dist（${String(error)}）。dist 里现在可能同时有新旧文件，加载后面板会因缺少元素而失效。` +
            '请先在 chrome://extensions 移除已加载的开发版，再重新构建。',
        );
      await new Promise((done) => setTimeout(done, 400));
    }
  }
}
await replaceOutput();
const shared = {
  absWorkingDir: root,
  outdir: output,
  bundle: true,
  target: ['chrome130'],
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
} satisfies BuildOptions;

// Content scripts cannot be modules, so everything that is not code-split stays an IIFE.
await build({
  ...shared,
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    page: 'src/content/page.ts',
    learn: 'src/ui/learn.ts',
    export: 'src/ui/export.ts',
  },
  format: 'iife',
});

// The panel is a module so the PDF generator, which is larger than the whole panel, loads only
// when someone actually exports a PDF instead of on every video.
await build({
  ...shared,
  entryPoints: { panel: 'src/ui/panel.ts' },
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
});

const files: Record<string, Uint8Array> = {};
async function collect(directory: string, prefix = ''): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(directory, entry.name), name + '/');
    else files[name] = await readFile(join(directory, entry.name));
  }
}
await collect(output);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
// The store reads the manifest's version; the package is named from package.json's. Nothing
// else keeps the two in step, and drift ships a zip whose name and contents disagree.
const manifestVersion = (
  JSON.parse(new TextDecoder().decode(files['manifest.json'])) as { version?: string }
).version;
if (manifestVersion !== version)
  throw new Error(
    `manifest.json 是 ${manifestVersion}，package.json 是 ${version}：两处版本号必须一致。`,
  );
await mkdir(join(root, 'release'), { recursive: true });
const archive = join(root, 'release', `sidenote-${version}.zip`);
await writeFile(archive, zipSync(files));
// The store assigns its own id, so the package uploaded there must not pin one with `key`. The
// unpacked build keeps it: the OAuth redirect URI is registered against that pinned id.
const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Record<
  string,
  unknown
>;
delete manifest.key;
const storeArchive = join(root, 'release', `sidenote-${version}-store.zip`);
await writeFile(
  storeArchive,
  zipSync({
    ...files,
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  }),
);
console.log(`Extension: ${output}\nPackage: ${archive}\nStore package: ${storeArchive}`);
