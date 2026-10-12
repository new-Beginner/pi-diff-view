import { afterEach, expect, it, vi } from 'vitest';
import { FileOpenRequests } from '../../src/core/file-open';
import { startFileOpenChannel } from '../../src/renderer/file-open-channel';
import type { UiTransport } from '../../src/core/contracts';
const active: (() => void)[] = [];
afterEach(() => { active.splice(0).forEach(stop => stop()); vi.restoreAllMocks(); });
function fixture(open = vi.fn(async (_session: string, _path: string) => {})) {
  const requests = new FileOpenRequests(); let current = true;
  const invoke = vi.fn(async (_method: string, args: any) => {
    if (args.listen) return requests.listen(args.sessionId, args.listenerId);
    if (args.cancelListen) return requests.cancelListen(args.sessionId, args.cancelListen);
    return requests.complete(args.requestId, args.sessionId, args.error);
  });
  const stop = startFileOpenChannel({ invoke } as UiTransport, 's', open, () => current);
  active.push(stop, () => requests.clear());
  return { requests, open, invoke, stop, switchSession: () => { current = false; } };
}
it('opens and acknowledges immediately without history refresh or mounted cards', async () => {
  const f = fixture();
  const { requestId } = f.requests.add({ sessionId: 's', path: '/project/a.ts' });
  await expect(f.requests.waitStatus(requestId)).resolves.toEqual({ state: 'done' });
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.open.mock.calls[0].slice(0, 2)).toEqual(['s', '/project/a.ts']);
  expect(f.invoke.mock.calls.every(([method]) => method === 'openFile')).toBe(true);
});
it('successive files are delivered in order, once each, with no fixed delay', async () => {
  const f = fixture();
  for (const path of ['/project/a.ts', '/project/b.ts']) {
    const { requestId } = f.requests.add({ sessionId: 's', path });
    await expect(f.requests.waitStatus(requestId)).resolves.toEqual({ state: 'done' });
  }
  expect(f.open.mock.calls.map(call => call.slice(0, 2))).toEqual([['s', '/project/a.ts'], ['s', '/project/b.ts']]);
});
it('does not open a delivered late request after switching sessions', async () => {
  const f = fixture(); f.switchSession();
  f.requests.add({ sessionId: 's', path: '/project/a.ts' });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.open).not.toHaveBeenCalled();
});
it('returns a visible navigation error without replaying the click', async () => {
  const open = vi.fn(async () => { throw new Error('File Manager unavailable'); });
  const f = fixture(open), { requestId } = f.requests.add({ sessionId: 's', path: '/project/a.ts' });
  await expect(f.requests.waitStatus(requestId)).resolves.toEqual({ state: 'error', error: 'File Manager unavailable' });
  expect(open).toHaveBeenCalledTimes(1);
});
it('cancels its idle listener on dispose without reopening or spinning', async () => {
  const f = fixture(); f.stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.open).not.toHaveBeenCalled();
});
