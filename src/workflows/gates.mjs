/** Shared by the core controller and workflow service: the core cannot bypass workflow gates. */
export function assertWorkflowAcceptance(control, task, reviewerId, accepted) {
  if (!control.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_tasks'").get()) return;
  const row = control.db.prepare('SELECT body,current FROM workflow_tasks WHERE id=?').get(task.id);
  if (!row) return;
  const spec = JSON.parse(row.body), candidate = row.current;
  const review = control.db.prepare('SELECT body FROM workflow_reviews WHERE candidate=?').get(candidate);
  const verdict = review && JSON.parse(review.body);
  if (!verdict || verdict.reviewerId !== reviewerId || verdict.accepted !== accepted) throw new Error('A bound workflow review is required.');
  if (accepted) {
    for (const gate of spec.gates) {
      const result = control.db.prepare('SELECT body FROM workflow_verifications WHERE candidate=? AND gate=?').get(candidate, gate.id);
      if (!result || JSON.parse(result.body).outcome !== 'passed') throw new Error(`Workflow gate ${gate.id} has not passed.`);
    }
  }
}

export function assertWorkflowTransition(control, taskId, action, input) {
  if (!control.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_tasks'").get()) return;
  const row = control.db.prepare('SELECT body,current,paused FROM workflow_tasks WHERE id=?').get(taskId);
  if (!row) return;
  const spec = JSON.parse(row.body);
  if (row.paused || spec.dependencies.some(dependency => !['verified','delivered'].includes(control.task(dependency).status))) throw new Error('Workflow task is paused or waiting for a dependency.');
  if (action === 'claim' && spec.assignee !== input) throw new Error('Only the assigned workflow implementer may claim.');
  if (action === 'submit') {
    const candidate = control.db.prepare('SELECT body FROM workflow_candidates WHERE id=? AND task=?').get(row.current,taskId);
    if (!candidate || JSON.parse(candidate.body).manifestRef !== 'sha256:' + input.sha256) throw new Error('Submit through the immutable workflow candidate registry.');
  }
}
