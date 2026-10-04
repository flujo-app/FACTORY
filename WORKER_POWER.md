# Explicit owned worker power

`createWorkerPowerController` in `src/worker-power.mjs` provides an opt-in controller
slice for sleeping and waking an existing Fly Machine. Sleep stops compute;
retirement remains the separate destructive ManagedCloud/controller operation.
The native queue reports an enrolled sleeping or unresolved worker as blocked by
default. An explicit `powerScheduling` option now enables queue-driven sleep/wake
for that cell using the same controller and spending ledger.

Private ManagedCloud Machines have `services: []`. Fly Proxy autostop/autostart
does not cover direct private networking, so adding autostop settings alone
does not provide this lifecycle. The power client instead uses the documented
Machine-specific POST `/stop` and `/start` endpoints. See
[Fly autostop/autostart](https://docs.fly.io/launch/autostop-autostart/)
and [Machines API](https://docs.fly.io/machines/api/machines-resource/).

The caller supplies actual `FactoryControl` and `SpendingLedger` instances,
an active management-task lease, private credentials, an existing Machine-specific
loopback proxy origin, and a closed version-1 binding. The binding includes the
original successful provision key and its cell/app ownership, exact Machine ID,
instance ID and name, owner marker, image digest, full config digest, workspace,
encrypted snapshot digest and worker compatibility (including revision when
present). `enroll(lease)` checks a current raw Machine response and authenticated
FLUJO worker/status and snapshot/info responses before recording the immutable
profile. Cached ManagedCloud records and `{owned:true, ready:true}` are insufficient.
Construction contacts neither service. Profiles and credentials are trusted-local
inputs; this adds no remote authority endpoint or persisted credential loader.

The minimal caller sequence is:

```js
const power = createWorkerPowerController({ control, paidAdmission, binding,
  flyToken, workerToken, workerOrigin });
await power.enroll(managementLease); // once, while the existing worker is ready
await power.execute(managementLease, { key: 'sleep-001', action: 'sleep' });
await power.execute(managementLease, { key: 'wake-001', action: 'wake', ceilingCents: 500 });
```

For queue scheduling, pass `powerScheduling: { controller: power, managementLease,
wakeCeilingCents: 500 }` to `createNativeCell` alongside its existing arguments.
Construction remains inert. Each explicit `tick()` observes pending power first,
including while paused, then sleeps a worker with no queued demand or wakes it for
a ready runnable native task with the exact cell/app/provision/snapshot tuple.
Wake requires free allowance for both its configured ceiling and the selected
mission. The management lease must be current; after renewal, construct a cell
with the renewed lease. `power.schedule(managementLease, { wakeCeilingCents })`
also exposes this opt-in scheduling operation directly.

Queue transition keys bind the immutable power request, preceding terminal
power effect and selected task/specification. A definitely `not_applied` intent
can advance the next decision; current power derives from the last successful
observation. Admission and the immediate
before-POST transaction recheck queued demand, including demand arriving during
authenticated readiness reads. Accepted, running and unknown intents remain
observation-only and never obtain a replacement key. A refusal known to have
made no POST can recover after rechecking current demand and authority.
Task reconciliation and Original model-step HOLDs retain precedence. A native
task still running while awaiting review continues to prevent idle sleep.

Every new operation has its own durable `worker_sleep` or `worker_wake` effect in
the existing controller. It never substitutes a provision receipt. Sleep requires
no running worker task and no accepted, running or unknown work/power effect,
plus authenticated FLUJO worker readiness and no active snapshot operation;
idleness is limited to work recorded by this Factory controller, and
untracked/background activity is not qualified. Machine identity/config is reread just
before dispatch. Pending power also fences task claims, native Flow admission,
management-task takeover/submission and retirement. Existing unenrolled workers
retain their previous behavior.

Wake requires active controller authority, unpaused shared paid admission and
enough unallocated cents before creating an intent. It creates its own
`power.<key>` reservation, refuses an independently retained reservation with that
name atomically through `SpendingLedger.reserveFresh`, and repeats authority/paid
checks immediately at dispatch. The original
effect becomes durably running before the request can start. Failure after that
point remains uncertain even when no successful response was seen.

An original key permits at most one mutation attempt. Repeating `execute` returns
its recorded state. It cannot resume an accepted crash intent, mint a replacement
key around unresolved work, or infer that a missing response means failure.
`observe(key)` performs only GETs and can record the matching current target state
while paused. Wake also requires matching authenticated readiness. A changed
instance, image, config, owner, snapshot or compatibility leaves the original
uncertainty intact. A succeeded observation describes current owned state; it
does not prove which actor caused that state.

Sleep changes neither cell allocation nor paid reservation state. Wake reservations
remain started, and stopping does not settle, cancel, retire or refund any allowance.
Stopped Machines can retain billable storage; this is compute power management,
not a guarantee of zero total cost. Final metering and owned retirement remain
separate.

Focused tests use only fake HTTP transport and fresh owned local databases. They
exercise actual controller leases and spending gates, durable dispatch, lost
responses, pause races, immutable ownership, native queue fencing and the existing
single-POST native mission path, plus queue sleep/demand wake, restart/duplicate
suppression and demand/budget races. The loopback proxy lifecycle,
live Fly transport, provider-side atomic ownership fencing and remote
shared authority are unqualified. No live Machine was started/stopped and no
paid deployment is admitted by this source change. Results/capabilities explicitly
report `productionQualified: false`. The controller advertises the available
opt-in `queuePowerScheduling: true`; per-operation results report whether the
original persisted intent used queue scheduling. Queue test results do not
qualify live Fly transport or zero total cost.
