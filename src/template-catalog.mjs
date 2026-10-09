import { FactoryControl, FactoryError } from './control.mjs';
import { buildFactoryTeamSpecs } from './flujo-swarm/template/factory-team.mjs';

const NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELDS = ['description', 'goalContext', 'environment', 'limits'];
const DEFAULT = Object.freeze({ name: 'generic', description: 'Generic FLUJO team',
  goalContext: '', environment: {}, limits: {} });

function fail(code, message) { throw new FactoryError(code, message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype; }
function nameOf(value) {
  if (typeof value !== 'string' || !NAME.test(value)) fail('TEMPLATE_INVALID', 'Invalid template name.');
  return value;
}
function text(value, max, label) {
  if (typeof value !== 'string' || value.length > max) fail('TEMPLATE_INVALID', `${label} must be a bounded string.`);
  return value;
}
function settings(input, base = DEFAULT) {
  if (!plain(input) || Object.keys(input).some(key => !FIELDS.includes(key))) {
    fail('TEMPLATE_INVALID', 'Only template description, goalContext, environment and limits are supported.');
  }
  const description = text(Object.hasOwn(input, 'description') ? input.description : base.description, 240, 'description');
  const goalContext = text(Object.hasOwn(input, 'goalContext') ? input.goalContext : base.goalContext, 4000, 'goalContext');
  const environment = Object.hasOwn(input, 'environment') ? input.environment : base.environment;
  if (!plain(environment) || Object.keys(environment).length > 32
    || Object.entries(environment).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)
      || /(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH)/i.test(key)
      || typeof value !== 'string' || value.length > 1000)) {
    fail('TEMPLATE_INVALID', 'Environment must be a bounded plain string map without credential fields.');
  }
  const limits = Object.hasOwn(input, 'limits') ? input.limits : base.limits;
  if (!plain(limits) || Object.keys(limits).some(key => !['agentTurns', 'leadTurns', 'concurrency'].includes(key))) {
    fail('TEMPLATE_INVALID', 'Only team turn and concurrency limits are supported.');
  }
  // The native builder is the single authority for bound validation.
  buildFactoryTeamSpecs({ model: 'catalog-validation', limits, goalContext, environment });
  return { description, goalContext, environment: { ...environment }, limits: { ...limits } };
}

/** Durable local template definitions. No Flow, Machine or provider action occurs here. */
export class FactoryTemplateCatalog {
  constructor(control) {
    if (!(control instanceof FactoryControl)) throw new TypeError('FactoryControl is required');
    this.control = control;
  }
  transact(operation) {
    return this.control.transaction(() => {
      const version = this.control.db.prepare('PRAGMA user_version').get().user_version;
      if (![1, 2].includes(version)) fail('TEMPLATE_SCHEMA', 'Template catalog requires a standard FactoryControl database.');
      this.control.db.exec(`CREATE TABLE IF NOT EXISTS factory_templates(
        name TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0),
        deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), definition TEXT NOT NULL
      )`);
      return operation();
    });
  }
  row(name) { return this.control.db.prepare('SELECT * FROM factory_templates WHERE name=?').get(name); }
  value(row) {
    if (!row || row.deleted) return null;
    return { name: row.name, ...JSON.parse(row.definition), revision: row.revision, source: 'stored' };
  }
  get(name = 'generic') {
    nameOf(name);
    return this.transact(() => this.value(this.row(name))
      ?? (name === 'generic' ? { ...DEFAULT, environment: {}, limits: {},
        revision: this.row(name)?.revision ?? 0, source: 'builtin' } : null));
  }
  list() {
    return this.transact(() => {
      const rows = this.control.db.prepare('SELECT * FROM factory_templates WHERE deleted=0 ORDER BY name').all();
      const values = rows.map(row => this.value(row));
      if (!values.some(row => row.name === 'generic')) {
        values.push({ ...DEFAULT, environment: {}, limits: {},
          revision: this.row('generic')?.revision ?? 0, source: 'builtin' });
      }
      return values.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
  create(input) {
    if (!plain(input)) fail('TEMPLATE_INVALID', 'Template input is required.');
    const { name, ...fields } = input;
    nameOf(name);
    if (name === 'generic') fail('TEMPLATE_CONFLICT', 'Update the built-in generic template to override it.');
    const definition = settings(fields);
    return this.transact(() => {
      const row = this.row(name);
      if (row && !row.deleted) fail('TEMPLATE_CONFLICT', 'Template already exists.');
      const revision = (row?.revision ?? 0) + 1;
      this.control.db.prepare(`INSERT INTO factory_templates(name,revision,deleted,definition) VALUES(?,?,0,?)
        ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,deleted=0,definition=excluded.definition`)
        .run(name, revision, JSON.stringify(definition));
      return this.value(this.row(name));
    });
  }
  update(name, input) {
    nameOf(name);
    if (!plain(input) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      fail('TEMPLATE_INVALID', 'Expected revision is required.');
    }
    const { expectedRevision, ...fields } = input;
    return this.transact(() => {
      const row = this.row(name);
      const current = this.value(row) ?? (name === 'generic' ? { ...DEFAULT } : null);
      if (!current || row?.deleted && name !== 'generic') fail('TEMPLATE_MISSING', 'Template does not exist.');
      if ((row?.revision ?? 0) !== expectedRevision) fail('TEMPLATE_STALE', 'Template revision changed.');
      const definition = settings(fields, current);
      const revision = expectedRevision + 1;
      this.control.db.prepare(`INSERT INTO factory_templates(name,revision,deleted,definition) VALUES(?,?,0,?)
        ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,deleted=0,definition=excluded.definition`)
        .run(name, revision, JSON.stringify(definition));
      return this.value(this.row(name));
    });
  }
  delete(name, { expectedRevision } = {}) {
    nameOf(name);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail('TEMPLATE_INVALID', 'Expected revision is required.');
    }
    return this.transact(() => {
      const row = this.row(name);
      if (!row || row.deleted) fail('TEMPLATE_MISSING', 'Template does not exist.');
      if (row.revision !== expectedRevision) fail('TEMPLATE_STALE', 'Template revision changed.');
      this.control.db.prepare('UPDATE factory_templates SET revision=?,deleted=1 WHERE name=?')
        .run(expectedRevision + 1, name);
      return name === 'generic'
        ? { ...DEFAULT, environment: {}, limits: {}, revision: expectedRevision + 1, source: 'builtin' }
        : { name, deleted: true, revision: expectedRevision + 1 };
    });
  }
  build(name = 'generic', options = {}) {
    const record = this.get(name);
    if (!record) fail('TEMPLATE_MISSING', 'Template does not exist.');
    if (!plain(options) || Object.keys(options).some(key => !['model', 'availableServers', 'availableTools', 'limits'].includes(key))) {
      fail('TEMPLATE_INVALID', 'Model, server/tool inventory and optional limits are required.');
    }
    if (options.limits !== undefined && (!plain(options.limits)
      || Object.keys(options.limits).some(key => !['agentTurns', 'leadTurns', 'concurrency'].includes(key)))) {
      fail('TEMPLATE_INVALID', 'Only team turn and concurrency limits are supported.');
    }
    return buildFactoryTeamSpecs({ model: options.model, availableServers: options.availableServers,
      availableTools: options.availableTools, limits: { ...record.limits, ...options.limits },
      goalContext: record.goalContext, environment: record.environment });
  }
}
