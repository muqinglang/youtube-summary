import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Pins the extension's identity.
 *
 * Chrome derives an extension id from the public key it was signed with, and an unpacked build
 * without one gets an id derived from its path — which changes on another machine, and takes the
 * OAuth redirect URI with it. Writing `key` into the manifest fixes the id everywhere.
 *
 * The id is the first 16 bytes of SHA-256 over the DER public key, with each hex digit mapped
 * onto a-p.
 */

const MANIFEST = 'extension/manifest.json';
const PRIVATE_KEY = 'extension-key.pem';

export function extensionId(derPublicKey: Buffer): string {
  return [...createHash('sha256').update(derPublicKey).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
if (typeof manifest.key === 'string') {
  const der = Buffer.from(manifest.key, 'base64');
  console.log('manifest 里已有 key，未改动。');
  console.log(`扩展 ID    ${extensionId(der)}`);
  console.log(`重定向地址 https://${extensionId(der)}.chromiumapp.org/`);
  process.exit(0);
}
if (existsSync(PRIVATE_KEY)) {
  console.error(`${PRIVATE_KEY} 已存在但 manifest 里没有 key，请先确认要不要覆盖。`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
// Order matters only to whoever reads the file; Chrome ignores it, but `key` belongs with
// the rest of the identity rather than buried after the permissions.
const { manifest_version: version, ...rest } = manifest;
writeFileSync(
  MANIFEST,
  `${JSON.stringify({ manifest_version: version, key: der.toString('base64'), ...rest }, null, 2)}\n`,
);
writeFileSync(PRIVATE_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

const id = extensionId(der);
console.log(`扩展 ID    ${id}`);
console.log(`重定向地址 https://${id}.chromiumapp.org/`);
console.log(`\n已写入 ${MANIFEST} 的 key 字段，私钥存到 ${PRIVATE_KEY}（已在 .gitignore 中）。`);
console.log('私钥只在你以后要自己打包 .crx 并保持同一个 ID 时才需要，其余情况可以删。');
