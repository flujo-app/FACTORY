# Capacity broker service

The image keeps the native-cell mission runner as its default role. Its explicit
`capacity-broker` role runs one `bin/capacity.mjs broker` process with `umask 077`
and `exec` signal handling. Run this role alongside the mission runner on the
same authoritative controller and spending files. The local native worker has
only its separate data volume; it receives no controller or spending mount.
The broker's peer ledger contains advisory messages and grants, not a second
spending authority. There is no multiprocess supervisor or independent replica
of the authority volume.

The image vendors the exact clean `flujo-cloud` source commit
`c36ceef69d6563b4839b605a377b3757ee8e4958` in `deploy/managed-cloud`.
`provenance.json` records byte lengths and SHA256 for its package metadata and
all eleven original library modules. The ManagedCloud import closure uses only
Node builtins. The build verifies the manifest SHA256
`c2c4db31be0ceb7d2f53fcb2920553bbd41d6012e26f8e330b5a90b06ed88490`
and every copied file; no owner workspace, host dependencies or credentials
enter the build context. Preserve those exact LF bytes when copying sources.

Fly CLI v0.4.111 is downloaded in a separate build stage from its
[official release](https://github.com/superfly/flyctl/releases/tag/v0.4.111).
The pinned Linux amd64 archive SHA256 is
`1878d7fb1f8a418039042cf0749e4b7216c6c7018b66ae10611a64c2b6d9aa9e`;
arm64 is `964db79665d7ab97af3ba5af6b35f33677ca61dcb4bcef9d6a388d46481cb312`.
These match the [official asset metadata](https://github.com/superfly/flyctl/releases/expanded_assets/v0.4.111).
Only the verified executable and CA certificates enter the final image.
The build runs `flyctl version`; this supplies binary/version evidence, not
Fly authentication or a deployed worker. Other target architectures fail.

The trusted operator prepares existing initialized peer, controller and paid
databases with private ownership and permissions. All CLI modes require an
existing initialized peer ledger; `issue` also requires the controller and
`broker` requires both controller and spending ledgers. Startup checks the
SQLite header, complete table/column sets, initialized policy/identity rows,
peer credential binding, and owner-private main/WAL/SHM files before opening
any authority constructor. Missing, blank, foreign or aliased files fail;
startup creates neither a database nor a new global policy. POSIX directories
must be 0700 and files owner-only; Windows uses the current owner's private
DACL, including inherited rules on SQLite leaves. Operator preparation remains
separate from service startup.

Mount the same existing `/authority` used by the native-cell profile, then
prepare `/authority/capacity-broker.private.json` with these required fields:

```json
{
  "peerConfigFile": "/authority/broker-peer.private.json",
  "peerDatabase": "/authority/broker-peer.sqlite",
  "grantFile": "/authority/capacity-grant.private.json",
  "controlDatabase": "/authority/control.sqlite",
  "spendingDatabase": "/authority/spending.sqlite",
  "managedModule": "/app/deploy/managed-cloud/lib/managed.mjs",
  "managedOptions": {
    "directory": "/authority/managed-cloud",
    "env": {
      "HOME": "/home/node",
      "PATH": "/usr/local/bin:/usr/bin:/bin",
      "FLYCTL_PATH": "/usr/local/bin/flyctl",
      "FLY_API_TOKEN": "OPERATOR_SUPPLIED_PRIVATE_TOKEN"
    }
  },
  "sourceProfileFile": "/authority/source-worker.private.json",
  "host": "127.0.0.1",
  "port": 4310,
  "pollMs": 250
}
```

The illustrative token is a placeholder; no profile or token is baked into the
image. Supply an explicit short-lived, appropriately scoped Fly token only for
authorized paid deployment. An explicit environment avoids cached desktop login
and source registration. Do not set `FLY_ACCESS_TOKEN`, which takes precedence
over `FLY_API_TOKEN`, or unreviewed API URL overrides. Fly's
[automation guidance](https://docs.fly.io/flyctl/integrating) describes these
credentials. The private grant's exact organization, immutable image, roles,
schema-1 child count or explicit schema-2 budget-only mode, and logical/paid
ceilings remain the authority for each request.

Service startup never changes the policy or creates controller authority. For
budget-only growth, use the trusted local paused CAS transition on the existing
controller, then deliberately resume and issue a fresh task-bound schema-2 grant
before preparing the private broker profile. Old grants remain historical and
epoch-fenced; changing their growth mode requires a new grant ID. The commands
and retained constraints are in [the growth guide](../BUDGET_GROWTH.md).

For the container role, `sourceProfileFile` explicitly binds a native source;
it avoids desktop registration files and PID assumptions across namespaces.
Its closed schema is:

```json
{
  "schemaVersion": 1,
  "origin": "http://127.0.0.1:4200",
  "tokenFile": "/authority/native-token.private.json",
  "dataRoot": "/data",
  "worker": {
    "workspace": "OPERATOR_WORKSPACE",
    "archiveSha256": "OPERATOR_SHA256_64_LOWER_HEX",
    "compatibility": {
      "applicationVersion": "OPERATOR_VERSION",
      "snapshotFormatVersion": 2,
      "layoutVersion": 2,
      "workerProtocolVersion": 1,
      "revision": "OPERATOR_BUILD_REVISION_40_LOWER_HEX"
    }
  }
}
```

The token file contains only `{ "token": "OPERATOR_PRIVATE_NATIVE_TOKEN" }`.
Use the actual native workspace/archive/compatibility tuple, including an
advertised build revision. Development workers may omit only that optional
revision. The broker compares this full worker binding and source/workspace to
the trusted grant before startup. Each provision's explicit source binding then
authenticates the native readiness/snapshot information, verifies the same
identity and export capability, and rejects an active snapshot operation.
There is no desktop-discovery fallback in bound mode. `dataRoot` is an explicit
operator-configured native namespace, not remote filesystem attestation;
ManagedCloud journals and credentials stay under `/authority/managed-cloud`,
outside the native `/data` workspace. Saved deployment reconciliation does not
depend on the source worker still being available.

Add the broker and native companion to the base service configuration:

```sh
docker compose -f deploy/factory-service.compose.yml \
  -f deploy/factory-service.native.compose.yml \
  -f deploy/factory-service.broker.compose.yml up -d
```

Set `FACTORY_COORDINATOR_IMAGE` to the newly qualified image that contains the
broker. The previously qualified native-cell-only image cannot run this role.
The broker joins the coordinator network namespace, so the native source is
literal loopback on port4200 and its local peer gateway uses port4310. External
peer access requires explicit TLS and reviewed port publication; the example
publishes no port. The broker has private writable HOME and 768MiB `/tmp` tmpfs
for Fly state and encrypted snapshot staging; the upstream default export limit
is 256MiB. Actual snapshot memory/staging capacity and Fly proxy networking must
be qualified before using a larger workspace. Its durable operation journals
remain on the authority volume.

SIGTERM stops future inbox admissions and waits for an in-flight ManagedCloud
operation; the Compose grace period covers its default ten-minute timeout.
Forced termination can leave an uncertain original intent. Restart revisits
the durable inbox and never invokes a previously accepted provision again.
Transport acknowledgement, health and process closure do not grant authority,
confirm software acceptance, prove worker quiescence or release paid holds.

The focused tests check actual CLI startup against private fixture databases,
refuse missing/blank/foreign/aliased authority, and preserve valid issue/tool
flows with preinitialized peer ledgers. Separate adapter tests authenticate a
container source and retain its optional revision. Actual Docker acceptance on
source `fea3d151c1a4380495094744d00a33770b1abbb5` used local image ID
`sha256:e277a4b6cad24f25f45288ce094033d432d9b89676fdff52b4116303cb49c1d1`.
The original snapshot protocol captured and finalized the bound workspace, and
a fresh encrypted envelope restored a second native worker with distinct
bootstrap credentials. Both workers exposed the expected inert MCP tool;
there were no tool invocations, Flow runs or schedule runs in this clone test.
Model/MCP/Flow and active schedule/state data remained preserved.

An authenticated fixture peer request reached the packaged broker over the
same private authority files. A fully held isolated ledger refused admission
before ManagedCloud provisioning or Fly invocation. The original provision
effect stayed `not_applied`; real broker restart replayed that exact key and
refusal with the same paid row/event history. This broker request was sent by
the fixture peer, separate from the earlier native Flow/MCP request proof.
All nine owned containers and four volumes were removed; stopped worker/broker
processes exited 0 without OOM. See [the qualification record](../QUALIFICATION.md)
for the full 433-test scope and later fixture-only Docker correction.

This snapshot restore does not prove successful `ManagedCloud.up` or Fly
deployment. Original ManagedCloud provisioning also uses the Machines HTTPS
API; a fake Fly CLI alone cannot prove it. Actual paid provider operation,
recursive provision-to-cell registration and independent-host authority remain
separate work. No registry publication, original ledger mutation or paid release
followed from this acceptance.
