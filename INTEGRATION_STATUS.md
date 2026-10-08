# FACTORY integration status

Checked 2026-10-08 UTC. This is a release ledger for the goal that FACTORY be
the swarm engine and SDK used across FLUJO, SAVIA, FLUJO-CLOUD, FLUJO-WORLD,
Brain/Brain Online, and O. A passing local test or an open PR is not adoption.

| Requirement | Current evidence | Still required |
| --- | --- | --- |
| Public MIT SDK, CLI, and MCP | `flujo-factory` is installable from public `flujo-app/FACTORY#main`; the [public package gate](https://github.com/flujo-app/FACTORY/actions/runs/37856012152) passed at `b3644f4`. [PUBLIC_SDK.md](PUBLIC_SDK.md) describes the exports. | First npm publication needs an authorized npm owner; `npm view flujo-factory` returned 404 and `npm whoami` returned 401 at this check. Git installation works meanwhile. |
| FACTORY-controlled local FLUJO fleet | [300-conversation acceptance](evidence/local-flujo-fleet-acceptance-20261008.json) ran ten workers with a synthetic local model and replay. FLUJO lifecycle changes reached main through [PR #955](https://github.com/mario-andreschak/FLUJO/pull/955). | Publish and qualify FLUJO 3.46.3; npm and the latest release still returned 3.46.2 at this check. The synthetic run does not establish model quality or paid throughput. |
| SAVIA case roles | [Topology acceptance](evidence/savia-local-topology-20261008.json) ran ten leads and 90 direct children through local FLUJO; `observeSaviaCaseTopology` now checks exact role briefs. | Repeat with nine distinct actual specialist briefs per team and verify useful outputs. The saved run used synthetic role labels and predates that observer. The requested 100 Luna workload has no verified run here. |
| Managed FLUJO-CLOUD fleet | [Real-module integration](evidence/managed-fleet-real-module-20261008.json) exercises FACTORY's managed adapter against the vendored ManagedCloud application service; paid holds and retirement reconciliation are covered by source tests. | Qualify a real provider resource, live health and final bill before calling cloud scale operational. |
| Brain and Brain Online Observatory | FACTORY serves authenticated read-only snapshots/events. [Brain PR #7](https://github.com/flujo-app/brain/pull/7) and [Brain Online PR #41](https://github.com/flujo-app/brain-online/pull/41) merged. | Adopt base viewer [Brain PR #4](https://github.com/flujo-app/brain/pull/4) and [Brain Online PR #34](https://github.com/flujo-app/brain-online/pull/34), then verify a live source and signed-in staff observation. Both base PRs were open at this check. |
| FLUJO-WORLD Wave Observatory | FACTORY exports `createObservatoryClient`; FLUJO [PR #973](https://github.com/mario-andreschak/FLUJO/pull/973) adds a separate FACTORY swarm view using the same authenticated HTTP contract. Its hosted run is [here](https://github.com/mario-andreschak/FLUJO/actions/runs/37857415228). | Finish hosted checks, adopt the PR, configure a same-host FACTORY presentation source, and verify the operator view against real controller state. FLUJO's Node 22 support means this first consumer does not import the Node 24 SDK client. No FACTORY presentation server was listening locally at this check. |

FACTORY's source tests and adapters establish the implemented contracts. They do
not establish one deployed, publicly installable, provider-qualified swarm that
spans every named product and workload above. Keep the goal open until those
rollout and acceptance checks pass.
