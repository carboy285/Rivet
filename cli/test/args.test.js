import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, normalizeBaseUrl } from '../args.js'

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
  assert.equal(normalizeBaseUrl('http://10.0.0.5:1234/'), 'http://10.0.0.5:1234/v1')
  assert.equal(normalizeBaseUrl('10.0.0.5:1234'), 'http://10.0.0.5:1234/v1')
  assert.equal(normalizeBaseUrl('http://10.0.0.5:1234/v1'), 'http://10.0.0.5:1234/v1')
  assert.equal(normalizeBaseUrl('http://proxy.local/openai/v1'), 'http://proxy.local/openai/v1')
  assert.equal(parseArgs(['--url', 'http://127.0.0.1:1234']).url, 'http://127.0.0.1:1234/v1')
  assert.throws(() => normalizeBaseUrl('http://'), /Invalid server URL/)
})

test('CLI rejects unsafe or malformed option values', () => {
  assert.throws(() => parseArgs(['--temperature', '2']), /between 0 and 1/)
  assert.throws(() => parseArgs(['--max-tokens', '12']), /between 128 and 32768/)
  assert.throws(() => parseArgs(['--wat']), /Unknown option/)
})
