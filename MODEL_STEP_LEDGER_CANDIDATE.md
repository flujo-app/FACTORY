# Original model-step ledger: isolated design fixture

This candidate is **test-only and unadopted**. The executable code lives entirely
under `test/`; it does not add a production endpoint, gateway adapter, native
mission contract, or permission to send a model request. The current
`nativeMissionEffectKey` identifies one whole FLUJO Flow POST. Reusing that key as
one model-step claim would confuse two different operations and could admit
multiple physical sends inside the Flow.

## Proposed original authority

The trusted FACTORY issuer must create a new immutable mission version at task
bootstrap, with an explicit mandatory confidentiality class and complete Flow
identity. Historical native mission v1 tasks cannot be upgraded by an arriving
request, a missing class, a caller's ordinary label, or an adapter default. The
fixture uses a synthetic `fixtureOriginalFlow` v2 declaration in the original
task specification to model this property without changing live validation.
Its only admitted class is `ordinary`; a future confidential class stays held
until separate attestation and protected-channel proof exists.

The issuer must bind each model step to the original task/specification digest,
task attempt and control epoch, parent whole-Flow effect key and request digest,
stable step identity, selected model manifest, complete role/route graph,
stable request identity, and the actual model request body digest. The worker's
HTTP body cannot supply or alter the original class, role graph, or manifest.
For dynamic Flow steps, the trusted original executor must produce this binding
before the send; a static predeclared graph alone is insufficient. Only digests
of model data belong in the controller ledger. A private body remains with its
existing owner, outside this table and its events.
The fixture's `register` inputs are synthetic test data, not authenticated
claims from an original executor. Exposing that method to a worker would be an
unsafe self-asserted authority path.

## Same-database transaction demonstrated here

The fixture attaches a separate `fixture_model_steps` table to the same
`FactoryControl` SQLite WAL database. Registration and claim both use its
`BEGIN IMMEDIATE` transaction. Both recheck the exact active task lease and the
original parent `flow_call` in `running` state, including owner, attempt, epoch,
request digest and recorded admission. Registration allows only a step in the
immutable synthetic plan, stores its descriptor digest and hashed identifiers,
and refuses conflicting replay. Claim verifies those stored fields again and
conditionally changes one row from `registered` to `claimed`. A second claimant
gets no new authority. Two separate Node processes racing on one database show
one winner; reopening the database and recording a lost ACK as `unknown` do not
reset the claim. A crash immediately after claim would leave `claimed`, which
must be treated as uncertain rather than retried.
The fixture's `markUnknown(key)` is deliberately unauthenticated test machinery;
it cannot be lifted into production. A production unknown or reconciliation
transition must require original authority and evidence bound to that same
task, parent effect, step and physical attempt.

This proves a **logical SQLite compare-and-set only**. No authenticated
cross-host issuer/bootstrap exists here. The fixture's synthetic parent is an
ordinary `flow_call` admitted for a non-native test task; it does not authenticate
an actual FLUJO Flow graph, physical model send, transport redirects/retries, or
CommunityAI peer wire. It does not touch SpendingLedger reservations or provider
accounts. A production implementation needs an explicit schema migration rather
than the fixture's `CREATE TABLE IF NOT EXISTS`.

## Required closure before production use

The original controller currently ignores the child table. The final test
deliberately demonstrates that it can settle the parent effect as succeeded and
submit the task while a child claim remains unresolved. That is a **failed
integration invariant**, not a green release gate. Production wiring must make a
claimed/unknown child block parent success, task submit/release, cell retirement,
and any snapshot, status, drain or recovery projection that would otherwise
report completion or quiescence. Cancellation and takeover must retain the
uncertain child and never create a fresh send. Reconciliation needs evidence for
the exact original request; an absent response alone is not proof of no send.

The future gateway must call the same original coordinator for each physical
model attempt after all asynchronous preparation. Its final send boundary must
recompute the bytes-to-send digest against the original binding and enforce one
attempt, no SDK retries, and no redirects, while the controller
retains uncertainty if the ACK is lost. The current separate paid database
cannot make a model-step claim and a payment transition one SQLite transaction;
any implementation must preserve the existing paid admission fence without
creating a second reservation or spending authority.

Run the scoped fixture with Node 24:

```powershell
node --test test/native-model-step-ledger.test.mjs
```
