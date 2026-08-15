import fs from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_SYSTEM_PROMPT = `You are an autonomous coding agent working inside the user's selected local project.

When given a task:
1. Inspect relevant files with list_files and read_file before editing
2. Implement requested changes with write_file or append_file
3. Run focused commands to test or debug the result
4. Keep all work inside the selected project
5. Briefly summarize what you changed and verified

When the user asks for a code change, perform the work with tools instead of only describing it. Be concise and focus on working code.`

export const DEFAULT_SETTINGS = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  model: 'auto',
  temperature: 0.2,
  maxTokens: 4096,
}

export function normalizeSettings(value = {}) {
  return {
    systemPrompt: typeof value.systemPrompt === 'string' && value.systemPrompt.trim() ? value.systemPrompt.slice(0, 20000) : DEFAULT_SETTINGS.systemPrompt,
    model: typeof value.model === 'string' && value.model.trim() ? value.model.trim().slice(0, 300) : 'auto',
    temperature: Math.max(0, Math.min(1, Number(value.temperature) || 0)),
    maxTokens: Math.max(128, Math.min(32768, Math.round(Number(value.maxTokens) || DEFAULT_SETTINGS.maxTokens))),
  }
}

export const DEFAULT_PREFERENCES = {
  ...DEFAULT_SETTINGS,
  verboseTools: false,
  serverUrl: '',
}

/** Settings plus the CLI-only preferences (verbose tool output, server URL) that ride along in the same file. */
export function normalizePreferences(value = {}) {
  return {
    ...normalizeSettings(value),
    verboseTools: Boolean(value.verboseTools),
    serverUrl: typeof value.serverUrl === 'string' && value.serverUrl.trim() ? value.serverUrl.trim().slice(0, 2000) : '',
  }
}

export function createSettingsStore(projectRoot) {
  const directory = path.join(projectRoot, '.local-coding-agent')
  const settingsPath = path.join(directory, 'settings.json')

  async function get() {
    try {
      const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8'))
      return normalizePreferences({ ...DEFAULT_PREFERENCES, ...saved })
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      return { ...DEFAULT_PREFERENCES }
    }
  }

  async function set(value) {
    const preferences = normalizePreferences(value)
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${settingsPath}.${process.pid}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, settingsPath)
    return preferences
  }

  return { get, set }
}
