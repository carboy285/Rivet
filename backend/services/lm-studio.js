import { toolDefinitions } from '../tools/tool-definitions.js'

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_SSE_LINE_BYTES = 1024 * 1024
const MAX_TOOL_CALLS = 32
const MAX_TOOL_ARGUMENT_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 1000
const MAX_REQUEST_MS = 5 * 60 * 1000

function responseLimitError() {
  return new Error('LM Studio response exceeds the 8 MB limit.')
}

function requestSignal(signal) {
  const deadline = AbortSignal.timeout(MAX_REQUEST_MS)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

async function readResponseText(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw responseLimitError()
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw responseLimitError()
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

async function readResponseJson(response) {
  return JSON.parse(await readResponseText(response))
}

function appendFragment(current, value, limit, label) {
  if (value === undefined || value === null) return current
  if (typeof value !== 'string') throw new Error('LM Studio returned an invalid ' + label + '.')
  const next = current + value
  if (Buffer.byteLength(next) > limit) throw new Error('LM Studio ' + label + ' exceeds the local limit.')
  return next
}

function joinContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
}

function contentToolCalls(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((part) => ['tool_use', 'tool_call'].includes(part?.type) && (part.name || part.function?.name))
    .map((part, index) => {
      const input = part.input ?? part.function?.arguments ?? {}
      return {
        id: part.id || `content_call_${index}`,
        type: 'function',
        function: {
          name: part.name || part.function.name,
          arguments: typeof input === 'string' ? input : JSON.stringify(input),
        },
      }
    })
}

function collectToolCall(toolCalls, fragment) {
  const index = fragment.index ?? 0
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS) {
    throw new Error('LM Studio returned an invalid tool-call index.')
  }
  const current = toolCalls[index] || { id: '', type: 'function', function: { name: '', arguments: '' } }
  current.id = appendFragment(current.id, fragment.id, 1024, 'tool-call id')
  current.function.name = appendFragment(current.function.name, fragment.function?.name, 256, 'tool name')
  current.function.arguments = appendFragment(
    current.function.arguments,
    fragment.function?.arguments,
    MAX_TOOL_ARGUMENT_BYTES,
    'tool arguments',
  )
  toolCalls[index] = current
}

function validateToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return []
  if (toolCalls.length > MAX_TOOL_CALLS) throw new Error('LM Studio returned too many tool calls.')
  return toolCalls.map((call) => {
    if (!call || typeof call !== 'object' || !call.function || typeof call.function !== 'object') {
      throw new Error('LM Studio returned an invalid tool call.')
    }
    if (call.id !== undefined && typeof call.id !== 'string') throw new Error('LM Studio returned an invalid tool-call id.')
    if (typeof call.function.name !== 'string' || Buffer.byteLength(call.function.name) > 256) {
      throw new Error('LM Studio returned an invalid tool name.')
    }
    if (typeof call.function.arguments !== 'string' || Buffer.byteLength(call.function.arguments) > MAX_TOOL_ARGUMENT_BYTES) {
      throw new Error('LM Studio tool arguments exceed the local limit.')
    }
    return call
  })
}

function messageFromJson(payload, onText) {
  const choice = payload?.choices?.[0]
  if (!choice) throw new Error('LM Studio returned no completion choice.')
  const message = choice.message || {}
  const content = joinContent(message.content)
  if (content) onText(content)
  const toolCalls = message.tool_calls?.length ? message.tool_calls : contentToolCalls(message.content)
  return { content, toolCalls: validateToolCalls(toolCalls), finishReason: choice.finish_reason }
}

async function streamMessage(response, onText) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw responseLimitError()
  if (!response.body) throw new Error('LM Studio returned an empty response body.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const toolCalls = []
  let content = ''
  let buffer = ''
  let finishReason = null
  let totalBytes = 0

  function consumeLine(line) {
    if (Buffer.byteLength(line) > MAX_SSE_LINE_BYTES) throw new Error('LM Studio SSE line exceeds the 1 MB limit.')
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return
    const payload = JSON.parse(data)
    const choice = payload.choices?.[0]
    if (!choice) return
    const deltaText = joinContent(choice.delta?.content)
    if (deltaText) {
      content += deltaText
      onText(deltaText)
    }
    for (const fragment of choice.delta?.tool_calls || []) collectToolCall(toolCalls, fragment)
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  while (true) {
    const { done, value } = await reader.read()
    totalBytes += value?.byteLength || 0
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw responseLimitError()
    }
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    if (Buffer.byteLength(buffer) > MAX_SSE_LINE_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error('LM Studio SSE line exceeds the 1 MB limit.')
    }
    for (const line of lines) consumeLine(line)
    if (done) break
  }
  if (buffer.trim()) consumeLine(buffer)
  return { content, toolCalls: toolCalls.filter(Boolean), finishReason }
}

