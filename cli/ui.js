const colorEnabled = Boolean(process.stdout.isTTY && !process.env.NO_COLOR)
const paint = (code, value) => colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : String(value)

export const ui = {
  accent: (value) => paint('38;2;209;255;84', value),
  cyan: (value) => paint('36', value),
  green: (value) => paint('32', value),
  yellow: (value) => paint('33', value),
  red: (value) => paint('31', value),
  bold: (value) => paint('1', value),
  muted: (value) => paint('2', value),
}

function clip(value, length = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

export function toolDescription(name, input = {}) {
  if (name === 'run_command') return clip(input.command)
  if (name === 'list_files') return input.path || '.'
  if (name === 'write_file' || name === 'append_file') return `${input.path || '?'} (${Buffer.byteLength(input.content || '')} bytes)`
  return input.path || ''
}

export function toolResultDescription(name, result = {}, isError = false) {
  if (isError) return result.error || 'failed'
  if (name === 'read_file') return `${result.path} · ${result.size} bytes`
  if (name === 'list_files') return `${result.entries?.length || 0} entries${result.truncated ? ' (truncated)' : ''}`
  if (name === 'run_command') return `exit ${result.exitCode}`
  if (name === 'delete_file') return `deleted ${result.path}`
  if (name === 'write_file' || name === 'append_file') return `${result.action} ${result.path}`
  return 'complete'
}

export function printBanner({ project, url, model, connected }) {
  process.stdout.write(`\n${ui.accent('◆')} ${ui.bold('Local Coding Agent')} ${ui.muted('v1.0.0')}\n`)
  process.stdout.write(`  ${ui.muted('project')}  ${project}\n`)
  process.stdout.write(`  ${ui.muted('model')}    ${connected ? ui.green(model) : ui.yellow(`${model} · LM Studio offline`)}\n`)
  process.stdout.write(`  ${ui.muted('server')}   ${url}\n`)
  process.stdout.write(`\n${ui.muted('Type /help for commands. File changes and commands require approval.')}\n\n`)
}
