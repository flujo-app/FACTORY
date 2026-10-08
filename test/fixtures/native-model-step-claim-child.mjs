import readline from 'node:readline';
import { FactoryControl } from '../../src/control.mjs';
import { FixtureModelStepLedger } from './native-model-step-ledger.mjs';

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write('READY\n');
for await (const line of lines) {
  let control;
  try {
    const { database, lease, key } = JSON.parse(line);
    control = new FactoryControl(database);
    const result = new FixtureModelStepLedger(control).claim(lease, key);
    process.stdout.write(JSON.stringify({ result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ code: error.code ?? 'UNEXPECTED', message: error.message }) + '\n');
  } finally {
    control?.close();
  }
  break;
}
