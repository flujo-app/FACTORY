/** Host-supervised CommunityAI resource lifecycle; imports make no cloud calls.
 * The owner supplies the real driver, existing authorities and protected files.
 * This does not provide Original inference admission or remote API credentials.
 */
import path from 'node:path';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { FactoryControl, digest } from '../src/control.mjs';
import { SpendingLedger } from '../src/spending.mjs';
import { ModalJournal } from './modal-pilot.mjs';

export const COMMUNITYAI_ROLES = Object.freeze(['bootstrap', 'worker_0', 'worker_1', 'text_peer']);
const MANIFEST = 'sha256:aef22f8678f9c5dcc5315913cf1cf584fa9e6c2fba8d064f715d78d823c9f056';
const REVISION = '70d244cc86ccca08cf5af4e1e306ecf908b1ad5e';
const SPEC_FIELDS = ['runId', 'appName', 'appId', 'imageRef', 'imageId', 'volumeId', 'volumeEvidenceSha256',
  'manifestDigest', 'modelRevision', 'expiresAtUnix', 'reservationId', 'ceilingCents', 'gpu'];
const RETIRED_STATES = new Set(['terminate_requested_unverified', 'terminate_pending', 'sandbox_terminal_observed']);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const check = (value, code = 'COMMUNITYAI_HOST_BINDING') => { if (!value) fail(code); };
const snapshot = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function closed(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
function specInput(input) {
  closed(input, SPEC_FIELDS);
  for (const [field, expression] of Object.entries({ runId: /^factory-[a-z0-9][a-z0-9-]{2,55}$/,
    appName: /^factory-[a-z0-9][a-z0-9-]{2,55}$/, appId: /^ap-[A-Za-z0-9_-]{1,128}$/,
    imageId: /^im-[A-Za-z0-9_-]{1,128}$/, volumeId: /^vo-[A-Za-z0-9_-]{1,128}$/,
    imageRef: /^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/, volumeEvidenceSha256: /^[a-f0-9]{64}$/,
    reservationId: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ })) check(typeof input[field] === 'string' && expression.test(input[field]));
  check(input.manifestDigest === MANIFEST && input.modelRevision === REVISION
    && ['T4', 'L4'].includes(input.gpu) && Number.isSafeInteger(input.expiresAtUnix)
    && Number.isSafeInteger(input.ceilingCents) && input.ceilingCents > 0 && input.ceilingCents <= 10000);
  return freeze(snapshot(input));
}
const generation = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs,
  value.birthtimeNs, value.mode, value.nlink, value.uid, value.gid].map(String).join(':');
async function boundedJson(filename) {
  const before = await lstat(filename, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 65536n, 'COMMUNITYAI_PRIVATE_RECORD');
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    check(generation(await handle.stat({ bigint: true })) === generation(before), 'COMMUNITYAI_PRIVATE_RECORD');
    const bytes = await handle.readFile();
    check(bytes.length === Number(before.size) && generation(await handle.stat({ bigint: true })) === generation(before)
      && generation(await lstat(filename, { bigint: true })) === generation(before), 'COMMUNITYAI_PRIVATE_RECORD');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { await handle.close(); }
}

