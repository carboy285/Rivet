import { stdin, stdout } from 'node:process'

const colorEnabled = Boolean(stdout.isTTY && !process.env.NO_COLOR)
const unicodeEnabled = process.platform !== 'win32' || Boolean(process.env.WT_SESSION)
const paint = (code, value) => colorEnabled ? `\u001b[${code}m${value}\u001b[0m` : String(value)

export const ui = {
  accent: (value) => paint('38;2;209;255;84', value),
  cyan: (value) => paint('36', value),
  blue: (value) => paint('38;5;75', value),
  green: (value) => paint('32', value),
  yellow: (value) => paint('33', value),
  red: (value) => paint('31', value),
  bold: (value) => paint('1', value),
  muted: (value) => paint('2', value),
}

/** Box drawing and status glyphs, with ASCII fallbacks for terminals without UTF-8. */
export const glyph = unicodeEnabled
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', dot: '●', ring: '○', ok: '✓', fail: '✗', warn: '!', arrow: '❯', tool: '›', bullet: '·', diamond: '◆', pipe: '│', corner: '└' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', dot: '*', ring: 'o', ok: 'v', fail: 'x', warn: '!', arrow: '>', tool: '>', bullet: '-', diamond: '*', pipe: '|', corner: '`' }

const SPINNER_FRAMES = unicodeEnabled ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['|', '/', '-', '\\']

export const INDENT = '  '

export function terminalWidth() {
  return Math.max(40, Math.min(stdout.columns || 80, 100))
}

/** Visible length, ignoring ANSI escape sequences. */
export function displayWidth(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '').length
}

/** Wipe the visible screen and the scrollback buffer, then home the cursor. */
export function clearScreen() {
  if (!stdout.isTTY) return
  stdout.write('\u001b[2J\u001b[3J\u001b[H')
}

/** A heading followed by a hairline rule, used by /status, /config, /doctor, /usage. */
export function heading(title) {
  const line = `${INDENT}${ui.bold(title.toUpperCase())} `
  const fill = Math.max(0, terminalWidth() - displayWidth(line) - INDENT.length)
  return `\n${line}${ui.muted(glyph.h.repeat(fill))}\n`
}

/** Aligned label/value rows. Rows are [label, value] or [label, value, note]. */
export function rows(entries) {
  const labelWidth = entries.reduce((max, [label]) => Math.max(max, label.length), 0)
  return entries
    .map(([label, value, note]) => `${INDENT}${ui.muted(label.padEnd(labelWidth))}  ${value}${note ? ` ${ui.muted(note)}` : ''}\n`)
    .join('')
}

export function section(title, entries) {
  return `${heading(title)}${rows(entries)}\n`
}

export function statusLine(kind, message, detail = '') {
  const marks = {
    ok: ui.green(glyph.ok),
    fail: ui.red(glyph.fail),
    warn: ui.yellow(glyph.warn),
    info: ui.blue(glyph.bullet),
  }
  return `${INDENT}${marks[kind] || marks.info} ${message}${detail ? ` ${ui.muted(detail)}` : ''}\n`
}

export function errorLine(message) {
  return `${INDENT}${ui.red(glyph.fail)} ${ui.red('error')} ${message}\n`
}

export function usageLine(usage) {
  return `${INDENT}${ui.yellow(glyph.warn)} ${ui.muted('usage')} ${usage}\n`
}

