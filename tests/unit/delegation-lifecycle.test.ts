import { expect, it } from 'vitest';
import { collectDelegations, safeTaskDetails } from '../../src/core/delegation-lifecycle';
const user = (id: string) => ({ id, role: 'user', meta: {}, blocks: [] });
const task = (id: string, startedAt: number, status = 'running', parent?: string) => ({ id, role: 'tool', meta: parent ? { parentMessageId: parent } : {}, blocks: [{ type: 'tool_call', callId: id, name: 'functions.Task', status: 'success', result: { details: { delegationId: 'same-id', startedAt, status } } }] });
const sample = (name: string, details: any) => ({ id: `sample-${name}`, role: 'tool', meta: {}, blocks: [{ type: 'tool_call', callId: `sample-${name}`, name, result: { details } }] });
it('binds a nested child to its launch USER and rejects missing/cyclic parent chains', () => {
  const nested = task('nested', 2, 'running', 'parent');
  const result = collectDelegations([user('one'), task('parent', 1), user('two'), nested, task('missing', 3, 'running', 'unrelated'), task('cycle', 4, 'running', 'cycle')]);
  expect(result.map(child => [child.callId, child.owner])).toEqual([['parent', 'one'], ['nested', 'one']]);
});
it('samples settle only the exact execution, not a resumed delegation with the same ID', () => {
  const messages = [user('one'), task('first', 1), user('two'), task('resume', 2), sample('TaskWait', { status: 'completed', delegations: [{ delegationId: 'same-id', startedAt: 1, status: 'completed' }] })];
  expect(collectDelegations(messages).map(child => [child.owner, child.status])).toEqual([['one', 'completed'], ['two', 'running']]);
});
it('timeout/any/stop requests never settle other children and stale running samples cannot resurrect settled ones', () => {
  const launch = task('launch', 1);
  expect(collectDelegations([user('one'), launch, sample('TaskWait', { status: 'completed' }), sample('TaskStop', { stopPending: [{ delegationId: 'same-id', startedAt: 1, status: 'running' }] })])[0].status).toBe('running');
  expect(collectDelegations([user('one'), task('launch', 1, 'completed'), sample('TaskList', { delegations: [{ delegationId: 'same-id', startedAt: 1, status: 'running' }] })])[0].status).toBe('completed');
});
it('does not persist task prompts, reports, arbitrary fields or malformed identities', () => {
  expect(safeTaskDetails('Task', { delegationId: 'one', startedAt: 1, status: 'running', task: 'private', report: 'private', completedAt: 0 })).toEqual({ delegationId: 'one', status: 'running', startedAt: 1 });
  expect(safeTaskDetails('Task', { delegationId: 'one\n', startedAt: 1, status: 'completed' })).toBeUndefined();
  expect(safeTaskDetails('Bash', { delegations: [] })).toBeUndefined();
});
