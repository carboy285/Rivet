import test from 'node:test'
import assert from 'node:assert/strict'
import { readBoundedDirectory } from '../tools/runtime.js'

test('directory iteration stops before consuming unbounded entries', async () => {
  let yielded = 0
  const openDirectory = async () => ({
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 100; index += 1) {
        yielded += 1
        yield {
          name: 'file-' + index,
          isDirectory: () => false,
          isFile: () => true,
        }
      }
    },
  })

  const result = await readBoundedDirectory('/unused', 3, openDirectory)
  assert.equal(result.children.length, 3)
  assert.equal(result.truncated, true)
  assert.equal(yielded, 4)
})
