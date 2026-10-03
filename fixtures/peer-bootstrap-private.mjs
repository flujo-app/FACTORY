import { pathToFileURL } from 'node:url';
import path from 'node:path';
const native = await import(pathToFileURL(process.env.PEER_PRIVATE_TEST_MODULE).href);
export const readPrivateJson = native.readPrivateJson;
export const ensurePrivateDirectory = native.ensurePrivateDirectory;
export const assertPrivateDirectory = native.assertPrivateDirectory;
export async function writePrivateJson(filename, value, options) {
  await native.writePrivateJson(filename, value, options);
  if (path.basename(filename) === 'config-a.private.json') process.exit(92);
}