function clip(value, length = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function formatBytes(bytes) {
  const size = Number(bytes) || 0
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export function toolDescription(name, input = {}) {
  if (name === 'run_command') return clip(input.command)
  if (name === 'list_files') return input.path || '.'
  if (name === 'write_file' || name === 'append_file') return `${input.path || '?'} ${glyph.bullet} ${formatBytes(Buffer.byteLength(input.content || ''))}`
  return input.path || ''
}

export function toolResultDescription(name, result = {}, isError = false) {
  if (isError) return result.error || 'failed'
  if (name === 'read_file') return `${result.path} ${glyph.bullet} ${formatBytes(result.size)}`
  if (name === 'list_files') return `${result.entries?.length || 0} entries${result.truncated ? ' (truncated)' : ''}`
  if (name === 'run_command') return `exit ${result.exitCode}`
  if (name === 'delete_file') return `deleted ${result.path}`
  if (name === 'write_file' || name === 'append_file') return `${result.action} ${result.path}`
  return 'complete'
}

/** `  › run_command  npm test` */
export function toolCallLine(name, input) {
  const detail = toolDescription(name, input)
  return `${INDENT}${ui.cyan(glyph.tool)} ${ui.bold(name)}${detail ? `  ${ui.muted(detail)}` : ''}\n`
}

/** `  └ ✓ exit 0 · 120ms` indented under its call. */
export function toolResultLine(name, result, isError, elapsedMs) {
  const mark = isError ? ui.red(glyph.fail) : ui.green(glyph.ok)
  const detail = toolResultDescription(name, result, isError)
  const timing = Number.isFinite(elapsedMs) ? ` ${ui.muted(`${glyph.bullet} ${formatDuration(elapsedMs)}`)}` : ''
  return `${INDENT}${ui.muted(glyph.corner)} ${mark} ${isError ? ui.red(detail) : ui.muted(detail)}${timing}\n`
}

export function banner({ project, url, model, connected, version, approveAll }) {
  const width = terminalWidth()
  const inner = width - INDENT.length * 2 - 2
  const title = ` ${glyph.diamond} LOCAL CODING AGENT`
  const versionTag = `v${version} `
  const padding = Math.max(1, inner - title.length - versionTag.length)
  const top = `${INDENT}${ui.muted(glyph.tl + glyph.h.repeat(inner) + glyph.tr)}\n`
  const middle = `${INDENT}${ui.muted(glyph.v)}${ui.accent(ui.bold(title))}${' '.repeat(padding)}${ui.muted(versionTag)}${ui.muted(glyph.v)}\n`
  const bottom = `${INDENT}${ui.muted(glyph.bl + glyph.h.repeat(inner) + glyph.br)}\n`

  const modelValue = connected
    ? `${model}  ${ui.green(`${glyph.dot} connected`)}`
    : `${model}  ${ui.yellow(`${glyph.ring} LM Studio offline`)}`

  const body = rows([
    ['project', project],
    ['model', modelValue],
    ['server', url],
    ['approvals', approveAll ? ui.yellow('auto-approved for this session') : 'ask before changes'],
  ])

  const hint = `${INDENT}${ui.accent('/help')} ${ui.muted('for commands')} ${ui.muted(glyph.bullet)} ${ui.accent('/clear')} ${ui.muted('to reset the screen')} ${ui.muted(glyph.bullet)} ${ui.accent('ctrl+c')} ${ui.muted('to interrupt')}\n`
  return `\n${top}${middle}${bottom}\n${body}\n${hint}\n`
}

export function promptLabel() {
  return `${ui.accent(ui.bold(glyph.arrow))} `
}

export function agentLabel() {
  return `\n${INDENT}${ui.accent(glyph.diamond)} ${ui.muted('agent')}\n`
}

/**
 * Streams model output into a fixed-width, indented column so long paragraphs
 * stay readable instead of wrapping flush against the terminal edge.
 */
export function createStreamRenderer({ indent = INDENT, width = terminalWidth() } = {}) {
  // Piped output stays byte-for-byte what the model produced.
  if (!stdout.isTTY) {
    let trailingNewline = true
    return {
      feed(text) {
        const value = String(text)
        if (!value) return
        trailingNewline = value.endsWith('\n')
        stdout.write(value)
      },
      end() {
        if (!trailingNewline) stdout.write('\n')
        trailingNewline = true
      },
    }
  }

  const limit = Math.max(20, width - indent.length)
  let column = 0
  let word = ''
  let pendingSpace = false

  function newline() {
    stdout.write('\n')
    column = 0
    pendingSpace = false
  }

  /**
   * Spaces are held back until the next word arrives, so a line that wraps or
   * ends never carries trailing whitespace.
   */
  function pushWord() {
    if (!word) return
    const needed = word.length + (pendingSpace ? 1 : 0)
    if (column > 0 && column + needed > limit) newline()
    if (column === 0) stdout.write(indent)
    else if (pendingSpace) { stdout.write(' '); column += 1 }
    pendingSpace = false
    while (word.length > limit) {
      stdout.write(word.slice(0, limit - column))
      word = word.slice(limit - column)
      newline()
      stdout.write(indent)
    }
    stdout.write(word)
    column += word.length
    word = ''
  }

  return {
    feed(text) {
      for (const character of String(text)) {
        if (character === '\n') { pushWord(); newline() } else if (character === ' ' || character === '\t') {
          pushWord()
          if (column > 0) pendingSpace = true
        } else word += character
      }
    },
    end() {
      pushWord()
      if (column > 0) newline()
    },
  }
}

/** Braille spinner shown while waiting on the model; a no-op off a TTY. */
export function createSpinner(label) {
  let timer = null
  let frame = 0
  let startedAt = 0

  function clearLine() {
    if (stdout.isTTY) stdout.write('\r\u001b[2K')
  }

  return {
    start() {
      if (!stdout.isTTY || timer) return
      startedAt = Date.now()
      stdout.write('\u001b[?25l')
      timer = setInterval(() => {
        const elapsed = formatDuration(Date.now() - startedAt)
        clearLine()
        stdout.write(`${INDENT}${ui.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${ui.muted(`${label} ${glyph.bullet} ${elapsed}`)}`)
        frame += 1
      }, 90)
      timer.unref?.()
    },
    stop() {
      if (!timer) return
      clearInterval(timer)
      timer = null
      clearLine()
      stdout.write('\u001b[?25h')
    },
  }
}

/** Multi-line approval card; the caller appends its own readline question. */
export function approvalCard(name, input) {
  const detail = toolDescription(name, input)
  return `\n${INDENT}${ui.yellow(glyph.tl + glyph.h.repeat(3))} ${ui.yellow(ui.bold('approval required'))}\n`
    + `${INDENT}${ui.yellow(glyph.v)}  ${ui.bold(name)}${detail ? `  ${ui.muted(detail)}` : ''}\n`
}

export function approvalQuestion() {
  const options = `${ui.bold('y')}${ui.muted('es')} ${ui.muted(glyph.bullet)} ${ui.bold('n')}${ui.muted('o')} ${ui.muted(glyph.bullet)} ${ui.bold('a')}${ui.muted('lways')}`
  return `${INDENT}${ui.yellow(glyph.bl)}  ${options} ${ui.yellow(glyph.arrow)} `
}

/**
 * Interactive arrow-key picker. Renders a list once, then redraws in place as
 * ↑/↓ move focus; enter resolves with the highlighted item, esc/ctrl-c with
 * null. Pauses the readline interface (if given) so its keypress handling does
 * not fight with ours, and restores raw mode + cursor on exit.
 */
export async function selectFromList({ terminal, title, items, currentId, hint }) {
  if (!stdout.isTTY || !stdin.isTTY || !items.length) return null

  return new Promise((resolve) => {
    const startIndex = items.findIndex((item) => item.id === currentId)
    let focused = startIndex >= 0 ? startIndex : 0
    const wasRaw = Boolean(stdin.isRaw)
    let lastLineCount = 0
    const cols = stdout.columns || 80

    function build() {
      const labelWidth = Math.max(20, cols - 12)
      const parts = []
      if (title) parts.push(heading(title))
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        const isFocused = index === focused
        const isCurrent = item.id === currentId
        const marker = isFocused ? ui.accent(glyph.dot) : ui.muted(glyph.ring)
        const label = clip(item.label, labelWidth)
        const text = isFocused ? ui.bold(ui.accent(label)) : (isCurrent ? ui.bold(label) : label)
        const note = isCurrent ? ` ${ui.muted('(loaded)')}` : ''
        parts.push(`${INDENT}${marker} ${text}${note}\n`)
      }
      parts.push(`\n${INDENT}${ui.muted(hint || `${glyph.arrow} ↑/↓ move  ${glyph.bullet} enter select  ${glyph.bullet} esc cancel`)}\n`)
      return parts.join('')
    }

    function render(first) {
      if (!first && lastLineCount > 0) stdout.write(`[${lastLineCount}A\r[J`)
      const output = build()
      stdout.write(output)
      // Count trailing newlines to know how many lines to walk back on next redraw.
      lastLineCount = (output.match(/\n/g) || []).length
    }

    function cleanup() {
      stdin.removeListener('keypress', onKey)
      if (stdin.setRawMode) stdin.setRawMode(wasRaw)
      stdout.write('[?25h')
      terminal?.resume?.()
    }

    function onKey(_char, key) {
      if (!key) return
      if (key.name === 'up' || key.name === 'k') {
        focused = (focused - 1 + items.length) % items.length
        render(false)
      } else if (key.name === 'down' || key.name === 'j') {
        focused = (focused + 1) % items.length
        render(false)
      } else if (key.name === 'home') {
        focused = 0
        render(false)
      } else if (key.name === 'end') {
        focused = items.length - 1
        render(false)
      } else if (key.name === 'return') {
        cleanup()
        resolve(items[focused])
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup()
        resolve(null)
      }
    }

    terminal?.pause?.()
    if (stdin.setRawMode) stdin.setRawMode(true)
    stdin.resume()
    stdout.write('[?25l')
    stdin.on('keypress', onKey)
    render(true)
  })
}

/** Two-column command list used by /help. */
export function commandTable(entries) {
  const labels = entries.map((entry) => [entry.name, ...(entry.aliases || [])].join(', '))
  const labelWidth = labels.reduce((max, label) => Math.max(max, label.length), 0)
  return entries
    .map((entry, index) => `${INDENT}${ui.accent(labels[index].padEnd(labelWidth))}  ${ui.muted(entry.summary)}\n`)
    .join('')
}
