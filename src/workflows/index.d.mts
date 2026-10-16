/// <reference types="node" />
export type ArtifactRef = `sha256:${string}`;
export interface Artifact { ref: ArtifactRef; size?: number; name: string; kind: string }
export interface GitSourceIdentity { repository: string; baseline: string; commit: string; tree: string }
export interface WorkspaceSourceIdentity { kind: 'workspace'; baseline: string; snapshot: ArtifactRef }
export type SourceIdentity = GitSourceIdentity | WorkspaceSourceIdentity;
export type VerificationScope = 'development' | 'publication' | 'release' | 'live';
export interface VerificationGate { id: string; command: string; args: string[]; adapter: 'exit-code' | 'node-tap' | 'json-summary'; scope: VerificationScope; minimumTests?: number; timeoutMs?: number; writablePaths?: string[] }
export interface WorkflowTaskInput { taskId: string; projectId?: string; branch?: string; problem: string; acceptance: string; baseline?: string; assignee: string; reviewerId: string; parentTask?: string | null; dependencies?: string[]; gates?: VerificationGate[]; verificationPolicy?: {mode:'objective'}|{mode:'review-only';reason:string}; template?: {name: string; revision: number}; context?: Record<string,unknown> }
export interface Submission { submissionId: string; source: SourceIdentity; artifacts: Artifact[]; summary: string; resolvedFindings?: string[] }
export interface Candidate extends Submission { id: string; taskId: string; manifestRef: ArtifactRef; round: number; supersedes: string | null; specDigest: string; submittedAt: number; contributions?: {taskId:string;candidateRef:ArtifactRef}[] }
export interface Finding { id: string; requirement: string; description: string }
export interface Review { accepted: boolean; findings?: Finding[]; rationale: string }
export interface ReviewRecord extends Review { candidateId: string; reviewerId: string; specDigest: string; manifestRef: ArtifactRef }
export interface VerificationResult { runId: string; candidateRef: ArtifactRef; gateDigest: string; environment: Record<string,unknown>; outcome: 'passed' | 'failed' | 'unknown' | 'cancelled' | 'timed_out'; diagnosticsRef: ArtifactRef; source?: unknown; sourceRef?: ArtifactRef; startedAt?: number; completedAt?: number; provenance?: string; reason?: string | null; tests?: number | null }
export interface WorkflowTask extends WorkflowTaskInput { status: 'ready' | 'running' | 'review' | 'verification' | 'revision_required' | 'accepted' | 'delivered' | 'paused' | 'waiting_dependency'; coreStatus: string; candidate: Candidate | null; review: ReviewRecord | null; verifications: VerificationResult[]; waitingFor: string[]; paused: boolean; lease: {owner: string; epoch: number; expires: number; controlEpoch: number} | null }
export type WorkflowEventType = 'assignment_available' | 'task_claimed' | 'candidate_submitted' | 'review_recorded' | 'verification_started' | 'verification_recorded' | 'verification_reconciled' | 'candidate_accepted' | 'revision_required' | 'dependency_ready' | 'interrupted' | 'resumed' | 'knowledge_curated';
export interface WorkflowEvent { seq: number; type: WorkflowEventType; task: string | null; actor: string | null; body: Record<string,unknown>; observed: number }
export interface EventFilter { after?: 0 | string; limit?: number; taskId?: string; actor?: string; types?: WorkflowEventType[] }
export interface EventPage { events: WorkflowEvent[]; cursor: string; sequence: number; through: number; hasMore: boolean }
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
  reviewPacket(candidateId: string): {problem: string; acceptance: string; baseline: string; gates: VerificationGate[]; candidate: Candidate; instructions: string; contributions: {taskId:string;candidateRef:ArtifactRef}[]};
  nextActions(actor: string): {taskId: string; action: 'claim' | 'continue' | 'review' | 'revise'; candidateId: string | null}[];
  events(options?: EventFilter): EventPage;
  subscribe(options?: SubscriptionOptions): AsyncGenerator<EventPage>;
  curateKnowledge(input: KnowledgeInput, actor: string): KnowledgeRecord;
  searchKnowledge(query: string, options?: {limit?: number}): KnowledgeRecord[];
}
export interface VerificationInput { runId: string; candidateId: string; gateId: string; cwd: string; allowedScopes?: VerificationScope[]; environment?: Record<string,unknown> }
export interface VerificationRun { runId: string; status: 'admitted' | 'running' | 'unknown' | 'completed'; result?: VerificationResult; candidateId?: string; gateId?: string; reason?: string }
export interface BlockedVerification {status:'blocked';candidateId:string;gateId:string;reason:string}
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
  assignTask(input:Omit<WorkflowTaskInput,'reviewerId'>):Promise<WorkflowTask>;
  review(candidateId:string,verdict:Review):Promise<WorkflowTask>;
  candidateFiles(candidateId:string,options?:{path?:string;offset?:number;length?:number;after?:number}):Promise<unknown>;
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
export function captureGitSource(store: FactoryArtifactStore, cwd: string, input: {repository: string; baseline: string}): {source: GitSourceIdentity; artifact: Artifact; bundle?: Artifact};
export class FactoryWorkflowSupervisor {
  constructor(options: {client: WorkflowClient; directory: string; repositories?: Record<string,string>; allowedScopes?: VerificationScope[]; onEvent?: (event: unknown) => void});
  verify(candidateId: string, gateId: string, options?: {signal?: AbortSignal}): Promise<VerificationRun>;
  drain(options?: {signal?: AbortSignal}): Promise<(VerificationRun | BlockedVerification)[]>;
  serve(options?: {after?: 0 | string; signal?: AbortSignal}): Promise<void>;
}
export interface ComparisonInput { id: string; taskIds?: string[]; baseline: {revision: string; bundleSha256: string}; improved: {revision: string; bundleSha256: string}; task: {repository: string; revision: string; goal: string; acceptance: string}; armRepositories: {baseline:string;improved:string}; model: string; subagentModel?: string; reasoningEffort?: string; resources?: {machines: number; agentsPerMachine: number; cpuKind: string; cpus: number; memoryMb: number; diskGb: number; region: string}; validationPolicy: string | Record<string,unknown>; evaluatorRevision: string }
export interface ComparisonManifest { schemaVersion: number; id: string; shared: Omit<ComparisonInput,'id' | 'baseline' | 'improved' | 'armRepositories' | 'taskIds'> & {taskIds:string[]}; sharedInputDigest: string; manifestDigest: string; arms: {arm: 'baseline' | 'improved'; runtime: {revision: string; bundleSha256: string}; plan: Record<string,unknown>; namespace: string; outputPrefix: string}[]; evaluation: Record<string,unknown> }
export function createWorkflowComparison(input: ComparisonInput): ComparisonManifest;
export function launchWorkflowComparison(manifest: ComparisonManifest, options: {directory: string; bundlePaths: {baseline: string; improved: string}; image: string; githubTokens: {baseline:string;improved:string}; auth: unknown; [key: string]: unknown}): Promise<{manifestDigest: string; arms: {arm: string; directory: string; status: string; error?: string}[]; fleets: unknown[]}>;
export function summarizeWorkflowComparison(manifest: ComparisonManifest, records: {arm: string; taskId: string; outcome: 'accepted' | 'failed' | 'interrupted' | 'pending'; evidenceRef?: ArtifactRef; evaluatorRevision?: string; inputDigest?: string; [key: string]: unknown}[]): {comparisonId: string; manifestDigest: string; results: Record<string,unknown>};

