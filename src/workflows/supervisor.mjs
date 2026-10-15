import { mkdirSync, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FactoryControl } from '../control.mjs';
import { FactoryWorkflow } from './engine.mjs';
import { contentDigest } from './artifacts.mjs';
import { runVerification } from './verifier.mjs';

/** Trusted local verifier service for a remote board. It never invokes a model or grants delivery permission. */
export class FactoryWorkflowSupervisor {
  constructor({ client, directory, repositories, allowedScopes = ['development'], onEvent = () => {} }) {
    if (!isAbsolute(directory ?? '') || !repositories || typeof repositories !== 'object') throw new TypeError('Select a private service directory and explicit repository-to-checkout mapping.');
    for (const path of Object.values(repositories)) if (!isAbsolute(path)) throw new TypeError('Repository checkout paths must be absolute.');
    this.client = client; this.directory = directory; this.repositories = repositories; this.allowedScopes = allowedScopes; this.onEvent = onEvent;
  }
  async verify(candidateId, gateId, { signal } = {}) {
    const packet = await this.client.reviewPacket(candidateId), candidate = packet.candidate;
    const task = await this.client.task(candidate.taskId), repositoryPath = this.repositories[candidate.source.repository];
    if (!repositoryPath || task.candidate?.id !== candidateId) throw new Error('Candidate is superseded or its repository is not configured for this verifier.');
    const key = contentDigest({ candidateId, manifestRef: candidate.manifestRef, gateId });
    const directory = resolve(this.directory,key); mkdirSync(directory,{recursive:true,mode:0o700});
    const database = resolve(directory,'control.sqlite'), cwd = resolve(directory,'source');
    const control = new FactoryControl(database);
    try {
      if (!control.db.prepare('SELECT id FROM control WHERE id=1').get()) control.initializeSwarm({mission:task.problem,budgetCents:0,maxCells:4,maxDepth:2},[
        {cellId:task.assignee,parentId:'root',role:'developer',budgetCents:0,purpose:task.problem},
        {cellId:task.reviewerId,parentId:'root',role:'verifier',budgetCents:0,purpose:task.problem},
      ]);
      const workflow = new FactoryWorkflow(database,{control});
      for (const artifact of [...candidate.artifacts,{ref:candidate.manifestRef}]) {
        const bytes = await this.client.download(artifact.ref);
        if (workflow.artifacts.put(bytes).ref !== artifact.ref) throw new Error('Imported artifact mismatch.');
      }
      const manifest = workflow.artifacts.getJSON(candidate.manifestRef);
      if (contentDigest(manifest.source) !== contentDigest(candidate.source) || contentDigest(manifest.artifacts) !== contentDigest(candidate.artifacts)
        || manifest.taskId !== task.taskId || manifest.submissionId !== candidateId) throw new Error('Review packet does not match the frozen manifest.');
      const git = (args, options={}) => execFileSync('git',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
      if (!existsSync(resolve(cwd,'.git'))) git(['clone','--shared','--no-checkout',repositoryPath,cwd]);
      const bundle = candidate.artifacts.find(artifact=>artifact.kind==='git-bundle');
      if (bundle) {
        git(['bundle','verify',workflow.artifacts.path(bundle.ref)],{cwd});
        git(['fetch',workflow.artifacts.path(bundle.ref),'HEAD'],{cwd});
      }
      // A retained checkout may contain a running or incomplete verifier; never reset it on restart.
      if (!control.db.prepare('SELECT id FROM workflow_tasks WHERE id=?').get(task.taskId)) {
        git(['checkout','--detach',candidate.source.commit],{cwd});
        // The isolated verifier mirrors the original immutable specification. Dependency acceptance
        // is checked by the remote authority; mirror placeholders retain the original IDs/digests.
        const imported = new Set();
        const importContext = async (contextId, requiredAccepted) => {
          if (imported.has(contextId)) return; imported.add(contextId);
          const original = await this.client.task(contextId);
          if (requiredAccepted && !['verified','delivered'].includes(original.coreStatus)) throw new Error('Dependency is no longer accepted.');
          for (const dependency of original.dependencies ?? []) await importContext(dependency,true);
          if (original.parentTask) await importContext(original.parentTask,false);
          if (!control.db.prepare('SELECT id FROM workflow_tasks WHERE id=?').get(contextId)) {
            control.createTask({taskId:contextId,projectId:original.projectId,branch:original.branch,specification:{problem:original.problem,acceptance:original.acceptance,baseline:original.baseline}});
            control.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(['verified','delivered'].includes(original.coreStatus) ? 'verified' : 'ready',contextId);
            control.db.prepare('INSERT INTO workflow_tasks(id,body) VALUES(?,?)').run(contextId,JSON.stringify(original));
          }
        };
        for (const dependency of task.dependencies ?? []) await importContext(dependency,true);
        if (task.parentTask) await importContext(task.parentTask,false);
        workflow.createTask(task);
        if (control.task(task.taskId).spec_digest !== candidate.specDigest) throw new Error('Original workflow specification differs from the imported candidate.');
        workflow.claim(task.taskId,task.assignee);
        control.transaction(()=>{
          workflow.db.prepare('INSERT INTO workflow_candidates VALUES(?,?,?,?)').run(candidateId,task.taskId,candidate.round,JSON.stringify(candidate));
          workflow.db.prepare('UPDATE workflow_tasks SET current=? WHERE id=?').run(candidateId,task.taskId);
          const lease=JSON.parse(workflow.db.prepare('SELECT body FROM workflow_leases WHERE task=?').get(task.taskId).body);
          control.submit(lease,{artifactPath:workflow.artifacts.path(candidate.manifestRef)});
        });
      }
      const run = await runVerification(workflow,{runId:`verify-${key.slice(0,48)}`,candidateId,gateId,cwd,allowedScopes:this.allowedScopes},{signal});
      if (run.status === 'completed') {
        await this.client.upload(workflow.artifacts.get(run.result.diagnosticsRef));
        await this.client.recordVerification(candidateId,gateId,run.result);
      }
      this.onEvent({candidateId,gateId,...run}); return run;
    } finally { control.close(); }
  }
  async drain({ signal } = {}) {
    const { tasks } = await this.client.tasks(), results=[];
    for (const task of tasks) for (const gate of task.gates ?? []) {
      if (signal?.aborted) return results;
      if (!task.candidate || task.paused || task.waitingFor.length || !['review','verification'].includes(task.status)
        || !this.allowedScopes.includes(gate.scope) || task.verifications.some(result=>result.gateDigest===contentDigest(gate))) continue;
      results.push(await this.verify(task.candidate.id,gate.id,{signal}));
    }
    return results;
  }
  async serve({ after = 0, signal } = {}) {
    await this.drain({signal});
    for await (const page of this.client.subscribe({after,signal,types:['candidate_submitted','resumed','dependency_ready']})) {
      if (page.events.length) await this.drain({signal});
    }
  }
}
