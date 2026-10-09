#!/usr/bin/env node
import { Factory } from '../src/public-sdk.mjs';
import { readFileSync } from 'node:fs';

const [command, database, ...rest] = process.argv.slice(2);
const usage = 'Usage: factory <create|agent|task|claim|status|pause|resume|template-list|template-read|template-create|template-update|template-delete|template-build> <database-path> [JSON | @file | -]\n';
if (!command || command === '--help' || command === 'help') {
  process.stdout.write(usage);
  process.exit(0);
}
try {
  if (!database || !['create','agent','task','claim','status','pause','resume','template-list','template-read','template-create','template-update','template-delete','template-build'].includes(command)) throw new Error(usage.trim());
  const mutating = ['create','agent','task','claim','template-read','template-create','template-update','template-delete','template-build'].includes(command);
  if (mutating !== (rest.length === 1)) throw new Error(mutating ? 'Exactly one JSON argument is required.' : 'Unexpected arguments.');
  const source = mutating ? rest[0] === '-' ? readFileSync(0, 'utf8')
    : rest[0].startsWith('@') ? readFileSync(rest[0].slice(1), 'utf8') : rest[0] : undefined;
  if (source && source.length > 1024 * 1024) throw new Error('Input exceeds 1 MiB.');
  const input = mutating ? JSON.parse(source) : undefined;
  const factory = new Factory(database);
  const result = ({ create: () => factory.createSwarm(input), agent: () => factory.addAgent(input),
    task: () => factory.addTask(input), claim: () => factory.claimTask(input),
    'template-list': () => factory.listTemplates(),
    'template-read': () => factory.getTemplate(input.name),
    'template-create': () => factory.createTemplate(input),
    'template-update': () => { const {name,...options}=input; return factory.updateTemplate(name,options); },
    'template-delete': () => { const {name,...options}=input; return factory.deleteTemplate(name,options); },
    'template-build': () => { const {name='generic',...options}=input; return factory.buildTemplate(name,options); },
    status: () => factory.status(), pause: () => factory.pause(), resume: () => factory.resume() })[command]();
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ code: error.code ?? 'FACTORY_ERROR', message: error.message }) + '\n');
  process.exitCode = 1;
}
