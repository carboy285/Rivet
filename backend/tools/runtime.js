import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createProjectPath, relativeProjectPath } from '../lib/project-path.js'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LIST_ENTRIES = 1000
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', '.local-coding-agent', '.DS_Store'])

const dangerousCommands = [
  { pattern: /(^|[;&|]\s*)sudo\b/i, reason: 'sudo is not allowed.' },
  { pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/i, reason: 'Machine power commands are not allowed.' },
  { pattern: /\b(?:mkfs(?:\.\w+)?|fdisk)\b/i, reason: 'Disk formatting commands are not allowed.' },
  { pattern: /\bdd\s+[^\n]*\bof=\/dev\//i, reason: 'Writing directly to devices is not allowed.' },
  { pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|~)(?:\s|$)/i, reason: 'Recursive deletion of a system or home directory is not allowed.' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*}\s*;/, reason: 'Fork bombs are not allowed.' },
]

function safeEnvironment() {
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'SystemRoot', 'COMSPEC', 'PATHEXT']
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
}

function runProcess(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout = '', stderr = '') => {
      const errorOutput = error && !stderr ? error.message : stderr
      resolve({
        exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr: error?.killed ? `${errorOutput}\nCommand timed out.`.trim() : errorOutput,
      })
    })
  })
}

export async function readBoundedDirectory(directory, limit, openDirectory = (target) => fs.opendir(target)) {
  const children = []
  let truncated = false
  const handle = await openDirectory(directory)
  for await (const child of handle) {
    if (IGNORED_NAMES.has(child.name)) continue
    if (children.length >= limit) {
      truncated = true
      break
    }
    children.push(child)
  }
  return { children, truncated }
}

export async function createToolRuntime(projectRoot, extraRoots = []) {
  const root = path.resolve(projectRoot)
  const resolvePath = await createProjectPath(root, extraRoots)

  async function readFile(relativePath) {
    const target = await resolvePath(relativePath, { mustExist: true })
    const stats = await fs.stat(target)
    if (!stats.isFile()) throw new Error('Path is not a file.')
    if (stats.size > MAX_FILE_BYTES) throw new Error('File is larger than the 2 MB reading limit.')
    const content = await fs.readFile(target, 'utf8')
    if (content.includes('\0')) throw new Error('Binary files cannot be displayed.')
    return { path: relativeProjectPath(root, target), content, size: stats.size }
  }

  async function writeFile(relativePath, content, append = false) {
    if (typeof content !== 'string') throw new Error('File content must be a string.')
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Content is larger than the 2 MB writing limit.')
    const target = await resolvePath(relativePath)
    if (target === root) throw new Error('A file path is required.')
    await fs.mkdir(path.dirname(target), { recursive: true })
    await resolvePath(relativeProjectPath(root, path.dirname(target)), { mustExist: true })
    if (append) {
      await fs.appendFile(target, content, 'utf8')
    } else {
      const temporary = `${target}.coding-agent-${process.pid}-${Date.now()}`
      await fs.writeFile(temporary, content, 'utf8')
      await fs.rename(temporary, target)
    }
    return { path: relativeProjectPath(root, target), bytesWritten: Buffer.byteLength(content), action: append ? 'appended' : 'written' }
  }

  async function listDirectory(relativePath = '.', recursive = false) {
    const target = await resolvePath(relativePath, { mustExist: true })
    const stats = await fs.stat(target)
    if (!stats.isDirectory()) throw new Error('Path is not a directory.')
    const entries = []
    let truncated = false

    async function walk(directory, depth) {
      const remaining = MAX_LIST_ENTRIES - entries.length
      if (remaining <= 0) {
        truncated = true
        return
      }
      const result = await readBoundedDirectory(directory, remaining)
      const children = result.children
      if (result.truncated) truncated = true
      children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      for (const child of children) {
        const absolute = path.join(directory, child.name)
        const item = { name: child.name, path: relativeProjectPath(root, absolute), type: child.isDirectory() ? 'directory' : child.isFile() ? 'file' : 'other' }
        entries.push(item)
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true
          return
        }
        if (recursive && child.isDirectory() && depth < 4) await walk(absolute, depth + 1)
        if (entries.length >= MAX_LIST_ENTRIES) return
      }
    }

    await walk(target, 0)
    return { path: relativeProjectPath(root, target), entries, truncated }
  }

  async function deleteFile(relativePath) {
    const target = await resolvePath(relativePath, { mustExist: true })
    const stats = await fs.lstat(target)
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error('Only files can be deleted.')
    await fs.unlink(target)
    return { path: relativeProjectPath(root, target), deleted: true }
  }

  async function runCommand({ command, cwd = '.', timeoutMs = 30000 } = {}) {
    if (typeof command !== 'string' || !command.trim()) throw new Error('A command is required.')
    if (command.length > 10000) throw new Error('Command is too long.')
    const blocked = dangerousCommands.find(({ pattern }) => pattern.test(command))
    if (blocked) throw new Error(blocked.reason)
    const workingDirectory = await resolvePath(cwd, { mustExist: true })
    if (!(await fs.stat(workingDirectory)).isDirectory()) throw new Error('Command working directory is not a directory.')

    const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 30000, 120000))
    const shell = process.platform === 'win32' ? process.env.ComSpec || 'powershell.exe' : process.env.SHELL || '/bin/bash'
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command]
    return runProcess(shell, args, { cwd: workingDirectory, env: safeEnvironment(), timeout, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true })
  }

  async function execute(toolName, input = {}) {
    switch (toolName) {
      case 'read_file': return readFile(input.path)
      case 'write_file': return writeFile(input.path, input.content, false)
      case 'append_file': return writeFile(input.path, input.content, true)
      case 'list_files': return listDirectory(input.path || '.', Boolean(input.recursive))
      case 'delete_file': return deleteFile(input.path)
      case 'run_command': return runCommand(input)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  return { root, resolvePath, readFile, writeFile, listDirectory, deleteFile, runCommand, execute }
}
