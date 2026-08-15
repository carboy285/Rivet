import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolRuntime } from '../tools/runtime.js'

function expandHome(input) {
  if (input === '~') return os.homedir()
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

export async function createWorkspaceManager(initialRoot) {
  let runtime
  let extraDirs = []

  async function select(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Enter the full path to a project folder.')
    const expanded = expandHome(input.trim())
    if (!path.isAbsolute(expanded)) throw new Error('Project path must be absolute (or start with ~/).')
    const realPath = await fs.realpath(expanded)
    const stats = await fs.stat(realPath)
    if (!stats.isDirectory()) throw new Error('Project path must point to a folder.')
    await fs.access(realPath, fsConstants.R_OK | fsConstants.W_OK)
    extraDirs = []
    runtime = await createToolRuntime(realPath)
    return info()
  }

  async function addDir(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Enter the full path to a folder.')
    const expanded = expandHome(input.trim())
    if (!path.isAbsolute(expanded)) throw new Error('Directory must be an absolute path (or start with ~/).')
    const realPath = await fs.realpath(expanded)
    const stats = await fs.stat(realPath)
    if (!stats.isDirectory()) throw new Error('Path must point to a folder.')
    await fs.access(realPath, fsConstants.R_OK | fsConstants.W_OK)
    if (realPath === runtime.root || extraDirs.includes(realPath)) throw new Error('That folder is already accessible.')
    extraDirs = [...extraDirs, realPath]
    runtime = await createToolRuntime(runtime.root, extraDirs)
    return info()
  }

  function info() {
    return { path: runtime.root, name: path.basename(runtime.root), writable: true, extraDirs }
  }

  await select(initialRoot)
  return { select, addDir, info, get runtime() { return runtime } }
}
