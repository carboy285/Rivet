import test from 'node:test'
import assert from 'node:assert/strict'
import { HELP, VERSION, parseArgs, normalizeBaseUrl } from '../args.js'

test('CLI help uses the Rivet brand and command', () => {
  assert.match(HELP, new RegExp(`^Rivet ${VERSION.replace(/\./g, '\\.')}`, 'm'))
  assert.match(HELP, /^  rivet \[project\] \[options\]$/m)
})

test('CLI parses a project, model settings, prompt, and approval mode', () => {
  const result = parseArgs(['/tmp/project', '--model', 'qwen', '--temperature=0.4', '--max-tokens', '2048', '-p', 'Fix tests', '--yes'])
  assert.equal(result.project, '/tmp/project')
  assert.equal(result.model, 'qwen')
  assert.equal(result.temperature, 0.4)
  assert.equal(result.maxTokens, 2048)
  assert.equal(result.prompt, 'Fix tests')
  assert.equal(result.yes, true)
})

test('server URLs get the /v1 path LM Studio actually serves', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1')
  assert.equal(normalizeBaseUrl('https://10.0.0.5:1234/'), 'https://10.0.0.5:1234/v1')
  assert.equal(normalizeBaseUrl('https://proxy.example/openai/v1'), 'https://proxy.example/openai/v1')
  assert.throws(() => normalizeBaseUrl('10.0.0.5:1234'), /HTTPS/)
  assert.equal(
    normalizeBaseUrl('10.0.0.5:1234', { allowInsecureRemote: true }),
    'http://10.0.0.5:1234/v1',
  )
  assert.equal(parseArgs(['--url', 'http://127.0.0.1:1234']).url, 'http://127.0.0.1:1234/v1')
  assert.throws(() => parseArgs(['--url', 'http://10.0.0.5:1234']), /allow-insecure-http/)
  assert.equal(
    parseArgs(['--url', 'http://10.0.0.5:1234', '--allow-insecure-http']).url,
    'http://10.0.0.5:1234/v1',
  )
  assert.throws(() => normalizeBaseUrl('http://'), /Invalid server URL/)
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /HTTP or HTTPS/)
  assert.throws(() => normalizeBaseUrl('http://localhost.evil:1234'), /HTTPS/)
  assert.throws(() => normalizeBaseUrl('http://user:secret@localhost:1234'), /credentials/)
})

test('CLI rejects unsafe or malformed option values', () => {
  assert.throws(() => parseArgs(['--temperature', '2']), /between 0 and 1/)
  assert.throws(() => parseArgs(['--max-tokens', '12']), /between 128 and 32768/)
  assert.throws(() => parseArgs(['--wat']), /Unknown option/)
})
