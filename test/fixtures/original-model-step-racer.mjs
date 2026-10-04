import path from 'node:path';
import { FactoryControl } from '../../src/control.mjs';
import { SpendingLedger } from '../../src/spending.mjs';
import { OriginalModelStepJournal } from '../../src/original-model-step-journal.mjs';
import { makeSyntheticHost, privateFiles } from './original-model-step-fixture.mjs';

if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error('Owned synthetic state path required.');
const state = await privateFiles.readPrivateJson(process.argv[2], { maxBytes: 262144 });
if (state.format !== 'owned-original-model-step-race' || state.synthetic !== true || !path.isAbsolute(state.directory)) throw new Error('Owned synthetic state required.');
const control = new FactoryControl(path.join(state.directory, 'control.sqlite'), { clock: () => state.clockMs });
const paid = new SpendingLedger(path.join(state.directory, 'paid.sqlite'), { clock: () => state.clockMs });
try {
  const host = makeSyntheticHost(state.records), capability = host.capability(state.records[0]);
  const journal = new OriginalModelStepJournal({ control, paidAdmission: paid, bootstrap: host.bootstrap, compareReceiver: host.compareReceiver });
  const result = journal.claim(state.lease, capability);
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { control.close(); paid.close(); }