export function createCommunityAiModalSupervisor({ control, paidAdmission, managementLease, journal,
  runDirectory, privateFiles, driver, hostResourceAdmission, spec: input, clock = Date.now } = {}) {
  check(control instanceof FactoryControl && paidAdmission instanceof SpendingLedger && journal instanceof ModalJournal
    && typeof driver === 'function' && typeof hostResourceAdmission === 'function' && typeof clock === 'function'
    && typeof privateFiles?.assertPrivateDirectory === 'function'
    && typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'COMMUNITYAI_HOST_REQUIRED');
  const spec = specInput(input), lease = freeze(snapshot(managementLease)), handles = new Map();
  check(lease?.scope === 'task', 'COMMUNITYAI_MANAGEMENT_LEASE');
  const journalPath = path.join(runDirectory, 'modal.sqlite');
  const actualJournal = journal.db.prepare('PRAGMA database_list').all().find(value => value.name === 'main')?.file;
  check(actualJournal && path.resolve(actualJournal) === path.resolve(journalPath), 'COMMUNITYAI_JOURNAL_BINDING');
  const requestFor = (role, operation, value = null) => {
    check(COMMUNITYAI_ROLES.includes(role));
    return freeze({ operation, role, spec, runDirectory, input: value === null ? null : snapshot(value) });
  };
  const keyFor = (role, operation) => `${operation}-${role}`;
  function gate(request, { paid = false, retirement = false } = {}) {
    if (!retirement) control.authority(lease);
    if (paid) {
      const now = Math.floor(clock() / 1000);
      check(now < spec.expiresAtUnix && spec.expiresAtUnix <= now + 21600, 'COMMUNITYAI_EXPIRED');
      paidAdmission.assertAdmission();
      const budget = paidAdmission.snapshot(), reservation = paidAdmission.row(spec.reservationId);
      check(budget.unallocatedCents > 0 && budget.overCommittedCents === 0
        && reservation.provider === 'modal' && reservation.ceiling_cents === spec.ceilingCents
        && ['reserved', 'started'].includes(reservation.state), 'COMMUNITYAI_PAID_BINDING');
    }
    // Required owner callback binds exact App/image registry mapping/cache,
    // live controller/paid admission and owned retirement. No default exists.
    check(hostResourceAdmission(request) === true, 'COMMUNITYAI_RESOURCE_ADMISSION');
  }
  async function record(role) {
    const value = await boundedJson(path.join(runDirectory, `${role}-resource.private.json`));
    const createRequest = requestFor(role, 'create-role');
    check(value.role === role && digest(value.spec) === digest(spec)
      && value.createRequestSha256 === digest(createRequest) && /^sb-[A-Za-z0-9_-]{1,128}$/.test(value.resourceId ?? '')
      && value.admission === 'NO_ADMISSION', 'COMMUNITYAI_RESOURCE_CHECKPOINT');
    if (value.endpoint !== null) {
      closed(value.endpoint, ['resource_id', 'ipv4', 'public_port', 'listen_port', 'transport', 'application_tls']);
      check(value.endpoint.resource_id === value.resourceId && value.endpoint.listen_port === 31330
        && value.endpoint.transport === 'modal-raw-tcp' && value.endpoint.application_tls === true
        && Number.isSafeInteger(value.endpoint.public_port) && value.endpoint.public_port > 0 && value.endpoint.public_port <= 65535
        && Array.isArray(value.tcpSocket) && value.tcpSocket.length === 2 && typeof value.tcpSocket[0] === 'string'
        && value.tcpSocket[1] === value.endpoint.public_port, 'COMMUNITYAI_RESOURCE_CHECKPOINT');
    }
    return value;
  }
  async function perform(role, operation, value = null) {
    const request = requestFor(role, operation, value), key = keyFor(role, operation);
    const previous = journal.get(key);
    if (previous) {
      check(previous.operation === `${operation}:${role}` && previous.request_digest === digest(request), 'COMMUNITYAI_INTENT_CONFLICT');
      return { state: 'observation_required', effectState: previous.state, key, admission: 'NO_ADMISSION' };
    }
    const paid = operation !== 'terminate-role', retirement = !paid;
    gate(request, { paid, retirement });
    await privateFiles.assertPrivateDirectory(runDirectory);
    gate(request, { paid, retirement });
    const admission = journal.admit(key, `${operation}:${role}`, request);
    check(admission.fresh, 'COMMUNITYAI_OBSERVATION_REQUIRED');
    try {
      if (paid) paidAdmission.start(spec.reservationId);
      journal.running(key);
      gate(request, { paid, retirement });
      const result = await driver({ key, journalPath, request });
      const owned = await record(role);
      check(result?.resourceId === owned.resourceId && result.admission === 'NO_ADMISSION', 'COMMUNITYAI_DRIVER_RESULT');
      if (operation === 'launch-role') {
        check(result.state === 'exec_handle_returned_readiness_unverified' && result.process != null,
          'COMMUNITYAI_LIVE_HANDLE_REQUIRED');
        handles.set(role, result.process);
      } else if (operation === 'create-role') {
        check(result.state === 'sandbox_created_tunnel_observed' && owned.endpoint !== null, 'COMMUNITYAI_DRIVER_RESULT');
      } else {
        check(['sandbox_terminal_observed', 'terminate_pending'].includes(result.state), 'COMMUNITYAI_DRIVER_RESULT');
      }
      journal.settle(key, operation === 'terminate-role' && result.state === 'terminate_pending' ? 'unknown' : 'succeeded',
        { state: result.state, observedAt: clock() });
      return { state: result.state, key, resourceId: owned.resourceId, admission: 'NO_ADMISSION',
        inferenceQualified: false, billingFinal: false };
    } catch {
      if (['accepted', 'running'].includes(journal.get(key)?.state)) journal.settle(key, 'unknown', { state: 'unknown' });
      // Credentials, SDK diagnostics, owner errors and request bodies stay private.
      return { state: 'observation_required', key, effectState: 'unknown', admission: 'NO_ADMISSION' };
    }
  }
  async function createRole(role) { return perform(role, 'create-role'); }
  async function launchRole(role, formation = null) {
    check(COMMUNITYAI_ROLES.includes(role));
    // The pinned reviewed image has no local-only artifact_root loading seam.
    // Keep the model hold ahead of any private file, journal or driver work.
    check(role === 'bootstrap', 'COMMUNITYAI_MODEL_RUNTIME_UNQUALIFIED');
    const owned = await record(role);
    check(!RETIRED_STATES.has(owned.retirement), 'COMMUNITYAI_RETIRED_TARGET');
    const create = journal.get(keyFor(role, 'create-role'));
    check(create?.state === 'succeeded' && owned.endpoint !== null, 'COMMUNITYAI_CREATE_RECONCILIATION_REQUIRED');
    const value = { resourceId: owned.resourceId };
    check(formation === null, 'COMMUNITYAI_FORMATION');
    return perform(role, 'launch-role', value);
  }
  async function observeRole(role) {
    const owned = await record(role), request = requestFor(role, 'observe-role', { resourceId: owned.resourceId });
    gate(request, { retirement: true });
    await privateFiles.assertPrivateDirectory(runDirectory);
    const result = await driver({ key: keyFor(role, 'create-role'), journalPath, request });
    check(result?.resourceId === owned.resourceId && result.admission === 'NO_ADMISSION'
      && ['sandbox_terminal_observed', 'sandbox_running_observed'].includes(result.state), 'COMMUNITYAI_DRIVER_RESULT');
    return { state: result.state, resourceId: owned.resourceId, returncode: result.returncode,
      billingFinal: false, admission: 'NO_ADMISSION' };
  }
  async function retireRole(role) {
    const owned = await record(role);
    return perform(role, 'terminate-role', { resourceId: owned.resourceId });
  }
  async function formationFromBootstrapObservation(observation) {
    const endpoints = {};
    for (const role of COMMUNITYAI_ROLES) endpoints[role] = (await record(role)).endpoint;
    const endpoint = endpoints.bootstrap;
    check(endpoint && observation?.run_id === spec.runId && observation.resource_id === endpoint.resource_id
      && observation.scope === 'tls_bootstrap_only' && observation.phase === 'started_reachability_unverified'
      && typeof observation.peer_id === 'string' && /^[1-9A-HJ-NP-Za-km-z]{20,128}$/.test(observation.peer_id)
      && Array.isArray(observation.bootstrap_peers) && observation.bootstrap_peers.length === 1
      && observation.bootstrap_peers[0] === `/ip4/${endpoint.ipv4}/tcp/${endpoint.public_port}/p2p/${observation.peer_id}`,
    'COMMUNITYAI_BOOTSTRAP_OBSERVATION');
    return freeze({ run_id: spec.runId, manifest_digest: MANIFEST, expires_at_unix: spec.expiresAtUnix,
      endpoints, bootstrap_peers: [...observation.bootstrap_peers] });
  }
  async function launchFourRoles() {
    // Preflight the known model boundary before even a paid creation intent.
    // Bootstrap lifecycle is available only through the explicit role methods.
    fail('COMMUNITYAI_MODEL_RUNTIME_UNQUALIFIED');
  }
  return Object.freeze({ createRole, launchRole, observeRole, retireRole, formationFromBootstrapObservation,
    launchFourRoles,
    liveHandle: role => handles.get(role) ?? null, spec,
    admission: 'NO_ADMISSION', inferenceQualified: false,
    coordinatorRequirement: 'Trusted owner-host create_owned_coordinator with current Original admission and credential adapters; remote carrier required' });
}
