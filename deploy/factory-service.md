# Coordinator service packaging

This image runs the existing `bin/native-cell.mjs` at the single authoritative
coordinator. Its profile selects existing initialized FactoryControl and
SpendingLedger files; the entrypoint creates neither a database nor a policy.
The image contains no profile, token, snapshot, paid ledger or host `node_modules`.
The optional explicit `capacity-broker` role is described in
[factory-service.broker.md](factory-service.broker.md). Its process shares the
same initialized authority volume and uses an authenticated explicit native
source profile. The default role remains the native-cell mission runner.
The Dockerfile-specific context allowlist also excludes `.factory`, `.git`,
owner workspaces, tests and private runtime artifacts.

The base is the official `node:24.19.0-bookworm-slim` manifest digest
`sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df`.
The build checks the actual Node version and must record its resulting image
identity during qualification. Application packages
come from `package-lock.json` through `npm ci --omit=dev --ignore-scripts`.
The entrypoint sets `umask 077` and uses `exec`, leaving Node as PID1 to receive
SIGTERM. Files in `/app` remain root-owned; the process runs as uid/gid1000.

`deploy/private-files.mjs` is a verbatim verified copy of
`C:/Users/Moe/Documents/GitHub/flujo-cloud/lib/private-files.mjs`, captured for
this packaging increment. Its SHA256 is
`7ae5ba87ec1cd387ee1b914105894d29254e07c0a3644c86f65810f461dcd54d`.
It imports only Node builtins, implements owner-private files on POSIX and
Windows, and is checked against that digest during the image build. Preserve
its exact LF bytes when preparing a build context; updating it requires an
explicit new source review and digest. Inert fixture scripts are included for
the independently run container acceptance; the production entrypoint does
not execute them.

Use an existing private POSIX authority directory owned by uid/gid1000. Its
directory mode must be 0700, JSON files and SQLite files 0600; SQLite WAL/SHM
remain alongside their original databases. Do not chmod, chown, initialize or
copy a live global ledger from this service. A trusted operator prepares the
authority/profile before deployment. The profile and token use the exact
closed schema in [NATIVE_CELLS.md](../NATIVE_CELLS.md), with container paths:

```
controlDatabase: /authority/control.sqlite
spendingDatabase: /authority/spending.sqlite
client.tokenFile: /authority/token.private.json
cell.outputDirectory: /authority/outputs
```

The three image directories `/authority`, `/data` and `/fixture` are empty,
owner-private directories created at build time. The image declares no
anonymous volume. Production mounts only its explicit authority directory;
the other two locations support separate isolated native/acceptance mounts.
An empty or missing authority/profile fails startup instead of initializing
a replacement ledger. Docker bind mounts must preserve POSIX uid/modes; a
Windows host directory translated by Docker Desktop may not satisfy these
checks. Use a correctly provisioned Linux host/volume, or the isolated named
volumes of the acceptance harness, rather than weakening the checks.

Build and record the exact resulting image before assigning its digest to
`FACTORY_COORDINATOR_IMAGE`:

```sh
docker build --file Dockerfile.factory --tag factory-coordinator:qualified .
docker image inspect factory-coordinator:qualified
```

`deploy/factory-service.compose.yml` requires explicit
`FACTORY_COORDINATOR_IMAGE` and `FACTORY_AUTHORITY_DIRECTORY`. It runs one
coordinator with a read-only image filesystem, private authority bind, no
published port and restart policy. Launch only after the independent source,
native execution and lifecycle acceptance are complete:

```sh
docker compose -f deploy/factory-service.compose.yml up -d
docker compose -f deploy/factory-service.compose.yml logs coordinator
docker compose -f deploy/factory-service.compose.yml stop
```

For a separately qualified local native worker, add
`deploy/factory-service.native.compose.yml`. Set `FACTORY_NATIVE_IMAGE` to that
worker's immutable image digest, `FACTORY_NATIVE_DATA_DIRECTORY` to its
separate private data directory, and `FACTORY_NATIVE_ENVIRONMENT` to an
absolute private environment file with its explicit encrypted snapshot and
authentication configuration. The native image must already have a reviewed
plain FLUJO worker startup contract and no custom entrypoint. The companion
explicitly runs `/app/scripts/launch-next.mjs start -p 4200 -H 127.0.0.1`,
shares only the coordinator's network namespace, binds `127.0.0.1:4200`, and
gets no authority ledger mount. Configure `client.origin` as
`http://127.0.0.1:4200`; the client's plaintext HTTP contract accepts literal
loopback only. A remote origin requires HTTPS and its own pinned identity.
The snapshot archive SHA and compatibility tuple in both profile worker
bindings must match that native instance. The cached native-graph image with
a SAVIA entrypoint/source83425 is not clean FLUJO provenance or acceptance.
An official worker's optional build revision of 40 lowercase hexadecimal characters is retained in
that immutable compatibility binding; an omitted or different revision is not
an equivalent worker proof. The companion has a private writable 256MiB
`/home/node` tmpfs for npm/npx cache, while its image filesystem stays read-only
and its durable `/data` mount remains separate. This bounded HOME cache is
ephemeral, contains no image-baked secrets, and hides any browser cache shipped
under HOME. The selected Flow acceptance does not prove browser tools work.

