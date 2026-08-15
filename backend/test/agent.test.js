import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createToolRuntime } from '../tools/runtime.js'
import { runCodingAgent, summarizeConversation } from '../services/lm-studio.js'

const settings = { systemPrompt: 'Test prompt', model: 'test-model', temperature: 0, maxTokens: 512 }

test('agent streams text events from an SSE completion', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}',
    'data: {"choices":[{"delta":{"content":"world"},"finish_reason":"stop"}]}',
    'data: [DONE]',
    '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
  try {
    const events = []
    const runtime = { execute: async () => ({}) }
    await runCodingAgent({ baseUrl: 'http://test/v1', messages: [{ role: 'user', content: 'Hi' }], settings, runtime, onEvent: (event) => events.push(event) })
    assert.equal(events.filter((event) => event.type === 'text').map((event) => event.content).join(''), 'Hello world')
    assert.equal(events.at(-1).type, 'done')
  } finally { globalThis.fetch = originalFetch }
})

test('summarizeConversation omits tools from the request and returns the summary text', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Summary text' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    const summary = await summarizeConversation({
      baseUrl: 'http://test/v1',
      model: 'test-model',
      conversation: [{ role: 'user', content: 'Do X' }, { role: 'assistant', content: 'Did X' }],
      maxTokens: 4096,
    })
    assert.equal(summary, 'Summary text')
    assert.equal('tools' in capturedBody, false)
    assert.equal('tool_choice' in capturedBody, false)
  } finally { globalThis.fetch = originalFetch }
})

test('summarizeConversation rejects an empty summary', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      summarizeConversation({ baseUrl: 'http://test/v1', model: 'test-model', conversation: [{ role: 'user', content: 'Hi' }], maxTokens: 4096 }),
      /empty summary/,
    )
  } finally { globalThis.fetch = originalFetch }
})

test('agent executes tool calls and continues to a final answer', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-loop-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const runtime = await createToolRuntime(directory)
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"hello.txt","content":"hello"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { role: 'assistant', content: 'Created hello.txt.' }, finish_reason: 'stop' }] },
  ]
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), { headers: { 'content-type': 'application/json' } })
  try {
    const events = []
    await runCodingAgent({ baseUrl: 'http://test/v1', messages: [{ role: 'user', content: 'Create a file' }], settings, runtime, onEvent: (event) => events.push(event) })
    assert.equal(await fs.readFile(path.join(directory, 'hello.txt'), 'utf8'), 'hello')
    assert.ok(events.some((event) => event.type === 'tool_call' && event.toolName === 'write_file'))
    assert.ok(events.some((event) => event.type === 'tool_result' && !event.isError))
    assert.ok(events.some((event) => event.type === 'text' && event.content === 'Created hello.txt.'))
  } finally { globalThis.fetch = originalFetch }
})

test('agent rejects a response whose declared size exceeds the local limit', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'small body' }, finish_reason: 'stop' }],
  }), {
    headers: {
      'content-type': 'application/json',
      'content-length': String(9 * 1024 * 1024),
    },
  })
  try {
    await assert.rejects(
      runCodingAgent({
        baseUrl: 'http://test/v1',
        messages: [{ role: 'user', content: 'Hi' }],
        settings,
        runtime: { execute: async () => ({}) },
        onEvent: () => {},
      }),
      /response exceeds the 8 MB limit/i,
    )
  } finally { globalThis.fetch = originalFetch }
})

test('agent rejects an oversized response even without Content-Length', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024))
      controller.enqueue(new Uint8Array(1))
      controller.close()
    },
  }), { headers: { 'content-type': 'application/json' } })
  try {
    await assert.rejects(
      runCodingAgent({
        baseUrl: 'http://test/v1',
        messages: [{ role: 'user', content: 'Hi' }],
        settings,
        runtime: { execute: async () => ({}) },
        onEvent: () => {},
      }),
      /response exceeds the 8 MB limit/i,
    )
  } finally { globalThis.fetch = originalFetch }
})

test('agent rejects oversized SSE lines', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('data: ' + 'x'.repeat(1024 * 1024) + '\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
  try {
    await assert.rejects(
      runCodingAgent({
        baseUrl: 'http://test/v1',
        messages: [{ role: 'user', content: 'Hi' }],
        settings,
        runtime: { execute: async () => ({}) },
        onEvent: () => {},
      }),
      /SSE line exceeds the 1 MB limit/i,
    )
  } finally { globalThis.fetch = originalFetch }
})

test('agent rejects too many tool calls and oversized tool arguments', async () => {
  const originalFetch = globalThis.fetch
  const toolCall = (index, argumentsValue = '{}') => ({
    id: 'call_' + index,
    type: 'function',
    function: { name: 'read_file', arguments: argumentsValue },
  })
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: Array.from({ length: 33 }, (_, index) => toolCall(index)) }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall(0, 'x'.repeat(2 * 1024 * 1024 + 1))] }, finish_reason: 'tool_calls' }] },
  ]
  globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
    headers: { 'content-type': 'application/json' },
  })
  const request = () => runCodingAgent({
    baseUrl: 'http://test/v1',
    messages: [{ role: 'user', content: 'Hi' }],
    settings,
    runtime: { execute: async () => ({}) },
    onEvent: () => {},
  })
  try {
    await assert.rejects(request(), /too many tool calls/i)
    await assert.rejects(request(), /tool arguments exceed the local limit/i)
  } finally { globalThis.fetch = originalFetch }
})

test('agent rejects sparse or excessive streamed tool-call indexes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1000,"id":"call_1","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
    '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
  try {
    await assert.rejects(
      runCodingAgent({
        baseUrl: 'http://test/v1',
        messages: [{ role: 'user', content: 'Hi' }],
        settings,
        runtime: { execute: async () => ({}) },
        onEvent: () => {},
      }),
      /tool-call index/i,
    )
  } finally { globalThis.fetch = originalFetch }
})
