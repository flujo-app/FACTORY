import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export class FixtureWireError extends Error {
  constructor(code) { super(code); this.name = 'FixtureWireError'; this.code = code; }
}
const requireValue = (ok, code) => { if (!ok) throw new FixtureWireError(code); };
const sha = value => createHash('sha256').update(value).digest('hex');
function plainCopy(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  requireValue(value && typeof value === 'object' && !types.isProxy(value), 'FIXTURE_COMMITMENT_INVALID');
  requireValue(Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype), 'FIXTURE_COMMITMENT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(Reflect.ownKeys(value).every(key => typeof key === 'string' && (key === 'length' && Array.isArray(value)
    || descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'))), 'FIXTURE_COMMITMENT_INVALID');
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    requireValue(keys.length === value.length && keys.every((key,index) => key === String(index)), 'FIXTURE_COMMITMENT_INVALID');
    const result = [];
    for (let index=0;index<value.length;index++) result.push(plainCopy(descriptors[String(index)].value));
    return result;
  }
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, plainCopy(descriptors[key].value)]));
}
const canonical = value => JSON.stringify(plainCopy(value));
const closed = (value, keys, code) => requireValue(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value')), code);
const commitmentKeys = ['format','mode','taskId','startNonce','parentId','slotId','requestId','nonce','credentialGeneration','leaseExpires','wire'];
const wireKeys = ['version','operation','model','method','url','headers','bodyUtf8','bodySha256','headersSha256','routingHeaderSha256'];
const requestKeys = ['version','operation','model','method','url','headers','body','bodySha256','headersSha256','routingHeaderSha256'];

/** A durable, owned OFFLINE fixture. It has no production dispatcher, secret resolver or sender. */
export function createFixtureOwnerWire({ databasePath, commitment, now = Date.now }) {
  closed(commitment, commitmentKeys, 'FIXTURE_COMMITMENT_INVALID');
  const fixed = plainCopy(commitment);
  requireValue(fixed.format === 'factory-flujo-openai-sdk-wire-v1' && fixed.mode === 'trusted-fixture-only', 'FIXTURE_MODE_REQUIRED');
  for (const key of ['taskId','startNonce','parentId','slotId','requestId','nonce','credentialGeneration']) {
    requireValue(typeof fixed[key] === 'string' && fixed[key].length > 0 && fixed[key].length <= 256, 'FIXTURE_COMMITMENT_INVALID');
  }
  requireValue(Number.isSafeInteger(fixed.leaseExpires) && fixed.leaseExpires > 0 && typeof now === 'function', 'FIXTURE_COMMITMENT_INVALID');
  closed(fixed.wire, wireKeys, 'FIXTURE_COMMITMENT_INVALID');
  const wire = fixed.wire;
  requireValue(wire.version === 2 && wire.operation === 'chat.completions.create(stream)' && wire.method === 'POST'
    && typeof wire.bodyUtf8 === 'string' && Buffer.byteLength(wire.bodyUtf8,'utf8') <= 65536 && wire.bodySha256 === sha(Buffer.from(wire.bodyUtf8, 'utf8'))
    && wire.headersSha256 === sha(JSON.stringify(wire.headers)), 'FIXTURE_COMMITMENT_INVALID');
  closed(wire.model, ['id','name','adapter','provider','baseUrl','ownerCredentialBinding'], 'FIXTURE_COMMITMENT_INVALID');
  closed(wire.model.ownerCredentialBinding, ['ownerId','credentialId'], 'FIXTURE_COMMITMENT_INVALID');
  requireValue(wire.model.adapter === 'openai' && wire.model.provider === 'openai'
    && wire.model.baseUrl === 'https://communityai.invalid/v1' && wire.url === 'https://communityai.invalid/v1/chat/completions'
    && /^sha256:[0-9a-f]{64}$/.test(wire.model.name), 'FIXTURE_RECIPIENT_REQUIRED');
  requireValue(Array.isArray(wire.headers) && wire.headers.every((pair, index) => Array.isArray(pair) && pair.length === 2
    && pair.every(v => typeof v === 'string') && /^[a-z0-9-]+$/.test(pair[0]) && pair[0] !== 'authorization'
    && (index === 0 || wire.headers[index - 1][0] < pair[0])), 'FIXTURE_COMMITMENT_INVALID');
  closed(wire.routingHeaderSha256, ['openaiOrganization','openaiProject','httpReferer','xTitle'], 'FIXTURE_COMMITMENT_INVALID');
  requireValue(Object.values(wire.routingHeaderSha256).every(v => v === null), 'FIXTURE_COMMITMENT_INVALID');
  requireValue(typeof databasePath === 'string' && databasePath.length > 0 && !databasePath.includes(':memory:'), 'FIXTURE_DATABASE_REQUIRED');
  const serialized = canonical(fixed), commitmentSha256 = sha(serialized);
  const db = new DatabaseSync(databasePath);
  const parents = new WeakMap(), children = new WeakMap();
  let isClosed = false;
  const current = () => requireValue(!isClosed, 'FIXTURE_CLOSED');
  const transaction = task => {
    current(); db.exec('BEGIN IMMEDIATE');
    try { const result = task(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS fixture_authority (id INTEGER PRIMARY KEY CHECK(id=1), commitment TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode='trusted-fixture-only'), off INTEGER NOT NULL CHECK(off IN(0,1)), credential_generation TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS fixture_parent (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, start_nonce TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('running','unknown')), witness TEXT NOT NULL, started_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS fixture_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('running','unknown')),
        witness TEXT NOT NULL, claimed_at INTEGER NOT NULL);
        CREATE TRIGGER IF NOT EXISTS fixture_parent_immutable BEFORE UPDATE OF id,task_id,start_nonce,witness,started_at ON fixture_parent BEGIN SELECT RAISE(ABORT,'fixture start immutable'); END;
        CREATE TRIGGER IF NOT EXISTS fixture_child_immutable BEFORE UPDATE OF id,parent_id,witness,claimed_at ON fixture_child BEGIN SELECT RAISE(ABORT,'fixture claim immutable'); END;
        CREATE TRIGGER IF NOT EXISTS fixture_parent_no_delete BEFORE DELETE ON fixture_parent BEGIN SELECT RAISE(ABORT,'fixture start retained'); END;
        CREATE TRIGGER IF NOT EXISTS fixture_child_no_delete BEFORE DELETE ON fixture_child BEGIN SELECT RAISE(ABORT,'fixture claim retained'); END;`);
      const authority = db.prepare('SELECT * FROM fixture_authority WHERE id=1').get();
      if (authority) requireValue(authority.commitment === serialized && authority.mode === fixed.mode, 'FIXTURE_COMMITMENT_CHANGED');
      else db.prepare('INSERT INTO fixture_authority VALUES(1,?,?,0,?)').run(serialized, fixed.mode, fixed.credentialGeneration);
    });
  } catch (error) { db.close(); throw error; }
  const clock = () => { const time = now(); requireValue(Number.isSafeInteger(time) && time >= 0, 'FIXTURE_CLOCK_INVALID'); return time; };
  const fence = time => {
    const authority = db.prepare('SELECT * FROM fixture_authority WHERE id=1').get();
    requireValue(authority?.commitment === serialized && authority.mode === fixed.mode, 'FIXTURE_AUTHORITY_CHANGED');
    requireValue(authority.off === 0, 'FIXTURE_OFF');
    requireValue(time < fixed.leaseExpires, 'FIXTURE_LEASE_EXPIRED');
    requireValue(authority.credential_generation === fixed.credentialGeneration, 'FIXTURE_CREDENTIAL_GENERATION');
  };
  const parentHandle = kind => { const handle = Object.freeze({}); parents.set(handle, {id:fixed.parentId,kind,active:kind==='fresh'}); return handle; };
  const parentRow = () => db.prepare('SELECT * FROM fixture_parent WHERE id=?').get(fixed.parentId);
  const expectedStart = canonical({mode:fixed.mode,commitmentSha256,parentId:fixed.parentId,taskId:fixed.taskId,startNonce:fixed.startNonce});
  const verifyParent = () => { const parent = parentRow(); requireValue(parent && parent.task_id === fixed.taskId && parent.start_nonce === fixed.startNonce
    && parent.witness === expectedStart && ['running','unknown'].includes(parent.state), 'FIXTURE_PARENT_REQUIRED'); return parent; };
  const childRow = () => db.prepare('SELECT * FROM fixture_child WHERE id=?').get(fixed.slotId);
  const expectedClaim = canonical({mode:fixed.mode,commitmentSha256,parentId:fixed.parentId,slotId:fixed.slotId,
    requestId:fixed.requestId,nonce:fixed.nonce,wireSha256:sha(canonical(wire)),credentialGeneration:fixed.credentialGeneration});
  const verifyClaim = () => { const child = childRow(); requireValue(child && child.parent_id === fixed.parentId
    && child.witness === expectedClaim && child.state === 'unknown' && Number.isSafeInteger(child.claimed_at), 'FIXTURE_CLAIM_CHANGED'); return child; };
  const owner = {
    async startFixtureFlow(input, enter) {
      closed(input, ['taskId','startNonce'], 'FIXTURE_PARENT_START_DENIED');
      requireValue(input.taskId === fixed.taskId && input.startNonce === fixed.startNonce && typeof enter === 'function', 'FIXTURE_PARENT_START_DENIED');
      const kind = transaction(() => {
        if (parentRow()) { verifyParent(); return 'observation'; }
        const time = clock(); fence(time);
        db.prepare("INSERT INTO fixture_parent VALUES(?,?,?,'running',?,?)").run(fixed.parentId, fixed.taskId, fixed.startNonce, expectedStart, time);
        return 'fresh';
      });
      const parent = parentHandle(kind);
      if (kind === 'observation') return {kind,parent};
      try { return {kind,parent,value:await enter(parent)}; }
      catch (error) { transaction(() => db.prepare("UPDATE fixture_parent SET state='unknown' WHERE id=?").run(fixed.parentId)); throw error; }
      finally { parents.get(parent).active = false; }
    },
    issueFixedSlot(input) {
      current(); closed(input, ['parent','slotId'], 'FIXTURE_CHILD_REQUIRED');
      const admitted = parents.get(input.parent);
      requireValue(admitted?.id === fixed.parentId && input.slotId === fixed.slotId, 'FIXTURE_CHILD_REQUIRED');
      requireValue(admitted.kind === 'fresh' && admitted.active || !!childRow(), 'FIXTURE_RESUME_HOLD');
      if (childRow()) verifyClaim();
      requireValue(verifyParent().state === 'running' || !!childRow(), 'FIXTURE_RESUME_HOLD');
      const child = Object.freeze({}); children.set(child, {id:fixed.slotId,parent:admitted}); return child;
    },
    dispatch(capability, projection) {
      current(); const admitted = children.get(capability); requireValue(admitted?.id === fixed.slotId, 'FIXTURE_CHILD_REQUIRED');
      // An already claimed slot is observation-only even after OFF/expiry or restart.
      if (childRow()) { verifyParent(); verifyClaim(); throw new FixtureWireError('FIXTURE_ALREADY_CLAIMED'); }
      requireValue(admitted.parent.active, 'FIXTURE_RESUME_HOLD');
      requireValue(projection && typeof projection === 'object' && !types.isProxy(projection), 'FIXTURE_WIRE_MISMATCH');
      const keys = Object.hasOwn(projection ?? {}, 'signal') ? [...requestKeys,'signal'] : requestKeys;
      closed(projection, keys, 'FIXTURE_WIRE_MISMATCH');
      const descriptors = Object.getOwnPropertyDescriptors(projection);
      const body = descriptors.body.value;
      requireValue(body instanceof Uint8Array && !types.isProxy(body) && body.byteLength <= 65536
        && !(body.buffer instanceof SharedArrayBuffer), 'FIXTURE_WIRE_MISMATCH');
      const signal = descriptors.signal?.value;
      requireValue(signal === undefined || signal instanceof AbortSignal && !signal.aborted, 'FIXTURE_REQUEST_ABORTED');
      const observed = Object.fromEntries(requestKeys.filter(k => k !== 'body').map(k => [k,descriptors[k].value]));
      observed.bodyUtf8 = Buffer.from(body).toString('utf8');
      requireValue(Buffer.from(observed.bodyUtf8,'utf8').equals(Buffer.from(body)), 'FIXTURE_WIRE_MISMATCH');
      requireValue(canonical(observed) === canonical(wire), 'FIXTURE_WIRE_MISMATCH');
      transaction(() => {
        requireValue(verifyParent().state === 'running', 'FIXTURE_RESUME_HOLD'); requireValue(!childRow(), 'FIXTURE_ALREADY_CLAIMED');
        const time = clock(); fence(time);
        db.prepare("INSERT INTO fixture_child VALUES(?,?,'unknown',?,?)").run(fixed.slotId,fixed.parentId,expectedClaim,time);
      });
      throw new FixtureWireError('PHYSICAL_SEND_HOLD');
    },
    abort() { current(); requireValue(!parentRow(), 'FIXTURE_PARENT_ALREADY_STARTED'); throw new FixtureWireError('FIXTURE_ABORT_UNSUPPORTED'); },
    authorizeNativePost() { throw new FixtureWireError('FIXTURE_PRODUCTION_HOLD'); },
    setOff(value) { requireValue(typeof value === 'boolean', 'FIXTURE_OFF_INVALID'); transaction(() => db.prepare('UPDATE fixture_authority SET off=? WHERE id=1').run(Number(value))); },
    setCredentialGeneration(value) { requireValue(typeof value === 'string' && value.length > 0, 'FIXTURE_CREDENTIAL_GENERATION'); transaction(() => db.prepare('UPDATE fixture_authority SET credential_generation=? WHERE id=1').run(value)); },
    observe() { current(); return {mode:fixed.mode,commitmentSha256,parent:parentRow() ?? null,child:childRow() ?? null,physicalSend:'HOLD',receiverQualification:'HOLD'}; },
    close() { if (!isClosed) { db.close(); isClosed = true; } }
  };
  return Object.freeze(owner);
}
