import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export function defaultConfigRoot() {
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'Rivet')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Rivet')
  if (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)) {
    return path.join(process.env.XDG_CONFIG_HOME, 'rivet')
  }
  return path.join(os.homedir(), '.config', 'rivet')
}

export function projectId(projectRoot) {
  return createHash('sha256').update(path.resolve(projectRoot)).digest('hex')
}
