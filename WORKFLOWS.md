# Verified workflows

`flujo-factory/workflows` adds an artifact-centered lifecycle to the existing controller:

```
implement → frozen candidate → independent review + objective gates
                   ↑                    ↓                 ↓
                 revise ← revision_required           accepted → delivered
```

There is no implicit maximum run duration. `accepted` means the declared gates
passed; `delivered` still requires the existing integration lease and delivery
effect receipt. Agent-authored PR progress grants neither state.

## Local SDK

```js
import { Factory } from 'flujo-factory';
import { FactoryWorkflow, captureGitSource, runVerification } from 'flujo-factory/workflows';

const database = '/private/run/control.sqlite';
new Factory(database).createSwarm({ mission: 'Repair the parser',
  agents: [{ id: 'builder' }, { id: 'reviewer', role: 'verifier' }] });
const workflow = new FactoryWorkflow(database);
try {
  workflow.createTask({
    taskId: 'parser', projectId: 'application', branch: 'codex/parser',
    problem: 'Preserve documented parser behavior while fixing issue 42.',
    acceptance: 'Existing cases and the reported failing case pass; independent review accepts the change.',
    baseline: baselineCommit, assignee: 'builder', reviewerId: 'reviewer',
    gates: [{ id: 'tests', command: '$node', args: ['--test', '--test-reporter=tap', 'test/parser.test.mjs'],
      adapter: 'node-tap', scope: 'development' }],
  });
  workflow.claim('parser', 'builder');
  // Commit the candidate first; use an absolute checkout path.
  const frozen = captureGitSource(workflow.artifacts, candidateCheckout,
    { repository: 'owner/application', baseline: baselineCommit });
  const candidate = workflow.submit('parser', 'builder', {
    submissionId: 'parser-round-1', source: frozen.source,
    artifacts: [frozen.artifact, ...(frozen.bundle ? [frozen.bundle] : [])],
    summary: 'Handle the reported input without changing valid cases.',
  });
  const packet = workflow.reviewPacket(candidate.id);
  // Give the packet to the separate reviewer, without the implementer's conversation.
  await runVerification(workflow, { runId: 'parser-round-1-tests',
    candidateId: candidate.id, gateId: 'tests', cwd: candidateCheckout });
  // Call only after the independent reviewer returns this verdict.
  workflow.review(candidate.id, 'reviewer', {
    accepted: true, findings: [], rationale: 'Original requirements and edge cases are covered.',
  });
} finally { workflow.close(); }
```

A rejected review includes stable findings `{id, requirement, description}`.
Call `revise`, claim again, and submit another candidate with `resolvedFindings`.
That field records the implementer's disposition; the reviewer independently
checks the repair. Candidate history, original requirements, findings and
diagnostics survive restarts. Tasks freeze their assignments and dependencies.
Create dependencies before dependents; cross-project dependencies support
integration work, and `parentTask` records delegation.

Renew a lease by calling `claim` again as its assigned actor. Pause/resume revokes
the previous lease, so claim again before submitting. Unknown outcomes never
grant acceptance.

## Verification

Gates declare command/argv, parser, scope and an optional command timeout.
`$node` selects the runner's Node binary. `node-tap` requires complete passing
counts without failures, cancellations or skipped tests. `json-summary` accepts
a complete Jest-style summary. Use `exit-code` for compilers/linters whose exit
status is their authoritative outcome, not to conceal test failures.

The checkout must match the frozen commit, tree and portable `git-archive`, and
remain clean before and after the check. The archive must contain every tracked
blob unchanged. Capture rejects source
hidden or rewritten by `export-ignore`/`export-subst`, and unresolved submodules.
Include required dependency preparation
in the declared gate command. The service does not invent installation or release
steps. Development gates are the default; publication, release and live checks
require explicit trusted supervisor policy.

`startVerification` launches a separate durable runner; `reconcileVerification`
reads its authenticated receipt. Reusing the same run ID reconciles the original
execution without repeating it. Missing evidence is `unknown`. A later
authoritative result can resolve that same unknown run while retaining its prior
evidence. A final failed result requires another candidate/attempt.

Commands receive a minimal environment without provider/bootstrap credentials
and a private home. The SDK, CLI, operator credential, verifier service and their
files are trusted control-plane surfaces. They are not a sandbox against hostile
code with access to the same OS account. Use an isolated verifier host/container
and repository-scoped credentials for untrusted work.

