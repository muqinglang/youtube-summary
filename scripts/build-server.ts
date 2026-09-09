import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist-server');
if (dirname(output) !== root || basename(output) !== 'dist-server')
  throw new Error('Invalid build path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: ['server/index.ts'],
  outfile: join(output, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  // Dependencies stay external and are installed in the image: Fastify and pg both resolve
  // things at runtime, which a bundle would break.
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});

// postgres.ts reads the schema next to itself, so it has to travel with the bundle.
await cp(join(root, 'server/store/schema.sql'), join(output, 'schema.sql'));
console.log(`Server: ${output}`);
