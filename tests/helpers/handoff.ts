import { randomUUID } from 'node:crypto';
import type { AuthContext, TaskService } from '@imbox/application';
import type { ContractTypes as C } from '@imbox/contracts';

/** Exercise the real proposal and acceptance transaction, without editing epochs directly. */
export async function proposeHandoff(
  tasks: TaskService,
  task: C['Task'],
  owner: AuthContext,
  recipient: AuthContext,
  pendingActionIds?: string[],
) {
  const [criterion, ...criteria] = task.acceptance_criteria;
  const [reviewer, ...reviewers] = task.reviewer_principal_ids;
  if (!criterion || !reviewer) throw new Error('Handoff fixture requires acceptance terms');
  const request = await tasks.createRequest(
    owner,
    task.id,
    {
      kind: 'handoff',
      recipient_principal_id: recipient.principalId,
      proposal: {
        title: task.title,
        goal: task.goal,
        inputs: [],
        deliverable_schema: 'imbox.text-evidence.v1',
        acceptance: {
          criteria: [criterion, ...criteria],
          reviewer_principal_ids: [reviewer, ...reviewers],
        },
        budget: { currency: task.budget.currency, limit_microunits: task.budget.limit_microunits },
        allowed_actions: [],
        disclosure: {
          scope: 'request_recipients',
          summary: 'Outstanding execution requires reconciliation',
        },
        dependencies: [],
        cancellation_rule: 'owner_or_accountable',
        escalation_principal_id: owner.principalId,
        handoff: {
          completed_summary: '',
          pending_summary: 'Check outstanding work before continuing',
          pending_action_ids:
            pendingActionIds ?? (await tasks.handoffActions(owner, task.id)).pending_action_ids,
        },
      },
      request_expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    task.version,
    randomUUID(),
  );
  return request;
}

export async function acceptHandoff(
  tasks: TaskService,
  task: C['Task'],
  owner: AuthContext,
  recipient: AuthContext,
) {
  const request = await proposeHandoff(tasks, task, owner, recipient);
  await tasks.decideRequest(
    recipient,
    request.id,
    {
      decision: 'accept',
      proposal_version: request.proposal_version,
      expected_task_version: request.expected_task_version,
    },
    request.version,
    randomUUID(),
  );
  return tasks.getTask(recipient, task.id);
}
