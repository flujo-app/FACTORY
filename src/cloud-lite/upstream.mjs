import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Use the installed flujo-cloud implementation, rather than copy its provider code. */
export async function loadFlujoCloudInfrastructure({ directory, binary, env, proxyEnv = env, cwd } = {}) {
  if (!isAbsolute(directory ?? '')) throw new TypeError('Select the absolute installed flujo-cloud directory.');
  const module = name => import(pathToFileURL(join(directory, 'lib', name)).href);
  const [{ createFlyRunner, unusedLoopbackPort }, { createMachine }, { buildMachineConfig }, { resolveWorkerImage }] = await Promise.all([
    module('process.mjs'), module('machines.mjs'), module('bridge.mjs'), module('images.mjs'),
  ]);
  if ([createFlyRunner, createMachine, buildMachineConfig, resolveWorkerImage].some(value => typeof value !== 'function')) {
    throw new Error('Installed flujo-cloud does not expose the required infrastructure functions.');
  }
  const fly = createFlyRunner({ binary, env, cwd });
  const proxyFly = proxyEnv === env ? fly : createFlyRunner({ binary, env: proxyEnv, cwd });
  return {
    run: (args, options) => fly.run(args, options),
    proxy: options => proxyFly.proxy(options),
    unusedLoopbackPort,
    createMachine: input => createMachine({ ...input, run: args => fly.run(args), env }),
    buildMachineConfig,
    resolveWorkerImage,
  };
}
