import test from 'node:test'
import assert from 'node:assert/strict'
import { gitDiffArgs } from '../git.js'

test('git diff treats the optional value only as a pathspec', () => {
  assert.deepEqual(
    gitDiffArgs('/tmp/project', '--output=/tmp/owned'),
    ['-C', '/tmp/project', 'diff', '--color=never', '--', '--output=/tmp/owned'],
  )
  assert.deepEqual(
    gitDiffArgs('/tmp/project', ''),
    ['-C', '/tmp/project', 'diff', '--color=never'],
  )
})
