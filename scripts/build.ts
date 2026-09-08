import { build } from 'esbuild';
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
await build({
  absWorkingDir: root,
  entryPoints: {
    background: 'src/background/index.ts',
    content: 'src/content/index.ts',
    page: 'src/content/page.ts',
    panel: 'src/ui/panel.ts',
    learn: 'src/ui/learn.ts',
    export: 'src/ui/export.ts',
  },
  outdir: output,
  bundle: true,
  format: 'iife',
  target: ['chrome130'],
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
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
console.log(`Extension: ${output}\nPackage: ${archive}`);