export interface WorkspaceManifest {schemaVersion:1;kind:'workspace-snapshot';directories:string[];omitted:string[];files:{path:string;size:number;mode:number;chunks:{ref:ArtifactRef;size:number}[]}[]}
export function captureWorkspace(store:FactoryArtifactStore,cwd:string,options?:{paths?:string[];exclude?:string[];baseline?:string}):{source:WorkspaceSourceIdentity;artifact:Artifact;artifacts:Artifact[];objects:{ref:ArtifactRef;size:number}[]};
export function materializeWorkspace(store:FactoryArtifactStore,ref:ArtifactRef,cwd:string):WorkspaceManifest;
export function verifyWorkspaceArtifacts(store:FactoryArtifactStore,ref:ArtifactRef):WorkspaceManifest;
export function readWorkspaceFile(store:FactoryArtifactStore,ref:ArtifactRef,path:string,options?:{offset?:number;length?:number}):{snapshot:ArtifactRef;path:string;offset:number;size:number;nextOffset:number;done:boolean;text:string;base64:string};
export function submitWorkspaceCandidate(options:{client:Pick<WorkflowClient,'task'|'upload'|'call'>;cwd:string;directory:string;taskId:string;submissionId:string;paths:string[];summary:string;resolvedFindings?:string[]}):Promise<Candidate>;
export interface EvidenceSession {agentId:string;threadId:string;stopId?:string;evidence?:{root:string;path:string}}
export interface EvidenceRoot {name:string;path:string;paths?:string[];exclude?:string[]}
export interface EvidenceCheckpoint {schemaVersion:1;runId:string;machineId:string;sequence:number;final:boolean;roots:{name:string;ref:ArtifactRef}[];sessions:EvidenceSession[];capturedAt:string}
export interface EvidenceReceipt {schemaVersion:1;digest:string;checkpoint:EvidenceCheckpoint;verifiedAt:string}
export interface EvidenceClient {
  identity():Promise<{runId:string;machineId:string}>;
  missing(refs:ArtifactRef[]):Promise<ArtifactRef[]>;
  upload(ref:ArtifactRef,bytes:Uint8Array):Promise<void>;
  download(ref:ArtifactRef):Promise<Buffer>;
  commit(checkpoint:EvidenceCheckpoint):Promise<EvidenceReceipt>;
  latest():Promise<EvidenceReceipt|null>;
}
export function createEvidenceClient(options:{url:string;token:string;fetch?:typeof globalThis.fetch}):EvidenceClient;
export function startEvidenceServer(options:{directory:string;tokens:{token:string;runId:string;machineId:string}[];host?:string;port?:number}):Promise<{url:string;stores:Map<string,FactoryArtifactStore>;close():Promise<void>}>;
export class ContinuousEvidenceCollector {
  constructor(options:{directory:string;runId:string;machineId:string;roots:EvidenceRoot[];client:EvidenceClient;intervalMs?:number;sessions?:()=>EvidenceSession[];beforeCapture?:()=>Promise<void>;afterCheckpoint?:(receipt:EvidenceReceipt)=>Promise<void>;onEvent?:(event:unknown)=>void});
  readonly store:FactoryArtifactStore;
  checkpoint(options?:{final?:boolean}):Promise<EvidenceReceipt>;
  flushPending():Promise<EvidenceReceipt|undefined>;
  start():this;
  stop(options?:{final?:boolean}):Promise<EvidenceReceipt|undefined>;
  pruneAcknowledged(options:{remove:(relativePaths:string[])=>Promise<unknown>}):Promise<{removed:number}>;
}
export function restoreEvidenceCheckpoint(options:{client:EvidenceClient;receipt:EvidenceReceipt;directory:string}):Promise<{directory:string;roots:{name:string;path:string}[]}>;
