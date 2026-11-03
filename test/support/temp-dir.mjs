import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Every test file runs in its own process, so that process owns its temporary
// folders and removes them when it exits, whichever way its tests ended.
const owned = new Set();
process.once('exit', () => {
  // Windows can hold a file briefly after a child process or database closes.
  for (const directory of owned) {
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* The temp guard reports leftovers. */ }
  }
});

/** A new temporary folder named `<prefix>XXXXXX`, removed when this test process exits. */
export function tempDir(prefix) {
  const parent = resolve(process.env.FACTORY_TEST_TMP ?? tmpdir());
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, prefix));
  owned.add(directory);
  return directory;
}
