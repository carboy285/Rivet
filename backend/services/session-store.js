import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultConfigRoot, projectId } from '../lib/config-root.js'

const MAX_LISTED_SESSIONS = 20

export function sessionDirectoryForProject(projectRoot, configRoot = defaultConfigRoot()) {
  return path.join(path.resolve(configRoot), 'sessions', projectId(projectRoot))
}

export function createSessionStore(projectRoot, { configRoot = defaultConfigRoot() } = {}) {
  const directory = sessionDirectoryForProject(projectRoot, configRoot)

  function sessionPath(id) {
    return path.join(directory, `${id}.json`)
  }

  async function save(session) {
    if (!session?.id || typeof session.id !== 'string') throw new Error('A session id is required.')
    if (!Array.isArray(session.messages)) throw new Error('Session messages must be an array.')
    const target = sessionPath(session.id)
    const now = new Date().toISOString()
    let createdAt = now
    try {
      const existing = JSON.parse(await fs.readFile(target, 'utf8'))
      if (typeof existing.createdAt === 'string') createdAt = existing.createdAt
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const record = {
      id: session.id,
      projectPath: typeof session.projectPath === 'string' ? session.projectPath : path.resolve(projectRoot),
      model: typeof session.model === 'string' ? session.model : '',
      title: typeof session.title === 'string' && session.title.trim() ? session.title.trim().slice(0, 200) : 'Untitled',
      createdAt,
      updatedAt: now,
      messages: session.messages,
    }

    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    let renamed = false
    try {
      await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporary, target)
      renamed = true
    } finally {
      if (!renamed) await fs.unlink(temporary).catch(() => {})
    }
    return record
  }

  async function list() {
    let entries
    try {
      entries = await fs.readdir(directory)
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const summaries = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const record = JSON.parse(await fs.readFile(path.join(directory, entry), 'utf8'))
        summaries.push({
          id: record.id,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          messageCount: Array.isArray(record.messages) ? record.messages.length : 0,
        })
      } catch {
        // Skip unreadable/corrupt session files rather than failing the whole listing.
      }
    }
    summaries.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return summaries.slice(0, MAX_LISTED_SESSIONS)
  }

  async function load(id) {
    try {
      return JSON.parse(await fs.readFile(sessionPath(id), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Session not found.')
      throw error
    }
  }

  return { save, list, load }
}
