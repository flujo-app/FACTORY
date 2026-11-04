import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FOLDERS = ['src', 'bin', 'scripts', 'selfhost'];
const FILES = ['package.json', 'README.md', 'PUBLIC_SDK.md', 'WORKFLOWS.md', 'LICENSE'];

function tarHeader(name, size, mode) {
  const header = Buffer.alloc(512);
  let path = name, prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.indexOf('/', Buffer.byteLength(path) - 101);
    if (cut === -1 || cut > 155) throw new Error(`Path is too long for the SDK bundle: ${name}`);
    prefix = path.slice(0, cut); path = path.slice(cut + 1);
  }
  const put = (text, offset, length) => header.write(text, offset, length, 'utf8');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(path, 0, 100); put(octal(mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12); put(octal(0, 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2); put(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

function listFiles(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (['node_modules', '.git', '__pycache__'].includes(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/**
 * Writes this installed package as the SDK tarball a fleet's bootstrap unpacks, so an app can deploy
 * workers from its own dependency, with no copy of the release file and no `npm` or `tar` on the host.
 * The same files give the same bytes, so a fleet can check it is resuming with the same bundle.
 */
export function packFactorySdk(destination, { root = PACKAGE_ROOT } = {}) {
  if (typeof destination !== 'string' || !destination) throw new TypeError('Select where to write the SDK bundle.');
  const files = [...FILES.map(name => join(root, name)).filter(path => statSync(path, { throwIfNoEntry: false })?.isFile()),
    ...FOLDERS.map(name => join(root, name)).filter(path => statSync(path, { throwIfNoEntry: false })?.isDirectory()).flatMap(listFiles)]
    .map(path => ({ path, name: relative(root, path).split(/[\\/]/).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const parts = [];
  for (const { path, name } of files) {
    const bytes = readFileSync(path);
    parts.push(tarHeader(`package/${name}`, bytes.length, name.startsWith('bin/') ? 0o755 : 0o644), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, gzipSync(Buffer.concat(parts), { level: 9 }), { mode: 0o600 });
  return { file: destination, files: files.length };
}