## Cloud and supervisor APIs

Set `workflow: 'verified-v1'` in a cloud plan. The last worker on each machine is
the independent verifier; the lead coordinates and other workers implement.
At least three agents per machine are required. Omitting this profile retains
the original coordination behavior.

Authenticated workers use `factory_workflow`, `factory_artifact`,
`factory_workflow_events`, `factory_knowledge` and `factory_workflow_templates`.
Their credential binds their identity. Only the operator can import objective
verification results. Operator imports are trusted assertions; the authority does
not independently authenticate a remote runner's HMAC. Keep operator credentials
inside the trusted verifier service. Worker credentials cannot import results.
The public `createWorkflowClient({url,token,operator:true})` exposes
task inspection/assignment, review packets, artifact transfers, pause/resume,
verification import and stable-ID commands. Ambiguous HTTP delivery is
`OUTCOME_UNKNOWN`: reconcile the original operation identity.

```js
const service = new FactoryWorkflowSupervisor({
  client: operatorClient, directory: '/private/run/verifier',
  repositories: { 'owner/application': '/private/source/application' },
  allowedScopes: ['development'],
});
await service.serve({ signal: abortController.signal });
```

The service retrieves frozen artifacts, checks out the exact candidate in a
private directory, executes declared gates and returns diagnostics. It never
calls a model or supplies semantic approval. Repository mappings must contain
the declared baseline; bundles transport unpublished commits.

Event pages return an opaque `cursor` bound to database, actor and filter,
numeric `sequence`, fixed watermark `through`, and `hasMore`. Start at `after:0`;
retain the returned cursor even for empty filtered pages. Reset when changing
filters. Foreign/ahead cursors are rejected. SDK subscriptions poll the transport
without model turns. Improved native workers wake on new messages or workflow
events, without periodic idle leader turns.

Pass `agentId` to `liteWorkerCommand`/`startLiteWorker` for local workers. The MCP
launcher binds it with `factory-mcp <db> --actor builder`; tool arguments cannot
select another actor or broaden verification policy. Default local MCP is the
trusted supervisor; its launch option `--verification-scopes` controls gates.
The trusted CLI accepts `factory workflow <db> @request.json`, with
`{tool,arguments,actor?,allowedScopes?}`. Worker identity is not a tool argument.

## Templates and knowledge

`listWorkflowTemplates`, `getWorkflowTemplate` and `buildWorkflowTask` expose
versioned contracts; `createTask` also enforces their context.

| Template | Required context |
| --- | --- |
| `verified-task` | Requirement and acceptance, derived from task fields by default |
| `repository-maintenance` | Repository, baseline, issue/PR, delivery policy |
| `integration-migration` | Components, compatibility contract, integration owner |
| `research-synthesis` | Question, source policy, coverage criteria |
| `continuous-improvement` | Backlog, success criteria, review triggers |

All use the same lifecycle and support dependent child tasks. Declare objective
gates, or explicitly choose `verificationPolicy:{mode:'review-only',reason:'...'}`
when no machine-evaluable condition applies. That is semantic acceptance, not an
objective test pass.

`curateKnowledge` requires an accepted candidate, exact artifact sources and
locations, applicability, a curator and an expected version. Search returns a
small set of current records with provenance. Unreviewed notes are not promoted
automatically.

## Matched comparison

`createWorkflowComparison` freezes runtime revisions/package hashes, original
repository commit, goal, acceptance criteria, evaluator, models, resources and
validation policy. Defaults are ten machines with ten agents per arm. Planning
does not launch anything or add a deadline.

Freeze the original `taskIds` (default `['mission']`) before starting either arm.
Provide two isolated `armRepositories` with the same source commit, separate
from the original repository. `launchWorkflowComparison` requires distinct
credentials scoped to those repositories, runtime bundle paths, and a private
directory. The common bootstrap pins source before either runtime starts. Each
arm has separate fleet journals, boards, artifacts and output namespaces.
A branch prefix is not a credential boundary. Credential scopes are configured
by the operator; the SDK does not independently verify their GitHub permissions.
Keep the other arm's results,
knowledge and evaluator hidden until evaluation.

Use the same independent evaluator and original task IDs for both arms.
`summarizeWorkflowComparison` retains pending/interrupted tasks in the denominator
and reports missing cost/token data as unknown. Interruption is separate from
failure; merge count alone is not the success metric.
