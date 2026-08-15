import test from 'node:test'
import assert from 'node:assert/strict'
import { createApprovedRuntime } from '../approval.js'

test('read-only tools run without approval and writes require it', async () => {
  const calls = []
  const runtime = { execute: async (name) => { calls.push(name); return { ok: true } } }
  const approvals = []
  const guarded = createApprovedRuntime(runtime, { confirm: async (name) => { approvals.push(name); return name === 'write_file' ? 'once' : false } })
  await guarded.execute('read_file', { path: 'a' })
  await guarded.execute('write_file', { path: 'a', content: 'x' })
  await assert.rejects(guarded.execute('run_command', { command: 'pwd' }), /denied/)
  assert.deepEqual(calls, ['read_file', 'write_file'])
  assert.deepEqual(approvals, ['write_file', 'run_command'])
})

test('approve all persists for the terminal session', async () => {
  let prompts = 0
  const runtime = { execute: async (name) => name }
  const guarded = createApprovedRuntime(runtime, { confirm: async () => { prompts += 1; return 'all' } })
  await guarded.execute('write_file', {})
  await guarded.execute('run_command', {})
  assert.equal(prompts, 1)
  assert.equal(guarded.approveAll, true)
})
