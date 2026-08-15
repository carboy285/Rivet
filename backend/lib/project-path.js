import fs from 'node:fs/promises'
import path from 'node:path'

function isInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function nearestExisting(candidate) {
  let current = candidate
  while (true) {
    try {
      await fs.access(current)
      return current
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

export async function createProjectPath(projectRoot, extraRoots = []) {
  const root = path.resolve(projectRoot)
  const realRoot = await fs.realpath(root)
  const realExtraRoots = await Promise.all(extraRoots.map((dir) => fs.realpath(path.resolve(dir))))

  async function resolveAbsolute(trimmed) {
    if (!realExtraRoots.length) {
      throw new Error('Use a path relative to the project root.')
    }

    const candidate = path.resolve(trimmed)
    const anchor = await nearestExisting(candidate)
    const realAnchor = await fs.realpath(anchor)
    if (!realExtraRoots.some((extraRoot) => isInside(extraRoot, realAnchor))) {
      throw new Error('Path escapes the project root and every added directory.')
    }

    return candidate
  }

  return async function resolveProjectPath(input = '.', { mustExist = false } = {}) {
    if (typeof input !== 'string' || input.includes('\0')) {
      throw new Error('Path must be a valid string.')
    }

    const trimmed = input.trim() || '.'
    const isAbsoluteInput = path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)

    if (isAbsoluteInput) {
      const candidate = await resolveAbsolute(trimmed)
      if (mustExist) {
        const realCandidate = await fs.realpath(candidate)
        if (!realExtraRoots.some((extraRoot) => isInside(extraRoot, realCandidate))) {
          throw new Error('Path resolves outside every added directory through a symbolic link.')
        }
      }
      return candidate
    }

    const candidate = path.resolve(root, trimmed)
    if (!isInside(root, candidate)) {
      throw new Error('Path escapes the project root.')
    }

    const anchor = await nearestExisting(candidate)
    const realAnchor = await fs.realpath(anchor)
    if (!isInside(realRoot, realAnchor)) {
      throw new Error('Path resolves outside the project root through a symbolic link.')
    }

    if (mustExist) {
      const realCandidate = await fs.realpath(candidate)
      if (!isInside(realRoot, realCandidate)) {
        throw new Error('Path resolves outside the project root through a symbolic link.')
      }
    }

    return candidate
  }
}

export function relativeProjectPath(projectRoot, absolutePath) {
  const relative = path.relative(path.resolve(projectRoot), absolutePath)
  return relative === '' ? '.' : relative.split(path.sep).join('/')
}
