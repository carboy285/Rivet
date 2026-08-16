import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createToolRuntime } from '../tools/runtime.js'

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-test-'))
  return { directory, cleanup: () => fs.rm(directory, { recursive: true, force: true }) }
}

test('file tools read, write, append, list, and delete within the project', async (context) => {
  const { directory, cleanup } = await fixture()
  context.after(cleanup)
  const runtime = await createToolRuntime(directory)

  await runtime.execute('write_file', { path: 'src/hello.js', content: 'export const hello = 1\n' })
  await runtime.execute('append_file', { path: 'src/hello.js', content: 'export const world = 2\n' })
  const file = await runtime.execute('read_file', { path: 'src/hello.js' })
  assert.match(file.content, /hello = 1/)
  assert.match(file.content, /world = 2/)

  const listing = await runtime.execute('list_files', { path: '.', recursive: true })
  assert.ok(listing.entries.some((entry) => entry.path === 'src/hello.js'))
  await runtime.execute('delete_file', { path: 'src/hello.js' })
  await assert.rejects(runtime.execute('read_file', { path: 'src/hello.js' }), /ENOENT/)
})

test('edit_file applies search/replace hunks and previewEdit performs no write', async (context) => {
  const { directory, cleanup } = await fixture()
  context.after(cleanup)
  const runtime = await createToolRuntime(directory)
  await runtime.execute('write_file', { path: 'src/hello.js', content: 'const a = 1\nconst b = 2\n' })

  const preview = await runtime.previewEdit('src/hello.js', [{ search: 'const a = 1', replace: 'const a = 100' }])
  assert.equal(preview.path, 'src/hello.js')
  assert.equal(preview.hunks.length, 1)
  const unchanged = await runtime.readFile('src/hello.js')
  assert.match(unchanged.content, /const a = 1\n/)

  const result = await runtime.execute('edit_file', { path: 'src/hello.js', edits: [{ search: 'const a = 1', replace: 'const a = 100' }] })
  assert.equal(result.action, 'edited')
  assert.equal(result.hunkCount, 1)
  const edited = await runtime.readFile('src/hello.js')
  assert.equal(edited.content, 'const a = 100\nconst b = 2\n')
})

test('edit_file rejects stale or ambiguous edits without touching the file', async (context) => {
  const { directory, cleanup } = await fixture()
  context.after(cleanup)
  const runtime = await createToolRuntime(directory)
  await runtime.execute('write_file', { path: 'note.txt', content: 'original content\n' })

  await assert.rejects(
    runtime.execute('edit_file', { path: 'note.txt', edits: [{ search: 'no such text', replace: 'x' }] }),
    /search text was not found/,
  )
  const stillOriginal = await runtime.readFile('note.txt')
  assert.equal(stillOriginal.content, 'original content\n')
})

test('path traversal and symlink escapes are rejected', async (context) => {
  const { directory, cleanup } = await fixture()
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-outside-'))
  context.after(async () => { await cleanup(); await fs.rm(outside, { recursive: true, force: true }) })
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
  await fs.symlink(outside, path.join(directory, 'escape'))
  const runtime = await createToolRuntime(directory)

  await assert.rejects(runtime.readFile('../secret.txt'), /escapes the project root/)
  await assert.rejects(runtime.readFile('escape/secret.txt'), /symbolic link/)
  await assert.rejects(runtime.writeFile('escape/new.txt', 'nope'), /symbolic link/)
})

test('extra roots allow absolute paths inside them and reject everything else', async (context) => {
  const { directory, cleanup } = await fixture()
  const extra = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-extra-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-outside-'))
  context.after(async () => {
    await cleanup()
    await fs.rm(extra, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(extra, 'note.txt'), 'from extra dir')
  await fs.symlink(outside, path.join(extra, 'escape'))

  const runtimeWithoutExtra = await createToolRuntime(directory)
  await assert.rejects(runtimeWithoutExtra.readFile(path.join(extra, 'note.txt')), /Use a path relative to the project root/)

  const runtime = await createToolRuntime(directory, [extra])
  const file = await runtime.readFile(path.join(extra, 'note.txt'))
  assert.equal(file.content, 'from extra dir')
  await assert.rejects(runtime.readFile(path.join(outside, 'nope.txt')), /escapes the project root/)
  await assert.rejects(runtime.readFile(path.join(extra, 'escape', 'x.txt')), /escapes the project root/)
})

test('commands run in the project with destructive system commands blocked', async (context) => {
  const { directory, cleanup } = await fixture()
  context.after(cleanup)
  const runtime = await createToolRuntime(directory)
  const result = await runtime.runCommand({ command: 'pwd' })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), await fs.realpath(directory))
  await assert.rejects(runtime.runCommand({ command: 'sudo reboot' }), /sudo is not allowed/)
  await assert.rejects(runtime.runCommand({ command: 'rm -rf /' }), /Recursive deletion/)
})
