#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startCloudBoardMcp } from '../src/cloud-lite/mcp.mjs';
// `--config <file>` carries the address and credential for hosts that keep server settings in clear view.
const flag = process.argv.indexOf('--config');
await startCloudBoardMcp(flag === -1 ? {} : JSON.parse(readFileSync(process.argv[flag + 1], 'utf8')));