async function modelCompletion({ baseUrl, model, messages, temperature, maxTokens, onText, signal, enableTools = true }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(enableTools ? { tools: toolDefinitions, tool_choice: 'auto' } : {}),
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }),
    signal: requestSignal(signal),
  })

  if (!response.ok) {
    const detail = (await readResponseText(response)).slice(0, 1000)
    throw new Error(`LM Studio request failed (${response.status}): ${detail || response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return messageFromJson(await readResponseJson(response), onText)
  return streamMessage(response, onText)
}

export async function getModels(baseUrl, signal) {
  const response = await fetch(`${baseUrl}/models`, { signal: requestSignal(signal) })
  if (!response.ok) throw new Error(`LM Studio model request failed (${response.status}).`)
  const payload = await readResponseJson(response)
  const data = Array.isArray(payload.data) ? payload.data : []
  if (data.length > MAX_MODELS) throw new Error('LM Studio returned too many models.')
  return data
    .map((item) => ({ id: item.id, ownedBy: item.owned_by || 'local' }))
    .filter((item) => typeof item.id === 'string' && Buffer.byteLength(item.id) <= 1000)
}

/** LM Studio's native REST API lists every downloaded model along with its
 *  current load state — the OpenAI-compatible /v1/models endpoint only reports
 *  loaded ones, so we hit /api/v0/models on the same origin instead. */
export async function getAllModelsWithState(baseUrl, signal) {
  const origin = new URL(baseUrl).origin
  const response = await fetch(`${origin}/api/v0/models`, { signal: requestSignal(signal) })
  if (!response.ok) throw new Error(`LM Studio native API failed (${response.status}).`)
  const payload = await readResponseJson(response)
  const data = Array.isArray(payload.data) ? payload.data : []
  if (data.length > MAX_MODELS) throw new Error('LM Studio returned too many models.')
  return data
    .map((item) => ({ id: item.id, state: item.state, type: item.type }))
    .filter((item) => typeof item.id === 'string' && Buffer.byteLength(item.id) <= 1000)
}

const SUMMARY_INSTRUCTION = 'Summarize the conversation above concisely and factually, in plain notes (not a transcript). Preserve important facts, decisions, file paths, and outstanding tasks so work can continue from the summary alone.'

export async function summarizeConversation({ baseUrl, model, conversation, maxTokens, signal }) {
  const messages = [
    { role: 'system', content: 'You summarize Rivet conversations concisely and factually.' },
    ...conversation,
    { role: 'user', content: SUMMARY_INSTRUCTION },
  ]
  const result = await modelCompletion({
    baseUrl,
    model,
    messages,
    temperature: 0,
    maxTokens: Math.min(maxTokens, 2048),
    onText: () => {},
    signal,
    enableTools: false,
  })
  if (!result.content?.trim()) throw new Error('The model returned an empty summary.')
  return result.content.trim()
}

function parseArguments(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new Error('The model produced invalid JSON tool arguments.')
  }
}

export async function runCodingAgent({ baseUrl, messages, settings, runtime, onEvent, signal }) {
  let model = settings.model
  if (!model || model === 'auto') {
    const models = await getModels(baseUrl, signal)
    if (!models.length) throw new Error('No model is loaded in LM Studio.')
    model = models[0].id
  }

  const conversation = [
    { role: 'system', content: settings.systemPrompt },
    ...messages,
  ]

  for (let round = 0; round < 12; round += 1) {
    const completion = await modelCompletion({
      baseUrl,
      model,
      messages: conversation,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal,
      onText: (content) => onEvent({ type: 'text', content }),
    })

    const assistant = { role: 'assistant', content: completion.content || null }
    if (completion.toolCalls.length) assistant.tool_calls = completion.toolCalls
    conversation.push(assistant)

    if (!completion.toolCalls.length) {
      onEvent({ type: 'done', model })
      return
    }

    for (const call of completion.toolCalls) {
      const toolName = call.function?.name || 'unknown'
      if (!call.id) call.id = `call_${round}_${Math.random().toString(36).slice(2)}`
      let input = {}
      let result
      let isError = false

      try {
        input = parseArguments(call.function?.arguments)
        onEvent({ type: 'tool_call', toolCallId: call.id, toolName, input })
        result = await runtime.execute(toolName, input)
      } catch (error) {
        isError = true
        result = { error: error.message }
      }

      onEvent({ type: 'tool_result', toolCallId: call.id, toolName, result, isError })
      conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
    }
  }

  throw new Error('The agent exceeded the 12-step tool limit. Try breaking the task into a smaller request.')
}
