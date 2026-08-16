import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { approvalCard, banner, sanitizeTerminalText, toolDescription, toolResultDescription } from '../ui.js'

test('approval card displays the complete command and execution context', () => {
  const command = 'printf safe; '.repeat(20) + 'printf MALICIOUS_SUFFIX'
  const card = approvalCard('run_command', { command, cwd: 'packages/app', timeoutMs: 45000 })

  assert.match(card, /MALICIOUS_SUFFIX/)
  assert.match(card, /packages\/app/)
  assert.match(card, /45000/)
  assert.doesNotMatch(card, /…/)
})

test('approval card displays exact write content without executing terminal controls', () => {
  const content = 'safe\n\u001b]52;c;Zm9v\u0007\u202ebackwards'
  const card = approvalCard('write_file', { path: 'src/file.js', content })

  assert.match(card, /src\/file\.js/)
  assert.match(card, /content  "safe\\n\\u001b\]52;c;Zm9v\\u0007\\u202ebackwards"/)
  assert.match(card, /\\u202e/)
  assert.equal(card.includes('\u001b]52'), false)
})

test('approval card renders a real diff for edit_file when a preview is supplied', () => {
  const input = { path: 'src/file.js', edits: [{ search: 'const a = 1', replace: 'const a = 2' }] }
  const preview = { path: 'src/file.js', hunks: [{ index: 1, startLine: 3, removedLines: ['const a = 1'], addedLines: ['const a = 2'] }] }
  const card = approvalCard('edit_file', input, preview)

  assert.match(card, /src\/file\.js/)
  assert.match(card, /@@ src\/file\.js:3 @@/)
  assert.match(card, /- const a = 1/)
  assert.match(card, /\+ const a = 2/)
})

test('approval card shows a warning instead of a diff when the edit preview fails', () => {
  const card = approvalCard('edit_file', { path: 'src/file.js', edits: [{ search: 'missing', replace: 'x' }] }, { error: 'search text was not found in src/file.js.' })
  assert.match(card, /this edit will fail/)
  assert.match(card, /search text was not found/)
})

test('tool description and result summaries cover edit_file', () => {
  assert.match(toolDescription('edit_file', { path: 'a.js', edits: [{ search: 'x', replace: 'y' }] }), /a\.js.*1 edit\(s\)/)
  assert.match(toolResultDescription('edit_file', { path: 'a.js', hunkCount: 2 }), /edited a\.js.*2 hunk\(s\)/)
})

test('approval card shows the timeout the runtime will actually enforce', () => {
  assert.match(approvalCard('run_command', { command: 'true', timeoutMs: 1 }), /1000 ms/)
  assert.match(approvalCard('run_command', { command: 'true', timeoutMs: 999999 }), /120000 ms/)
})

test('terminal sanitizer preserves layout but neutralizes control and bidi characters', () => {
  const result = sanitizeTerminalText('line 1\nline 2\t\u001b[2J\r\b\u009b\u202e', {
    preserveNewlines: true,
    preserveTabs: true,
  })

  assert.match(result, /^line 1\nline 2\t/)
  assert.match(result, /\\x1b\[2J\\x0d\\x08\\x9b\\u202e$/)
  assert.doesNotMatch(result, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
})

test('the real stream and banner sinks render remote controls inertly', () => {
  const script = [
    'import { createStreamRenderer } from "./cli/ui.js"',
    'const renderer = createStreamRenderer()',
    'renderer.feed("safe\\u001b]52;c;Zm9v\\u0007")',
    'renderer.end()',
  ].join(';')
  const streamed = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const renderedBanner = banner({
    project: '/tmp/project',
    url: 'http://localhost:1234/v1',
    model: 'model\u001b[2J',
    connected: true,
    version: '1.0.0',
    approveAll: false,
    allModels: [{ id: 'other\u001b]52;c;Zm9v\u0007', state: 'loaded' }],
  })

  assert.match(streamed, /safe\\x1b]52;c;Zm9v\\x07/)
  assert.match(renderedBanner, /model\\x1b\[2J/)
  assert.equal(streamed.includes('\u001b]52'), false)
  assert.equal(renderedBanner.includes('\u001b]52'), false)
})
