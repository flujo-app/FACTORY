const path = require('node:path');

// Use the installed SWC transformer directly. next/jest loads application .env
// files and application setup; neither belongs in this offline fixture.
const flujoRoot = 'C:/Users/Moe/.codex/worktrees/flujo-owner-model-step-transport/FLUJO';
const factoryRoot = path.resolve(__dirname, '../..');

module.exports = {
  rootDir: factoryRoot,
  roots: [path.join(factoryRoot, 'scripts/fixtures')],
  testMatch: [path.join(factoryRoot, 'scripts/fixtures/flujo-owner-wire.fixture.ts')],
  testEnvironment: path.join(flujoRoot, 'node_modules/jest-environment-node/build/index.js'),
  setupFiles: [],
  setupFilesAfterEnv: [],
  moduleDirectories: [path.join(flujoRoot, 'node_modules')],
  moduleNameMapper: {
    '^@/(.*)$': `${flujoRoot}/src/$1`,
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(?:mjs|[jt]sx?)$': [
      path.join(flujoRoot, 'node_modules/next/dist/build/swc/jest-transformer.js'),
      { isEsmProject: false, configDir: factoryRoot },
    ],
  },
  // uuid is the real installed ESM dependency used by the streaming adapter.
  transformIgnorePatterns: ['[\\\\/]node_modules[\\\\/](?!uuid[\\\\/])'],
  cache: false,
  collectCoverage: false,
  maxWorkers: 1,
  testTimeout: 15000,
};
