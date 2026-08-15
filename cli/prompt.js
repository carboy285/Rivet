import { stdin, stdout } from 'node:process'
import readline from 'node:readline'
import { ui, glyph, INDENT, terminalWidth, displayWidth, clearScreen } from './ui.js'

// Enable keypress decoding on stdin without owning a readline interface —
// we run our own line editor so we can render a live picker above the prompt.
readline.emitKeypressEvents(stdin)

const MAX_PICKER_ROWS = 8
const HISTORY_MAX = 500

function clip(value, length) {
  const text = String(value ?? '')
  if (text.length <= length) return text
  return `${text.slice(0, Math.max(0, length - 1))}…`
}

function commandLabel(cmd) {
  return [cmd.name, ...(cmd.aliases || [])].join(', ')
}

function filterCommands(buffer, commands) {
  if (!buffer.startsWith('/')) return []
  // Once the user types a space they are working on arguments — get out of
  // the way so the picker does not fight their typing.
  if (buffer.indexOf(' ') !== -1) return []
  const query = buffer.toLowerCase()
  const matches = []
  for (const cmd of commands) {
    const names = [cmd.name, ...(cmd.aliases || [])]
    if (names.some((name) => name.toLowerCase().startsWith(query))) matches.push(cmd)
  }
  return matches
}

/**
 * Custom line reader with a live slash-command picker.
 *
 * Returns a session with:
 *   ask(prompt)      – full reader with history + picker (main prompt loop)
 *   question(prompt) – one-shot answer, no picker, no history (approvals)
 *
 * Both return the entered string on Enter, or null on Ctrl+D / Ctrl+C on
 * an empty buffer so the caller can shut down cleanly. Ctrl+C with content
 * clears the buffer, matching common shell behavior.
 */
export function createPromptSession({ getCommands = () => [], onClearScreen } = {}) {
  const history = []
  return {
    ask(promptString) {
      return readLine({ promptString, commands: getCommands(), history, onClearScreen, allowPicker: true, addHistory: true })
    },
    question(promptString) {
      return readLine({ promptString, commands: [], history: [], onClearScreen, allowPicker: false, addHistory: false })
    },
  }
}

