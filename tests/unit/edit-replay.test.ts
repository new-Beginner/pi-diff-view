import { describe, expect, it } from 'vitest';
import { replayRecordedEdit } from '../../src/core/edit-replay';
import { digest } from '../../src/core/path-policy';
import { MAX_TEXT_BYTES } from '../../src/core/contracts';

describe('hash-verified historical Edit replay', () => {
  it.each([
    ['one\nold\nthree\nold\n', 'PUT 2.=2:\n+new\nPUT 4.=4:\n+last', 'one\nnew\nthree\nlast\n'],
    ['one\nold\nthree', 'PUT 2.=2:\n+new', 'one\nnew\nthree'],
    ['one\r\nold\r\nthree\r\n', 'PUT 2.=2:\n+new', 'one\r\nnew\r\nthree\r\n'],
    ['a\nb\nc\n', 'PUT <1:\n+first\nCUT 2.=2\nPUT >3:\n+last', 'first\na\nc\nlast\n'],
    ['a\nb\n', 'PUT >$:\n+tail', 'a\nb\ntail\n'],
    ['', 'PUT <1:\n+new', 'new\n'],
    ['a\n', 'CUT 1.=1', ''],
    ['a\nb\n', 'PUT 1.=1:\n++literal plus\n+\n+next', '+literal plus\n\nnext\nb\n'],
  ])('replays anchored operations without losing newline bytes: %j', (before, ops, after) => {
    expect(replayRecordedEdit(before, { ops }, digest(after))).toBe(after);
  });
  it.each(['PUT 0.=1:\n+x', 'PUT 3.=2:\n+x', 'CUT 1.=9', 'PUT >0:\n+x', 'PUT 1.=1\n+x', 'PUT <1 @register', 'MV new.txt', 'REM', 'PUT 1.=2:\n+x\nCUT 2.=2', 'PUT <1:\n+x\nPUT <1:\n+y'])('rejects unsupported or ambiguous instructions: %j', ops => {
    expect(replayRecordedEdit('a\nb\n', { ops }, digest('x\n'))).toBeUndefined();
  });
  it('requires the exact recorded output hash and bounds the input', () => {
    expect(replayRecordedEdit('a\n', { ops: 'PUT 1.=1:\n+b' }, digest('wrong\n'))).toBeUndefined();
    expect(replayRecordedEdit('a\n', { ops: 'PUT 1.=1:\n+b' }, 'no-hash')).toBeUndefined();
    expect(replayRecordedEdit('a', { ops: 'PUT 1.=1:\n+' + 'x'.repeat(MAX_TEXT_BYTES) }, digest('b'))).toBeUndefined();
  });
  it('supports unique legacy replacements but refuses ambiguous or missing text', () => {
    expect(replayRecordedEdit('a old b', { old_string: 'old', new_string: 'new' }, digest('a new b'))).toBe('a new b');
    expect(replayRecordedEdit('old old', { old_string: 'old', new_string: 'new' }, digest('new old'))).toBeUndefined();
    expect(replayRecordedEdit('a', { old_string: 'missing', new_string: 'new' }, digest('new'))).toBeUndefined();
    expect(replayRecordedEdit('a', { old_string: '', new_string: 'new' }, digest('newa'))).toBeUndefined();
  });
});
