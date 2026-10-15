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
