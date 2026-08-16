import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSessionStore, sessionDirectoryForProject } from '../services/session-store.js'

async function fixture(context) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-project-'))
  const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-config-'))
  context.after(async () => {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(configRoot, { recursive: true, force: true })
  })
  return { project, configRoot }
}

test('save, list, and load round-trip a session', async (context) => {
  const { project, configRoot } = await fixture(context)
  const store = createSessionStore(project, { configRoot })

  await store.save({ id: 'session-1', projectPath: project, model: 'demo-model', title: 'Fix the bug', messages: [{ role: 'user', content: 'fix it' }] })
  const summaries = await store.list()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].id, 'session-1')
  assert.equal(summaries[0].title, 'Fix the bug')
  assert.equal(summaries[0].messageCount, 1)

  const full = await store.load('session-1')
  assert.equal(full.model, 'demo-model')
  assert.deepEqual(full.messages, [{ role: 'user', content: 'fix it' }])
  assert.ok(full.createdAt)
  assert.ok(full.updatedAt)
})

test('listing sorts by most recently updated first', async (context) => {
  const { project, configRoot } = await fixture(context)
  const store = createSessionStore(project, { configRoot })

  await store.save({ id: 'older', title: 'Older', messages: [{ role: 'user', content: 'a' }] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await store.save({ id: 'newer', title: 'Newer', messages: [{ role: 'user', content: 'b' }] })

  const summaries = await store.list()
  assert.deepEqual(summaries.map((s) => s.id), ['newer', 'older'])
})

test('saving again preserves the original createdAt but updates updatedAt', async (context) => {
  const { project, configRoot } = await fixture(context)
  const store = createSessionStore(project, { configRoot })

  const first = await store.save({ id: 'session-1', title: 'A', messages: [{ role: 'user', content: 'a' }] })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await store.save({ id: 'session-1', title: 'A', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })

  assert.equal(second.createdAt, first.createdAt)
  assert.notEqual(second.updatedAt, first.updatedAt)
})

test('sessions are isolated per project', async (context) => {
  const { project, configRoot } = await fixture(context)
  const otherProject = await fs.mkdtemp(path.join(os.tmpdir(), 'rivet-project-'))
  context.after(() => fs.rm(otherProject, { recursive: true, force: true }))

  const storeA = createSessionStore(project, { configRoot })
  const storeB = createSessionStore(otherProject, { configRoot })
  await storeA.save({ id: 'a', title: 'A', messages: [{ role: 'user', content: 'a' }] })

  assert.equal((await storeA.list()).length, 1)
  assert.equal((await storeB.list()).length, 0)
})

test('loading a missing session throws a clear error, and listing an empty store returns []', async (context) => {
  const { project, configRoot } = await fixture(context)
  const store = createSessionStore(project, { configRoot })
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.load('does-not-exist'), /Session not found/)
})

test('session files and directory use private permissions', async (context) => {
  const { project, configRoot } = await fixture(context)
  const store = createSessionStore(project, { configRoot })
  await store.save({ id: 'session-1', title: 'A', messages: [{ role: 'user', content: 'a' }] })

  const directory = sessionDirectoryForProject(project, configRoot)
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
  assert.equal((await fs.stat(path.join(directory, 'session-1.json'))).mode & 0o777, 0o600)
})
