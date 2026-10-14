#!/usr/bin/env node
import { runCloudLiteMachine } from '../src/cloud-lite/runtime.mjs';
const bootstrap = JSON.parse(Buffer.from(process.env.FACTORY_CLOUD_BOOTSTRAP_B64, 'base64').toString('utf8'));
await runCloudLiteMachine({ ...bootstrap, index: Number(process.env.FACTORY_MACHINE_INDEX) });
