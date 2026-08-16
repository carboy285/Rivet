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

test('edit_file requires approval like other mutating tools', async () => {
  const calls = []
  const runtime = { execute: async (name) => { calls.push(name); return { ok: true } } }
  const guarded = createApprovedRuntime(runtime, { confirm: async () => 'once' })
  await guarded.execute('edit_file', { path: 'a', edits: [{ search: 'x', replace: 'y' }] })
  assert.deepEqual(calls, ['edit_file'])
  const denying = createApprovedRuntime(runtime, { confirm: async () => false })
  await assert.rejects(denying.execute('edit_file', { path: 'a', edits: [] }), /denied/)
})

test('an "all" decision switches the mode to bypass for later calls', async () => {
  let prompts = 0
  const runtime = { execute: async (name) => name }
  const guarded = createApprovedRuntime(runtime, { confirm: async () => { prompts += 1; return 'all' } })
  await guarded.execute('write_file', {})
  await guarded.execute('run_command', {})
  assert.equal(prompts, 1)
  assert.equal(guarded.mode, 'bypass')
})

test('auto and manual modes ask before every mutating call', async () => {
  for (const mode of ['auto', 'manual']) {
    let prompts = 0
    const runtime = { execute: async () => ({ ok: true }) }
    const guarded = createApprovedRuntime(runtime, { mode, confirm: async () => { prompts += 1; return 'once' } })
    await guarded.execute('write_file', {})
    await guarded.execute('run_command', {})
    assert.equal(prompts, 2, `expected ${mode} to prompt for both calls`)
  }
})

test('acceptEdits auto-runs file mutations but still asks before commands', async () => {
  const calls = []
  const runtime = { execute: async (name) => { calls.push(name); return { ok: true } } }
  let prompts = 0
  const guarded = createApprovedRuntime(runtime, { mode: 'acceptEdits', confirm: async () => { prompts += 1; return 'once' } })
  await guarded.execute('write_file', {})
  await guarded.execute('edit_file', { path: 'a', edits: [] })
  await guarded.execute('delete_file', {})
  await guarded.execute('run_command', { command: 'pwd' })
  assert.deepEqual(calls, ['write_file', 'edit_file', 'delete_file', 'run_command'])
  assert.equal(prompts, 1)
})

test('plan mode blocks every mutating tool without ever prompting', async () => {
  const runtime = { execute: async () => ({ ok: true }) }
  let prompts = 0
  const guarded = createApprovedRuntime(runtime, { mode: 'plan', confirm: async () => { prompts += 1; return 'once' } })
  await assert.rejects(guarded.execute('write_file', {}), /Blocked by Plan mode/)
  await assert.rejects(guarded.execute('run_command', {}), /Blocked by Plan mode/)
  assert.equal(prompts, 0)
})

test('bypass mode runs every mutating tool without ever prompting', async () => {
  const calls = []
  const runtime = { execute: async (name) => { calls.push(name); return { ok: true } } }
  let prompts = 0
  const guarded = createApprovedRuntime(runtime, { mode: 'bypass', confirm: async () => { prompts += 1; return 'once' } })
  await guarded.execute('write_file', {})
  await guarded.execute('run_command', {})
  assert.deepEqual(calls, ['write_file', 'run_command'])
  assert.equal(prompts, 0)
})

test('setMode changes behavior and an unknown mode is ignored', async () => {
  const runtime = { execute: async () => ({ ok: true }) }
  const guarded = createApprovedRuntime(runtime, { mode: 'manual', confirm: async () => 'once' })
  guarded.setMode('bypass')
  assert.equal(guarded.mode, 'bypass')
  guarded.setMode('not-a-real-mode')
  assert.equal(guarded.mode, 'bypass')
})
