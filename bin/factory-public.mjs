#!/usr/bin/env node
import { Factory } from '../src/public-sdk.mjs';

const [command, database, ...rest] = process.argv.slice(2);
const usage = 'Usage: factory <create|agent|task|claim|status|pause|resume> <database-path> [JSON]\n';
if (!command || command === '--help' || command === 'help') {
  process.stdout.write(usage);
  process.exit(0);
}
try {
  if (!database || !['create','agent','task','claim','status','pause','resume'].includes(command)) throw new Error(usage.trim());
  const mutating = ['create','agent','task','claim'].includes(command);
  if (mutating !== (rest.length === 1)) throw new Error(mutating ? 'Exactly one JSON argument is required.' : 'Unexpected arguments.');
  const input = mutating ? JSON.parse(rest[0]) : undefined;
  const factory = new Factory(database);
  const result = ({ create: () => factory.createSwarm(input), agent: () => factory.addAgent(input),
    task: () => factory.addTask(input), claim: () => factory.claimTask(input),
    status: () => factory.status(), pause: () => factory.pause(), resume: () => factory.resume() })[command]();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'FACTORY_ERROR', message: error.message }) + '\n');
  process.exitCode = 1;
}
