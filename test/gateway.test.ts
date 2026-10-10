import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchClaudeTabs } from '../src/gateway.js';

test('a page open in more tabs than Claude opened is not taken for a tab of Claude', () => {
  assert.deepEqual(matchClaudeTabs(['a', 'b'], ['b', 'x', 'a']), [2, 0, 1]);
  assert.deepEqual(matchClaudeTabs(['a', 'b', 'a'], ['a', 'b', 'a']), [1, 2, 3]);
  // The person also has "a" open: the "a" tabs cannot be told apart, so none of them is Claude's.
  assert.deepEqual(matchClaudeTabs(['a', 'b'], ['a', 'b', 'a']), [0, 2, 0]);
  // A tab Claude opened and the person closed is gone.
  assert.deepEqual(matchClaudeTabs(['a', 'b'], ['b']), [2]);
});
