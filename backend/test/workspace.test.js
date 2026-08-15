import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWorkspaceManager } from '../services/workspace-manager.js'

test('workspace manager retargets every tool to the selected project', async (context) => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-project-a-'))
  const second = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-project-b-'))
  context.after(async () => {
    await fs.rm(first, { recursive: true, force: true })
    await fs.rm(second, { recursive: true, force: true })
  })

  const workspace = await createWorkspaceManager(first)
  await workspace.runtime.writeFile('only-a.txt', 'A')
  await workspace.select(second)
  await workspace.runtime.writeFile('only-b.txt', 'B')

  assert.equal(workspace.info().path, await fs.realpath(second))
  assert.equal(await fs.readFile(path.join(first, 'only-a.txt'), 'utf8'), 'A')
  assert.equal(await fs.readFile(path.join(second, 'only-b.txt'), 'utf8'), 'B')
  await assert.rejects(fs.access(path.join(second, 'only-a.txt')))
})

test('workspace manager grants and resets extra directories', async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-project-'))
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-extra-'))
  const second = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-project-b-'))
  context.after(async () => {
    await fs.rm(project, { recursive: true, force: true })
    await fs.rm(extra, { recursive: true, force: true })
    await fs.rm(second, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(extra, 'shared.txt'), 'shared')

  const workspace = await createWorkspaceManager(project)
  await assert.rejects(workspace.addDir('relative/dir'), /must be an absolute path/)
  await assert.rejects(workspace.addDir(path.join(project, 'missing')), /ENOENT/)

  const info = await workspace.addDir(extra)
  assert.deepEqual(info.extraDirs, [await fs.realpath(extra)])
  const file = await workspace.runtime.readFile(path.join(extra, 'shared.txt'))
  assert.equal(file.content, 'shared')
  await assert.rejects(workspace.addDir(extra), /already accessible/)

  await workspace.select(second)
  assert.deepEqual(workspace.info().extraDirs, [])
})

test('workspace manager rejects relative paths and files', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-project-'))
  const file = path.join(directory, 'file.txt')
  await fs.writeFile(file, 'x')
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const workspace = await createWorkspaceManager(directory)
  await assert.rejects(workspace.select('relative/project'), /must be absolute/)
  await assert.rejects(workspace.select(file), /must point to a folder/)
})
