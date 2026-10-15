/// <reference types="node" />
export type ArtifactRef = `sha256:${string}`;
export interface Artifact { ref: ArtifactRef; size?: number; name: string; kind: string }
export interface SourceIdentity { repository: string; baseline: string; commit: string; tree: string }
export type VerificationScope = 'development' | 'publication' | 'release' | 'live';
export interface VerificationGate { id: string; command: string; args: string[]; adapter: 'exit-code' | 'node-tap' | 'json-summary'; scope: VerificationScope; minimumTests?: number; timeoutMs?: number }
export interface WorkflowTaskInput { taskId: string; projectId: string; branch: string; problem: string; acceptance: string; baseline: string; assignee: string; reviewerId: string; parentTask?: string | null; dependencies?: string[]; gates?: VerificationGate[]; template?: {name: string; revision: number}; context?: Record<string,unknown> }
export interface Submission { submissionId: string; source: SourceIdentity; artifacts: Artifact[]; summary: string; resolvedFindings?: string[] }
export interface Candidate extends Submission { id: string; taskId: string; manifestRef: ArtifactRef; round: number; supersedes: string | null; specDigest: string; submittedAt: number }
export interface Finding { id: string; requirement: string; description: string }
export interface Review { accepted: boolean; findings?: Finding[]; rationale: string }
export interface ReviewRecord extends Review { candidateId: string; reviewerId: string; specDigest: string; manifestRef: ArtifactRef }
export interface VerificationResult { runId: string; candidateRef: ArtifactRef; gateDigest: string; environment: Record<string,unknown>; outcome: 'passed' | 'failed' | 'unknown' | 'cancelled' | 'timed_out'; diagnosticsRef: ArtifactRef; source?: unknown; startedAt?: number; completedAt?: number; provenance?: string; reason?: string | null; tests?: number | null }
export interface WorkflowTask extends WorkflowTaskInput { status: 'ready' | 'running' | 'review' | 'verification' | 'revision_required' | 'accepted' | 'delivered' | 'paused' | 'waiting_dependency'; coreStatus: string; candidate: Candidate | null; review: ReviewRecord | null; verifications: VerificationResult[]; waitingFor: string[]; paused: boolean; lease: {owner: string; epoch: number; expires: number; controlEpoch: number} | null }
export type WorkflowEventType = 'assignment_available' | 'task_claimed' | 'candidate_submitted' | 'review_recorded' | 'verification_started' | 'verification_recorded' | 'candidate_accepted' | 'revision_required' | 'dependency_ready' | 'interrupted' | 'resumed' | 'knowledge_curated';
export interface WorkflowEvent { seq: number; type: WorkflowEventType; task: string | null; actor: string | null; body: Record<string,unknown>; observed: number }
export interface EventFilter { after?: number; limit?: number; taskId?: string; actor?: string; types?: WorkflowEventType[] }
export interface EventPage { events: WorkflowEvent[]; cursor: number; through: number; hasMore: boolean }
export interface SubscriptionOptions extends EventFilter { signal?: AbortSignal; intervalMs?: number }
export interface KnowledgeInput { id: string; expectedVersion?: number; title: string; content: string; applicability: string; candidateId: string; sources: {ref: ArtifactRef; location: string}[] }
export interface KnowledgeRecord extends KnowledgeInput { version: number; curator: string; verifiedAt: number }
export class FactoryArtifactStore {
  constructor(directory: string);
  readonly directory: string;
  path(ref: ArtifactRef): string;
  put(bytes: string | Uint8Array): {ref: ArtifactRef; size: number};
  putJSON(value: unknown): {ref: ArtifactRef; size: number};
  importFile(path: string): {ref: ArtifactRef; size: number};
  get(ref: ArtifactRef): Buffer;
  getJSON(ref: ArtifactRef): unknown;
  describe(ref: ArtifactRef): {ref: ArtifactRef; size: number};
  readChunk(ref: ArtifactRef, options?: {offset?: number; length?: number}): {ref: ArtifactRef; offset: number; size: number; data: string; done: boolean};
}
export class FactoryWorkflow {
  constructor(database: string, options?: {artifactDirectory?: string; control?: unknown; clock?: () => number});
  readonly artifacts: FactoryArtifactStore;
  close(): void;
  createTask(input: WorkflowTaskInput): WorkflowTask;
  candidate(candidateId: string): Candidate;
  getTask(taskId: string): WorkflowTask;
  listTasks(): WorkflowTask[];
  claim(taskId: string, actor: string, options?: {ttlMs?: number}): WorkflowTask;
  submit(taskId: string, actor: string, input: Submission): Candidate;
  review(candidateId: string, actor: string, input: Review): WorkflowTask;
  recordVerification(candidateId: string, gateId: string, result: VerificationResult): WorkflowTask;
  revise(taskId: string, actor: string): WorkflowTask;
  pauseTask(taskId: string, paused: boolean, actor?: string): WorkflowTask;
  reviewPacket(candidateId: string): {problem: string; acceptance: string; baseline: string; gates: VerificationGate[]; candidate: Candidate; instructions: string};
  nextActions(actor: string): {taskId: string; action: 'claim' | 'continue' | 'review' | 'revise'; candidateId: string | null}[];
  events(options?: EventFilter): EventPage;
  subscribe(options?: SubscriptionOptions): AsyncGenerator<EventPage>;
  curateKnowledge(input: KnowledgeInput, actor: string): KnowledgeRecord;
  searchKnowledge(query: string, options?: {limit?: number}): KnowledgeRecord[];
}
export interface VerificationInput { runId: string; candidateId: string; gateId: string; cwd: string; allowedScopes?: VerificationScope[]; environment?: Record<string,unknown> }
export interface VerificationRun { runId: string; status: 'admitted' | 'running' | 'unknown' | 'completed'; result?: VerificationResult; candidateId?: string; gateId?: string; reason?: string }
export function startVerification(workflow: FactoryWorkflow, input: VerificationInput): VerificationRun;
export function reconcileVerification(workflow: FactoryWorkflow, runId: string): VerificationRun;
export function runVerification(workflow: FactoryWorkflow, input: VerificationInput, options?: {signal?: AbortSignal; intervalMs?: number}): Promise<VerificationRun>;
export function interpretVerification(gate: Pick<VerificationGate,'adapter' | 'minimumTests'>, result: {exitCode: number | null; signal?: string | null; stdout: string; stderr: string; timedOut?: boolean}): Pick<VerificationResult,'outcome' | 'reason' | 'tests'>;
export interface WorkflowTemplate { schemaVersion: 1; name: string; revision: number; description: string; roles: {implementer: string; reviewer: string; supervisor: string}; transitions: string[]; artifactTypes: string[]; requiredContext: string[]; completion: string; wakeOn: string[]; knowledge: {provenanceRequired: boolean; acceptedSourcesOnly: boolean; retrievalLimit: number} }
export function listWorkflowTemplates(): WorkflowTemplate[];
export function getWorkflowTemplate(name?: string): WorkflowTemplate;
export function buildWorkflowTask(name: string, input: WorkflowTaskInput): WorkflowTaskInput;
export interface WorkflowClient {
  call(name: string, args?: Record<string,unknown>): Promise<unknown>;
  tasks(): Promise<{tasks: WorkflowTask[]}>;
  task(taskId: string): Promise<WorkflowTask>;
  createTask(input: WorkflowTaskInput): Promise<WorkflowTask>;
  events(options?: EventFilter): Promise<EventPage>;
  reviewPacket(candidateId: string): Promise<ReturnType<FactoryWorkflow['reviewPacket']>>;
  pauseTask(taskId: string, paused?: boolean): Promise<WorkflowTask>;
  command(recipient: string, command: {id: string; action?: 'message' | 'stop'; message?: string; expectedThreadId?: string; expectedTurnId?: string | null}): Promise<unknown>;
  recordVerification(candidateId: string, gateId: string, result: VerificationResult): Promise<WorkflowTask>;
  upload(bytes: Uint8Array): Promise<{ref: ArtifactRef; size: number}>;
  download(ref: ArtifactRef): Promise<Buffer>;
  subscribe(options?: SubscriptionOptions): AsyncGenerator<EventPage>;
}
export function createWorkflowClient(options: {url: string; token: string; operator?: boolean; fetch?: typeof globalThis.fetch}): WorkflowClient;
export function classifyWorkflowRecovery(agent: {nativeRuntime?: {threadId: string; threadStatus?: string; turnStatus?: string; operatorStopReceipt?: unknown}}): {state: string; action: string; replaySafe: boolean; threadId?: string};
export function contentDigest(value: unknown): string;
export interface ComparisonInput { id: string; baseline: {revision: string; bundleSha256: string}; improved: {revision: string; bundleSha256: string}; task: {repository: string; revision: string; goal: string; acceptance: string}; model: string; subagentModel?: string; reasoningEffort?: string; resources?: {machines: number; agentsPerMachine: number; cpuKind: string; cpus: number; memoryMb: number; diskGb: number; region: string}; validationPolicy: string | Record<string,unknown>; evaluatorRevision: string }
export interface ComparisonManifest { schemaVersion: number; id: string; shared: Omit<ComparisonInput,'id' | 'baseline' | 'improved'>; sharedInputDigest: string; manifestDigest: string; arms: {arm: 'baseline' | 'improved'; runtime: {revision: string; bundleSha256: string}; plan: Record<string,unknown>; namespace: string; outputPrefix: string}[]; evaluation: Record<string,unknown> }
export function createWorkflowComparison(input: ComparisonInput): ComparisonManifest;
export function launchWorkflowComparison(manifest: ComparisonManifest, options: {directory: string; bundlePaths: {baseline: string; improved: string}; image: string; githubToken: string; auth: unknown; [key: string]: unknown}): Promise<{manifestDigest: string; arms: {arm: string; directory: string; status: string; error?: string}[]; fleets: unknown[]}>;
export function summarizeWorkflowComparison(manifest: ComparisonManifest, records: {arm: string; taskId: string; outcome: 'accepted' | 'failed' | 'interrupted' | 'pending'; evidenceRef?: ArtifactRef; evaluatorRevision?: string; inputDigest?: string; [key: string]: unknown}[]): {comparisonId: string; manifestDigest: string; results: Record<string,unknown>};
