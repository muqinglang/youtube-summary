import { build, type BuildOptions } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
// Only the generated dist directory is replaced. Never accept arbitrary output paths.
if (dirname(output) !== root || basename(output) !== 'dist') throw new Error('Invalid build path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, 'extension'), output, { recursive: true });
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
