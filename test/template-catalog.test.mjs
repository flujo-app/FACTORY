import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Factory } from '../src/public-sdk.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'factory-templates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'factory.sqlite');
  return () => new Factory(database);
}

test('generic template persists an override and deleting it restores the built-in definition', t => {
  const factory = fixture(t);
  assert.deepEqual(factory().listTemplates().map(row => row.name), ['generic']);
  assert.equal(factory().getTemplate().source, 'builtin');
  assert.throws(() => factory().createTemplate({ name: 'generic' }), { code: 'TEMPLATE_CONFLICT' });
  const override = factory().updateTemplate('generic', { expectedRevision: 0,
    goalContext: 'Ship an accessible account timeline', environment: { product: 'Calma' },
    limits: { concurrency: 3 } });
  assert.equal(override.revision, 1);
  assert.equal(factory().getTemplate('generic').goalContext, 'Ship an accessible account timeline');
  assert.equal(factory().getTemplate('generic').source, 'stored');
  const reset = factory().deleteTemplate('generic', { expectedRevision: 1 });
  assert.equal(reset.source, 'builtin');
  assert.equal(factory().getTemplate('generic').revision, 2);
  assert.equal(factory().getTemplate('generic').goalContext, '');
  assert.throws(() => factory().updateTemplate('generic', { expectedRevision: 0,
    goalContext: 'Stale writer' }), { code: 'TEMPLATE_STALE' });
  assert.equal(factory().updateTemplate('generic', { expectedRevision: 2,
    goalContext: 'New goal' }).revision, 3);
});

test('custom templates retain revision history across delete and recreate', t => {
  const factory = fixture(t);
  const first = factory().createTemplate({ name: 'delivery', description: 'Delivery team',
    goalContext: 'Build one usable slice', environment: { channel: 'synthetic' },
    limits: { leadTurns: 100 } });
  assert.equal(first.revision, 1);
  assert.equal(factory().getTemplate('delivery').environment.channel, 'synthetic');
  assert.throws(() => factory().createTemplate({ name: 'delivery' }), { code: 'TEMPLATE_CONFLICT' });
  assert.equal(factory().updateTemplate('delivery', { expectedRevision: 1,
    limits: { concurrency: 2 } }).revision, 2);
  assert.throws(() => factory().deleteTemplate('delivery', { expectedRevision: 1 }), { code: 'TEMPLATE_STALE' });
  assert.equal(factory().deleteTemplate('delivery', { expectedRevision: 2 }).revision, 3);
  assert.equal(factory().getTemplate('delivery'), null);
  assert.equal(factory().createTemplate({ name: 'delivery', goalContext: 'Next slice' }).revision, 4);
  assert.throws(() => factory().updateTemplate('delivery', { expectedRevision: 2,
    goalContext: 'Old process' }), { code: 'TEMPLATE_STALE' });
});

test('build resolves stored context into native team specs without runtime action', t => {
  const factory = fixture(t);
  factory().createTemplate({ name: 'research', goalContext: 'Investigate only the synthetic ledger',
    environment: { repository: 'fixture' }, limits: { concurrency: 2 } });
  const specs = factory().buildTemplate('research', { model: 'installed-model', availableServers: [], availableTools: {} });
  assert.deepEqual(specs.map(row => row.name), ['swarm_agent', 'swarm_team']);
  assert.equal(specs[1].nodes.find(node => node.key === 'agents').concurrencyLimit, 2);
  assert.match(specs[1].nodes[0].prompt, /synthetic ledger/);
  assert.throws(() => factory().buildTemplate('missing', { model: 'installed-model' }), { code: 'TEMPLATE_MISSING' });
  assert.throws(() => factory().createTemplate({ name: 'secrets', environment: { API_KEY: 'never-store' } }),
    { code: 'TEMPLATE_INVALID' });
  assert.throws(() => factory().createTemplate({ name: 'oversized', environment: { note: 'x'.repeat(1001) } }),
    { code: 'TEMPLATE_INVALID' });
  for (const field of ['description', 'goalContext', 'environment', 'limits']) {
    assert.throws(() => factory().createTemplate({ name: 'null-field', [field]: null }),
      { code: 'TEMPLATE_INVALID' });
  }
  assert.throws(() => factory().buildTemplate('research', { model: 'installed-model', limits: null }),
    { code: 'TEMPLATE_INVALID' });
});
