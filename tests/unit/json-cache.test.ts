import { expect, it, vi } from 'vitest';
import { JsonCache } from '../../src/renderer/json-cache';

it('accounts UTF-8 bytes incrementally through replacement, deletion and clearing', () => {
  const cache = new JsonCache<string, { text: string }>();
  const first = { text: '中文😀' };
  cache.set('a', first).set('b', { text: 'second' });
  const total = () => [...cache.values()].reduce((n, item) => n + new TextEncoder().encode(JSON.stringify(item)).length, 0);
  expect(cache.byteSize).toBe(total());
  cache.set('a', { text: '中文😀' });
  expect(cache.get('a')).toBe(first); expect([...cache.keys()]).toEqual(['b', 'a']);
  cache.set('b', { text: 'replacement' }); expect(cache.byteSize).toBe(total());
  cache.delete('a'); cache.delete('missing'); expect(cache.byteSize).toBe(total());
  cache.clear(); expect(cache.byteSize).toBe(0); expect(cache.size).toBe(0);
});
it('serializes only the inserted card, not the full history cache', () => {
  const cache = new JsonCache<number, { toJSON(): unknown }>();
  const serialize = vi.fn(() => ({ text: 'x'.repeat(10000) }));
  for (let i = 0; i < 200; i++) cache.set(i, { toJSON: serialize });
  expect(serialize).toHaveBeenCalledTimes(200);
  expect(cache.byteSize).toBe(200 * new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(10000) })).length);
  cache.delete(0); expect(serialize).toHaveBeenCalledTimes(200);
});
