import { describe, expect, it } from 'vitest';
import { finalReplyCandidates, MAX_REPLY_PAYLOAD, replyTail } from '../../src/core/reply-content';
describe('real host aggregate reply identity', () => {
  it('includes the complete final multi-paragraph reply, never a substring in the middle', () => {
    const final = 'Done.\n\nChecks passed.';
    const content = `Progress\n\n${final}`;
    expect(finalReplyCandidates(content)).toContain(final);
    expect(finalReplyCandidates(`${content}\n\nDifferent ending`)).not.toContain(final);
    expect(finalReplyCandidates(`Progress${final}`)).not.toContain(final);
    expect(finalReplyCandidates('  Done.  ')).toContain('Done.');
  });
  it('preserves final text under long multilingual progress without exceeding serialized bridge bytes', () => {
    const final = '修复完成。\n\n所有检查通过。';
    for (const prefix of ['进度😀'.repeat(30000), '\\"\n'.repeat(30000)]) {
      const tail = replyTail(`${prefix}\n\n${final}`);
      expect(new TextEncoder().encode(JSON.stringify(tail)).length).toBeLessThanOrEqual(MAX_REPLY_PAYLOAD);
      expect(tail.endsWith(final)).toBe(true);
      expect(finalReplyCandidates(tail)).toContain(final);
    }
  });
  it('bounds candidate work and rejects oversized or empty inputs', () => {
    expect(finalReplyCandidates('x'.repeat(MAX_REPLY_PAYLOAD))).toEqual([]);
    expect(finalReplyCandidates('')).toEqual([]);
    expect(finalReplyCandidates('p\n\n'.repeat(1000) + 'final').length).toBeLessThanOrEqual(257);
  });
});