```sh
docker compose -f deploy/factory-service.compose.yml \
  -f deploy/factory-service.native.compose.yml up -d
```

Container/process liveness supplies no remote authority or proof that a Flow
has stopped. SIGTERM fences future admission and abandons local HTTP waits;
an invoked native POST can remain uncertain and requires original GET
recovery after restart. It neither cancels a Flow nor releases reservations.
There is one controller/paid authority volume; scaling coordinators with
independent copies would discard the global spending invariant. A lost volume
is not recoverable through peer health reports. Deploy backup/restore and host
availability policies separately before relying on this service.

`test/factory-service.test.mjs` runs real CLI children with this packaged
private helper and an authenticated synthetic loopback worker. It inserts
backlog after startup, loses a POST response, closes the first process,
restarts while admission is paused, observes the original completed result
with GET only, and checks private output and unchanged paid reservation
history. It also rejects an uninitialized authority without creating policies.
Run on Node24 with the normal dependency installation:

```sh
node --test --test-reporter=tap --test-concurrency=1 test/factory-service.test.mjs
```

The separate `scripts/factory-service-smoke.mjs` container harness is the
actual packaging qualification, not this local HTTP fixture. Preserve its
private raw logs, child/container exit receipts and independently reviewed
result. Until it succeeds against the qualified coordinator and clean native
images, this change is source packaging only. It does not prove rented Modal
inference, accepted software delivery, independent-host federation or fleet
availability.

## Qualified local execution

Source `fea3d151c1a4380495094744d00a33770b1abbb5` adds the optional
[capacity-broker role](factory-service.broker.md), exact vendored ManagedCloud,
pinned Fly CLI and authenticated private container-source profile. The complete
suite passed **433/433**; 134 of 135 final input hashes match that run, with the
one later isolated Docker-fixture correction qualified by final build/acceptance.
Final local image ID is
`sha256:e277a4b6cad24f25f45288ce094033d432d9b89676fdff52b4116303cb49c1d1`.
Bound snapshot capture and native restore preserved configuration and dormant
schedules. Both workers listed an inert MCP tool without invoking it. Broker
restart replayed the original `not_applied` provision intent under a fully held
fixture budget, with zero ManagedCloud provisioning or Fly calls. Nine owned
containers and four volumes were removed.

The separate latest native-cell restart proof used local coordinator image ID
`sha256:b1bc00c8ad4ef0ef1e42284a0ffa0aa63c4bf1be6ce29378e078a474b3aedcca`
with identical native-cell runtime: exactly one POST and synthetic-model call,
paused GET recovery after restart, and the next task ready without effects under
the full hold. Its nine containers and three volumes were removed. Both proofs
used the pinned native image below. These local image IDs imply no published
registry digest, cloud rollout or remote authority activation.

Earlier native-cell-only service qualification follows.

Source `ea364d60f9d93dd1d001b7fa71fbf70e22a7612c` passed **416/416** Node 24.19.0 checks and actual
packaged service acceptance. Qualified local coordinator image is
`sha256:c1848edbf480b70a005e4fd80a06a02ea94e4c1658703b9a6c4ad62f4420d51e`;
qualified local native image is
`sha256:b672e51d86a025d45e0ce2711ee862f472fa2ce16236ba6650ee414725d1fe20`
from FLUJO `549792e1839931e862e6a305eb0d9ce2b82ae905`. These are local Docker
image IDs; no registry publication or cloud activation is implied.

The actual Node 24 coordinator and Node 22 worker used the documented hardening,
private uid/gid 1000 volumes and persistent isolated fixture state. Work arrived
after startup; one response was lost; both services restarted; original GET
recovery succeeded while admission was paused. There was exactly one POST and
one synthetic-model call. The original paid row/history was retained, and the
fully held fixture budget left a new task ready with no effects. Both service
runs stopped at exit 0 without OOM; nine containers and three volumes were
removed. SQLite audits used read-only SQL connections on the writable owned
fixture authority so sidecars could be created; main database bytes were stable.

The source-pinned native image advertises its build revision. Include that
exact optional revision in the profile and immutable mission worker tuple.
Native client observation and mission claim/dispatch retain the full identity.
The successful selected Flow uses a synthetic model and no browser/MCP tools.
Real Modal inference, cloud rollout, remote shared authority and software
acceptance remain open. Original controller and paid ledger main bytes remained
unchanged, with the full US$100 still held for pending billing.