function readLine({ promptString, commands, history, onClearScreen, allowPicker, addHistory }) {
  return new Promise((resolve) => {
    let buffer = ''
    let cursor = 0
    let historyIndex = 0     // 0 = live draft; 1..len = past entries counted from the end
    let draft = ''
    let focused = 0
    // Lines drawn above the input row on the previous render — the reader
    // walks back over this many rows before each redraw so the picker never
    // leaves debris behind.
    let linesAbove = 0

    const wasRaw = Boolean(stdin.isRaw)
    if (stdin.setRawMode) stdin.setRawMode(true)
    stdin.resume()

    function matches() {
      return allowPicker ? filterCommands(buffer, commands) : []
    }

    function eraseDrawn() {
      if (linesAbove > 0) stdout.write(`\r[${linesAbove}A[J`)
      else stdout.write(`\r[2K`)
    }

    function renderPickerRows(list) {
      const width = terminalWidth()
      const total = Math.min(list.length, MAX_PICKER_ROWS)
      // Keep the focused row roughly centered in the visible window when
      // there are more matches than we can show at once.
      let start = Math.max(0, focused - Math.floor(total / 2))
      start = Math.min(start, list.length - total)
      start = Math.max(0, start)
      const visible = list.slice(start, start + total)
      const labelWidth = visible.reduce((max, cmd) => Math.max(max, commandLabel(cmd).length), 0)
      const rows = []
      for (let i = 0; i < visible.length; i += 1) {
        const cmd = visible[i]
        const globalIndex = start + i
        const isFocused = globalIndex === focused
        const label = commandLabel(cmd).padEnd(labelWidth)
        const marker = isFocused ? ui.accent(glyph.arrow) : ' '
        const name = isFocused ? ui.bold(ui.accent(label)) : ui.accent(label)
        // Reserve room for indent + marker + gap + label + double-space gap,
        // then clip the summary so the row never wraps and blows up our
        // line accounting.
        const budget = Math.max(10, width - INDENT.length - 2 - labelWidth - 2)
        const summary = cmd.summary ? ui.muted(clip(cmd.summary, budget)) : ''
        rows.push(`${INDENT}${marker} ${name}  ${summary}`)
      }
      return rows
    }

    function draw(first) {
      const list = matches()
      if (!first) eraseDrawn()

      const pickerRows = list.length ? renderPickerRows(list) : []
      if (pickerRows.length) stdout.write(`${pickerRows.join('\n')}\n`)

      stdout.write(`${promptString}${buffer}`)
      const trailing = buffer.length - cursor
      if (trailing > 0) stdout.write(`[${trailing}D`)

      linesAbove = pickerRows.length
    }

    function finish(value) {
      stdin.removeListener('keypress', onKey)
      if (stdin.setRawMode) stdin.setRawMode(wasRaw)
      eraseDrawn()
      // Re-print the final input line without the picker so scrollback shows
      // what the user actually submitted.
      stdout.write(`${promptString}${value ?? ''}\n`)
      if (addHistory && value) {
        if (!history.length || history[history.length - 1] !== value) {
          history.push(value)
          if (history.length > HISTORY_MAX) history.shift()
        }
      }
      resolve(value)
    }

    function cancel() {
      stdin.removeListener('keypress', onKey)
      if (stdin.setRawMode) stdin.setRawMode(wasRaw)
      eraseDrawn()
      stdout.write(`${promptString}\n`)
      resolve(null)
    }

    function onKey(str, key) {
      if (!key) return

      if (key.ctrl && key.name === 'c') {
        if (buffer.length === 0) { cancel(); return }
        buffer = ''
        cursor = 0
        historyIndex = 0
        focused = 0
        draw(false)
        return
      }
      if (key.ctrl && key.name === 'd' && buffer.length === 0) { cancel(); return }
      if (key.ctrl && key.name === 'l') {
        clearScreen()
        onClearScreen?.()
        linesAbove = 0
        draw(true)
        return
      }

      const list = matches()

      if (key.name === 'return') {
        // Empty picker query with focused item → submit the picked command.
        let value = buffer
        if (list.length && buffer.startsWith('/') && buffer.indexOf(' ') === -1) {
          value = list[focused].name
        }
        finish(value)
        return
      }
      if (key.name === 'tab') {
        if (list.length) {
          const pick = list[focused]
          buffer = pick.name
          cursor = buffer.length
          focused = 0
          draw(false)
        }
        return
      }
      if (key.name === 'escape') {
        if (list.length || buffer.length) {
          buffer = ''
          cursor = 0
          historyIndex = 0
          focused = 0
          draw(false)
        }
        return
      }
      if (key.name === 'up') {
        if (list.length > 1) {
          focused = (focused - 1 + list.length) % list.length
          draw(false)
        } else if (history.length && historyIndex < history.length) {
          if (historyIndex === 0) draft = buffer
          historyIndex += 1
          buffer = history[history.length - historyIndex]
          cursor = buffer.length
          draw(false)
        }
        return
      }
      if (key.name === 'down') {
        if (list.length > 1) {
          focused = (focused + 1) % list.length
          draw(false)
        } else if (historyIndex > 0) {
          historyIndex -= 1
          buffer = historyIndex === 0 ? draft : history[history.length - historyIndex]
          cursor = buffer.length
          draw(false)
        }
        return
      }
      if (key.name === 'left') {
        if (cursor > 0) { cursor -= 1; draw(false) }
        return
      }
      if (key.name === 'right') {
        if (cursor < buffer.length) { cursor += 1; draw(false) }
        return
      }
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) { cursor = 0; draw(false); return }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) { cursor = buffer.length; draw(false); return }
      if (key.name === 'backspace') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor)
          cursor -= 1
          historyIndex = 0
          focused = 0
          draw(false)
        }
        return
      }
      if (key.name === 'delete') {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1)
          historyIndex = 0
          focused = 0
          draw(false)
        }
        return
      }
      if (key.ctrl && key.name === 'u') {
        buffer = buffer.slice(cursor)
        cursor = 0
        historyIndex = 0
        focused = 0
        draw(false)
        return
      }
      if (key.ctrl && key.name === 'k') {
        buffer = buffer.slice(0, cursor)
        historyIndex = 0
        focused = 0
        draw(false)
        return
      }
      if (key.ctrl && key.name === 'w') {
        let i = cursor
        while (i > 0 && /\s/.test(buffer[i - 1])) i -= 1
        while (i > 0 && !/\s/.test(buffer[i - 1])) i -= 1
        buffer = buffer.slice(0, i) + buffer.slice(cursor)
        cursor = i
        historyIndex = 0
        focused = 0
        draw(false)
        return
      }

      // Insert printable characters (also handles bracketed paste, which
      // arrives as a single multi-char keypress with no key.name).
      if (str && !key.ctrl && !key.meta) {
        const clean = str.replace(/[\r\n\t]/g, '')
        if (clean) {
          buffer = buffer.slice(0, cursor) + clean + buffer.slice(cursor)
          cursor += clean.length
          historyIndex = 0
          focused = 0
          draw(false)
        }
      }
    }

    stdin.on('keypress', onKey)
    draw(true)
  })
}

// Exposed for unit tests.
export const _internal = { filterCommands, commandLabel, clip }
