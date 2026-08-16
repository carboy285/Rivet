import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits } from '../lib/diff.js'

test('applyEdits replaces a single unique match and records the hunk', () => {
  const { result, hunks } = applyEdits('line1\nline2\nline3\n', [{ search: 'line2', replace: 'line2-changed' }])
  assert.equal(result, 'line1\nline2-changed\nline3\n')
  assert.equal(hunks.length, 1)
  assert.deepEqual(hunks[0], { index: 1, startLine: 2, removedLines: ['line2'], addedLines: ['line2-changed'] })
})

test('applyEdits applies multiple edits in order', () => {
  const { result } = applyEdits('a\nb\nc\n', [
    { search: 'a', replace: 'A' },
    { search: 'c', replace: 'C' },
  ])
  assert.equal(result, 'A\nb\nC\n')
})

test('applyEdits supports multi-line search and replace', () => {
  const { result, hunks } = applyEdits('function f() {\n  return 1\n}\n', [
    { search: 'function f() {\n  return 1\n}', replace: 'function f() {\n  return 2\n}' },
  ])
  assert.equal(result, 'function f() {\n  return 2\n}\n')
  assert.equal(hunks[0].startLine, 1)
  assert.deepEqual(hunks[0].removedLines, ['function f() {', '  return 1', '}'])
})

test('applyEdits rejects a search that is not found', () => {
  assert.throws(
    () => applyEdits('hello world\n', [{ search: 'missing', replace: 'x' }], 'demo.txt'),
    /Edit 1: search text was not found in demo\.txt/,
  )
})

test('applyEdits rejects an ambiguous search', () => {
  assert.throws(
    () => applyEdits('dup\ndup\n', [{ search: 'dup', replace: 'x' }], 'demo.txt'),
    /Edit 1: search text matches more than once in demo\.txt/,
  )
})

test('applyEdits rejects empty search or non-string replace', () => {
  assert.throws(() => applyEdits('a', [{ search: '', replace: 'x' }]), /must be a non-empty string/)
  assert.throws(() => applyEdits('a', [{ search: 'a', replace: 5 }]), /"replace" must be a string/)
})
