# Coordinator service packaging

This image runs the existing `bin/native-cell.mjs` at the single authoritative
coordinator. Its profile selects existing initialized FactoryControl and
SpendingLedger files; the entrypoint creates neither a database nor a policy.
The image contains no profile, token, snapshot, paid ledger or host `node_modules`.
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
