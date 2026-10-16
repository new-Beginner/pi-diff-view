import { it, expect, vi } from 'vitest';
import { JobQueue } from '../../src/core/jobs';
it('starts long review work without blocking bridge and serializes operations', async () => {
 const calls: string[] = []; const q = new JobQueue(async name => { calls.push(name); await new Promise(r=>setTimeout(r,20)); return name; });
 const first = q.start('review',{}), second = q.start('action',{}); expect(q.poll(first.jobId).state).toBe('pending');
 await vi.waitFor(() => { expect(q.poll(first.jobId).result).toBe('review'); expect(q.poll(second.jobId).result).toBe('action'); }); expect(calls).toEqual(['review','action']);
 q.close(); expect(()=>q.poll(first.jobId)).toThrow();
});
it('bounds jobs and returns coded errors without leaking a rejection', async () => {
 const q = new JobQueue(async()=>{throw Object.assign(new Error('conflict'),{code:'FILE_CONFLICT'});}); const id = q.start('action',{}).jobId; await vi.waitFor(() => expect(q.poll(id).error?.code).toBe('FILE_CONFLICT')); expect(()=>q.start('arbitraryExec',{})).toThrow(); q.close();
});
it('reserves one bounded navigation job while four ordinary jobs are pending', async () => {
  let release!: () => void;
  const calls: string[] = [], q = new JobQueue(async method => { calls.push(method); if (method === 'review') await new Promise<void>(resolve => release = resolve); return method; });
  const first = q.start('review', {}); q.start('action', {}); q.start('bootstrap', {}); q.start('turnSummary', {});
  expect(() => q.start('card', {})).toThrow('Too many');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const selected = q.start('selectTurn', {});
  expect(() => q.start('selectTurn', {})).toThrow('Too many');
  await vi.waitFor(() => expect(q.poll(selected.jobId).result).toBe('selectTurn'));
  expect(q.poll(first.jobId).state).toBe('pending'); expect(calls).toEqual(['review', 'selectTurn']);
  release(); await vi.waitFor(() => expect(q.poll(first.jobId).state).toBe('done')); q.close();
});
it('reserves one independent system-open job without fencing navigation or ordinary jobs', async () => {
  let release!: () => void;
  const q = new JobQueue(async method => { if (method === 'openSystemFile') await new Promise<void>(resolve => release = resolve); return method; });
  const opened = q.start('openSystemFile', {});
  expect(() => q.start('openSystemFile', {})).toThrow('Too many');
  const selected = q.start('selectTurn', {}), card = q.start('card', {});
  await vi.waitFor(() => { expect(q.poll(selected.jobId).result).toBe('selectTurn'); expect(q.poll(card.jobId).result).toBe('card'); });
  expect(q.poll(opened.jobId).state).toBe('pending');
  release(); await vi.waitFor(() => expect(q.poll(opened.jobId).state).toBe('done')); q.close();
});
it('starts saved-card reads beside blocked context work but keeps mutation jobs ordered', async () => {
  let release!: () => void;
  const calls: string[] = [], q = new JobQueue(async method => { calls.push(method); if (method === 'sessionContext') await new Promise<void>(resolve => release = resolve); return method; });
  const context = q.start('sessionContext', {});
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const cards = q.start('replyCards', {}), review = q.start('review', { scope: 'turn' });
  q.start('action', {});
  await vi.waitFor(() => { expect(q.poll(cards.jobId).state).toBe('done'); expect(q.poll(review.jobId).state).toBe('done'); });
  expect(q.poll(context.jobId).state).toBe('pending'); expect(calls).not.toContain('action');
  release(); await vi.waitFor(() => expect(calls).toContain('action')); q.close();
});
it('reports unadmitted busy work without consuming a job or raising the four-job cap', async () => {
  let release!: () => void;
  const execute = vi.fn(async () => { await new Promise<void>(resolve => release = resolve); return 'done'; });
  const q = new JobQueue(execute);
  const jobs = Array.from({ length: 4 }, () => q.start('gitManage', { operation: 'status' }));
  for (let i = 0; i < 10; i++) expect(q.admit('bootstrap', {}, true)).toEqual({ state: 'busy' });
  expect(() => q.admit('bootstrap', {})).toThrow('Too many');
  q.close();
  await new Promise(resolve => setTimeout(resolve, 10)); expect(execute).not.toHaveBeenCalled();
  expect(jobs).toHaveLength(4); expect(() => q.admit('bootstrap', {}, true)).toThrow('closed');
});
