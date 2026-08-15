#!/usr/bin/env node

import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { stdin, stdout } from 'node:process'
import { parseArgs, normalizeBaseUrl, HELP, VERSION } from './args.js'
import { createApprovedRuntime } from './approval.js'
import {
  agentLabel,
  approvalCard,
  approvalQuestion,
  banner,
  clearScreen,
  commandTable,
  createSpinner,
  createStreamRenderer,
  errorLine,
  formatDuration,
  glyph,
  heading,
  INDENT,
  promptLabel,
  section,
  statusLine,
  toolCallLine,
  toolResultLine,
  ui,
  usageLine,
} from './ui.js'
import { createWorkspaceManager } from '../backend/services/workspace-manager.js'
import { createSettingsStore, normalizeSettings } from '../backend/services/settings-store.js'
import { getModels, runCodingAgent, summarizeConversation } from '../backend/services/lm-studio.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const CONFIG_KEYS = ['temperature', 'maxTokens', 'systemPrompt', 'verboseTools']

async function loadLocalEnvironment() {
  for (const file of [path.join(packageRoot, '.env')]) {
    try {
      const content = await fs.readFile(file, 'utf8')
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
        if (!match || Object.hasOwn(process.env, match[1])) continue
        let value = match[2]
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        process.env[match[1]] = value
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

function isLoopback(baseUrl) {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(baseUrl).hostname) } catch { return false }
}

function friendlyError(error, baseUrl) {
  if (error.name === 'AbortError') return 'Request cancelled.'
  if (error.name === 'TimeoutError' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(String(error.cause))) {
    return `${baseUrl} did not answer in time. The host is probably on another network, or a firewall is dropping port ${new URL(baseUrl).port || 80}.`
  }
  if (error.message === 'fetch failed' || /ECONNREFUSED|UND_ERR_CONNECT|EHOSTUNREACH|ENOTFOUND/.test(String(error.cause))) {
    return isLoopback(baseUrl)
      ? `Nothing is listening at ${baseUrl} on this machine. Start the server in LM Studio's Developer tab, or point /server at the machine running it.`
      : `Nothing answered at ${baseUrl}. Check that LM Studio is running there with "Serve on Local Network" enabled, and that the host firewall allows the port.`
  }
  return error.message || String(error)
}

function buildTranscript({ project, model, baseUrl, conversation }) {
  const header = `# Coding Agent Transcript\n\nProject: ${project}\nModel: ${model}\nServer: ${baseUrl}\nExported: ${new Date().toISOString()}\n\n---\n\n`
  const body = conversation.map((message) => `### ${message.role}\n\n${message.content}\n`).join('\n')
  return `${header}${body}\n`
}

function parseConfigUpdates(argument) {
  const systemPromptMatch = argument.match(/^systemPrompt=([\s\S]*)$/)
  if (systemPromptMatch) return { systemPrompt: systemPromptMatch[1] }
  const updates = {}
  for (const token of argument.split(/\s+/)) {
    const equals = token.indexOf('=')
    if (equals === -1) throw new Error(`Invalid setting: ${token}. Use key=value.`)
    updates[token.slice(0, equals)] = token.slice(equals + 1)
  }
  return updates
}

async function main() {
  await loadLocalEnvironment()
  let options
  try { options = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${errorLine(error.message)}\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (options.help) { stdout.write(HELP); return }
  if (options.version) { stdout.write(`${VERSION}\n`); return }

  const initialProject = options.project
    ? options.project.startsWith('~') ? options.project : path.resolve(options.project)
    : process.cwd()
  const workspace = await createWorkspaceManager(initialProject)
  const terminal = readline.createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) })

  // Each project remembers its own model/temperature/prompt/etc. so the next
  // session in that folder starts back up the way it was left. Explicit CLI
  // flags always win over whatever was saved last time.
  let settingsStore = createSettingsStore(workspace.info().path)
  const savedPreferences = await settingsStore.get()
  if (!options.explicit.has('model')) options.model = savedPreferences.model
  if (!options.explicit.has('temperature')) options.temperature = savedPreferences.temperature
  if (!options.explicit.has('maxTokens')) options.maxTokens = savedPreferences.maxTokens
  if (!options.explicit.has('verboseTools')) options.verboseTools = savedPreferences.verboseTools
  if (!options.explicit.has('url') && savedPreferences.serverUrl) options.url = savedPreferences.serverUrl

  let settings = normalizeSettings({
    systemPrompt: process.env.CODING_AGENT_SYSTEM_PROMPT || savedPreferences.systemPrompt,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  })
  let conversation = []
  let activeController = null

  async function persistPreferences() {
    try { await settingsStore.set({ ...settings, verboseTools: options.verboseTools, serverUrl: options.url }) }
    catch { /* best-effort — a read-only project folder should not block exit */ }
  }

  async function confirmTool(name, input) {
    if (!stdin.isTTY) return false
    stdout.write(approvalCard(name, input))
    const answer = (await terminal.question(approvalQuestion())).trim().toLowerCase()
    stdout.write('\n')
    if (answer === 'a' || answer === 'all' || answer === 'always') return 'all'
    if (answer === 'y' || answer === 'yes') return 'once'
    return false
  }

  let approvals
  function resetApprovals() {
    const currentRuntime = { execute: (name, input) => workspace.runtime.execute(name, input) }
    approvals = createApprovedRuntime(currentRuntime, { confirm: confirmTool, autoApprove: options.yes })
  }
  resetApprovals()

  let models = []
  let connected = false

  function activeModel() {
    return settings.model === 'auto' && models.length ? models[0].id : settings.model
  }

  function renderBanner() {
    stdout.write(banner({
      project: workspace.info().path,
      url: options.url,
      model: activeModel(),
      connected,
      version: VERSION,
      approveAll: approvals.approveAll,
    }))
  }

  try {
    models = await getModels(options.url, AbortSignal.timeout(2500))
    connected = true
  } catch { /* The interactive shell can still start while LM Studio is offline. */ }
  renderBanner()

  async function runTurn(prompt) {
    const userMessage = { role: 'user', content: prompt }
    const requestMessages = [...conversation, userMessage]
    let assistantText = ''
    let stream = null
    let labelled = false
    const toolStartedAt = new Map()
    const spinner = createSpinner('thinking')
    const turnStartedAt = Date.now()
    activeController = new AbortController()

    function endStream() {
      if (stream) stream.end()
      stream = null
    }

    function onEvent(event) {
      if (event.type === 'text') {
        spinner.stop()
        if (!stream) {
          if (!labelled) { stdout.write(agentLabel()); labelled = true } else stdout.write('\n')
          stream = createStreamRenderer()
        }
        stream.feed(event.content)
        assistantText += event.content
      } else if (event.type === 'tool_call') {
        spinner.stop()
        endStream()
        stdout.write(toolCallLine(event.toolName, event.input))
        toolStartedAt.set(event.toolCallId, Date.now())
      } else if (event.type === 'tool_result') {
        const startedAt = toolStartedAt.get(event.toolCallId)
        toolStartedAt.delete(event.toolCallId)
        stdout.write(toolResultLine(event.toolName, event.result, event.isError, startedAt ? Date.now() - startedAt : undefined))
        if (options.verboseTools) {
          stdout.write(`${ui.muted(JSON.stringify(event.result, null, 2).split('\n').map((line) => `${INDENT}${INDENT}${line}`).join('\n'))}\n`)
        }
        spinner.start()
      }
    }

    spinner.start()
    try {
      await runCodingAgent({ baseUrl: options.url, messages: requestMessages, settings, runtime: approvals, onEvent, signal: activeController.signal })
      spinner.stop()
      endStream()
      conversation.push(userMessage)
      if (assistantText.trim()) conversation.push({ role: 'assistant', content: assistantText })
      if (stdout.isTTY) stdout.write(`\n${INDENT}${ui.muted(`${glyph.bullet} done in ${formatDuration(Date.now() - turnStartedAt)}`)}\n\n`)
    } catch (error) {
      spinner.stop()
      endStream()
      stdout.write(`\n${errorLine(friendlyError(error, options.url))}\n`)
      if (options.prompt) process.exitCode = 1
    } finally { activeController = null }
  }

  const commands = [
    {
      name: '/help',
      usage: '/help',
      summary: 'Show this command list',
      handler() {
        stdout.write(heading('commands'))
        stdout.write(commandTable(commands))
        stdout.write(`\n${INDENT}${ui.muted(`Anything that is not a command is sent to the model.`)}\n\n`)
      },
    },
    {
      name: '/project',
      aliases: ['/cd'],
      usage: '/project <path>',
      summary: 'Switch to another project (relative paths work)',
      async handler(argument) {
        if (!argument) { stdout.write(usageLine('/project /absolute/path/to/project')); return }
        try {
          const nextProject = argument.startsWith('~') ? argument : path.resolve(argument)
          await persistPreferences()
          await workspace.select(nextProject)
          conversation = []
          resetApprovals()
          settingsStore = createSettingsStore(workspace.info().path)
          const nextPreferences = await settingsStore.get()
          settings = normalizeSettings({
            systemPrompt: process.env.CODING_AGENT_SYSTEM_PROMPT || nextPreferences.systemPrompt,
            model: nextPreferences.model,
            temperature: nextPreferences.temperature,
            maxTokens: nextPreferences.maxTokens,
          })
          options.verboseTools = nextPreferences.verboseTools
          stdout.write(statusLine('ok', `Opened ${workspace.info().path}`, `${glyph.bullet} conversation and approvals reset`))
        } catch (error) { stdout.write(errorLine(error.message)) }
      },
    },
    {
      name: '/add-dir',
      usage: '/add-dir <path>',
      summary: 'Grant file access to another folder for this session',
      async handler(argument) {
        if (!argument) { stdout.write(usageLine('/add-dir /absolute/path/to/folder')); return }
        try {
          const info = await workspace.addDir(argument)
          stdout.write(statusLine('ok', `Added ${info.extraDirs[info.extraDirs.length - 1]}`))
          stdout.write(`${INDENT}${ui.muted(`accessible: ${[info.path, ...info.extraDirs].join(', ')}`)}\n`)
        } catch (error) { stdout.write(errorLine(error.message)) }
      },
    },
    {
      name: '/server',
      usage: '/server <url>',
      summary: 'Change the LM Studio server URL',
      async handler(argument) {
        if (!argument) { stdout.write(usageLine('/server <url>')); return }
        let nextUrl
        try { nextUrl = normalizeBaseUrl(argument) } catch (error) { stdout.write(errorLine(error.message)); return }
        options.url = nextUrl
        try {
          models = await getModels(nextUrl, AbortSignal.timeout(5000))
          connected = true
          stdout.write(statusLine('ok', `Server set to ${nextUrl}`, `${glyph.bullet} ${models.length} model(s) loaded`))
        } catch (error) {
          connected = false
          stdout.write(statusLine('ok', `Server set to ${nextUrl}`))
          stdout.write(statusLine('warn', friendlyError(error, nextUrl)))
        }
      },
    },
    {
      name: '/models',
      usage: '/models',
      summary: 'List models loaded in LM Studio',
      async handler() {
        try {
          models = await getModels(options.url, AbortSignal.timeout(5000))
          stdout.write(heading('models'))
          if (!models.length) stdout.write(statusLine('warn', 'No models are loaded in LM Studio.'))
          else {
            const current = activeModel()
            for (const model of models) {
              const selected = model.id === current
              stdout.write(`${INDENT}${selected ? ui.accent(glyph.dot) : ui.muted(glyph.ring)} ${selected ? ui.bold(model.id) : model.id}\n`)
            }
          }
          stdout.write('\n')
        } catch (error) { stdout.write(errorLine(friendlyError(error, options.url))) }
      },
    },
    {
      name: '/model',
      usage: '/model <id|auto>',
      summary: 'Change the active model',
      handler(argument) {
        if (!argument) { stdout.write(usageLine('/model <id|auto>')); return }
        settings = { ...settings, model: argument }
        stdout.write(statusLine('ok', `Model set to ${ui.bold(argument)}`))
      },
    },
    {
      name: '/config',
      usage: '/config [key=value ...]',
      summary: 'View or change temperature, maxTokens, systemPrompt, verboseTools',
      handler(argument) {
        if (!argument) {
          const flattened = settings.systemPrompt.replace(/\s+/g, ' ').trim()
          const prompt = flattened.length > 120 ? `${flattened.slice(0, 120)}…` : flattened
          stdout.write(section('config', [
            ['temperature', settings.temperature],
            ['maxTokens', settings.maxTokens],
            ['verboseTools', options.verboseTools ? ui.green('on') : ui.muted('off')],
            ['systemPrompt', ui.muted(prompt)],
          ]))
          return
        }
        let updates
        try { updates = parseConfigUpdates(argument) } catch (error) { stdout.write(errorLine(error.message)); return }
        const unknown = Object.keys(updates).filter((key) => !CONFIG_KEYS.includes(key))
        if (unknown.length) { stdout.write(statusLine('warn', `Unknown setting: ${unknown.join(', ')}`, `${glyph.bullet} valid: ${CONFIG_KEYS.join(', ')}`)); return }
        if ('verboseTools' in updates) {
          const value = updates.verboseTools.toLowerCase()
          if (['on', 'true', '1', 'yes'].includes(value)) options.verboseTools = true
          else if (['off', 'false', '0', 'no'].includes(value)) options.verboseTools = false
          else { stdout.write(errorLine('verboseTools must be on or off.')); return }
          delete updates.verboseTools
        }
        settings = normalizeSettings({ ...settings, ...updates })
        stdout.write(statusLine('ok', 'Config updated.'))
      },
    },
    {
      name: '/status',
      usage: '/status',
      summary: 'Show the project, model, server, and approval mode',
      handler() {
        const info = workspace.info()
        const entries = [['project', info.path]]
        if (info.extraDirs?.length) entries.push(['extra dirs', info.extraDirs.join(', ')])
        entries.push(
          ['model', `${activeModel()}  ${connected ? ui.green(`${glyph.dot} connected`) : ui.yellow(`${glyph.ring} offline`)}`],
          ['temperature', settings.temperature],
          ['max tokens', settings.maxTokens],
          ['server', options.url],
          ['approvals', approvals.approveAll ? ui.yellow('automatic for this session') : 'ask before changes'],
          ['turns', conversation.length],
        )
        stdout.write(section('status', entries))
      },
    },
    {
      name: '/compact',
      usage: '/compact',
      summary: 'Summarize and shrink the conversation to free up context',
      async handler() {
        if (!conversation.length) { stdout.write(statusLine('warn', 'Nothing to compact yet.')); return }
        const spinner = createSpinner('summarizing')
        spinner.start()
        try {
          const summary = await summarizeConversation({ baseUrl: options.url, model: activeModel(), conversation, maxTokens: settings.maxTokens })
          conversation = [{ role: 'user', content: `Summary of earlier conversation:\n${summary}` }]
          spinner.stop()
          stdout.write(statusLine('ok', 'Conversation compacted.', `${glyph.bullet} 1 summary message kept`))
        } catch (error) {
          spinner.stop()
          stdout.write(errorLine(friendlyError(error, options.url)))
        }
      },
    },
    {
      name: '/export',
      usage: '/export [file]',
      summary: 'Save the conversation transcript to a file',
      async handler(argument) {
        const filename = argument || `transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
        const target = path.isAbsolute(filename) ? filename : path.join(workspace.info().path, filename)
        const transcript = buildTranscript({ project: workspace.info().path, model: settings.model, baseUrl: options.url, conversation })
        try {
          await fs.writeFile(target, transcript, 'utf8')
          stdout.write(statusLine('ok', `Exported to ${target}`))
        } catch (error) { stdout.write(errorLine(error.message)) }
      },
    },
    {
      name: '/diff',
      usage: '/diff [path]',
      summary: 'Show git diff for the project (or a path within it)',
      async handler(argument) {
        const projectPath = workspace.info().path
        try {
          const { stdout: diffOutput } = await execFileAsync('git', ['-C', projectPath, 'diff', '--color=never', ...(argument ? [argument] : [])], { maxBuffer: 2 * 1024 * 1024 })
          if (!diffOutput.trim()) { stdout.write(statusLine('info', 'No changes.')); return }
          stdout.write(heading('diff'))
          for (const line of diffOutput.replace(/\n$/, '').split('\n')) {
            if (line.startsWith('+++') || line.startsWith('---')) stdout.write(`${INDENT}${ui.bold(line)}\n`)
            else if (line.startsWith('@@')) stdout.write(`${INDENT}${ui.cyan(line)}\n`)
            else if (line.startsWith('+')) stdout.write(`${INDENT}${ui.green(line)}\n`)
            else if (line.startsWith('-')) stdout.write(`${INDENT}${ui.red(line)}\n`)
            else if (line.startsWith('diff ') || line.startsWith('index ')) stdout.write(`${INDENT}${ui.muted(line)}\n`)
            else stdout.write(`${INDENT}${line}\n`)
          }
          stdout.write('\n')
        } catch (error) {
          if (error.code === 'ENOENT') stdout.write(errorLine('git is not installed or not on PATH.'))
          else if (/not a git repository/i.test(error.stderr || error.message)) stdout.write(statusLine('warn', `${projectPath} is not a git repository.`))
          else stdout.write(errorLine((error.stderr || error.message).trim()))
        }
      },
    },
    {
      name: '/doctor',
      usage: '/doctor',
      summary: 'Run local health checks (Node, server, project, git)',
      async handler() {
        stdout.write(heading('doctor'))
        const checks = []
        const nodeMajor = Number(process.version.slice(1).split('.')[0])
        checks.push({ ok: nodeMajor >= 20, name: 'Node.js version', detail: process.version })
        try {
          const doctorModels = await getModels(options.url, AbortSignal.timeout(3000))
          checks.push({ ok: true, name: 'LM Studio server', detail: `${options.url} ${glyph.bullet} ${doctorModels.length} model(s) loaded` })
        } catch (error) {
          checks.push({ ok: false, name: 'LM Studio server', detail: friendlyError(error, options.url) })
        }
        try {
          await fs.access(workspace.info().path, fsConstants.R_OK | fsConstants.W_OK)
          checks.push({ ok: true, name: 'Project folder', detail: workspace.info().path })
        } catch (error) {
          checks.push({ ok: false, name: 'Project folder', detail: error.message })
        }
        try {
          await execFileAsync('git', ['--version'])
          checks.push({ ok: true, name: 'git', detail: 'available (used by /diff)' })
        } catch {
          checks.push({ ok: false, name: 'git', detail: 'not found — /diff will not work' })
        }
        const nameWidth = checks.reduce((max, check) => Math.max(max, check.name.length), 0)
        for (const check of checks) stdout.write(statusLine(check.ok ? 'ok' : 'fail', check.name.padEnd(nameWidth), check.detail))
        stdout.write('\n')
      },
    },
    {
      name: '/usage',
      usage: '/usage',
      summary: 'Show an approximate context-size estimate',
      handler() {
        const historyChars = conversation.reduce((sum, message) => sum + (typeof message.content === 'string' ? message.content.length : 0), 0)
        const approxTokens = Math.ceil((historyChars + settings.systemPrompt.length) / 4)
        stdout.write(section('usage', [
          ['turns', conversation.length],
          ['approx tokens', `~${approxTokens}`, '(rough estimate, 4 chars/token)'],
          ['max response', `${settings.maxTokens} tokens`],
          ['note', ui.muted('local model — no billing or cost tracking')],
        ]))
      },
    },
    {
      name: '/clear',
      aliases: ['/new'],
      usage: '/clear',
      summary: 'Clear the screen and start a fresh conversation',
      handler() {
        conversation = []
        clearScreen()
        renderBanner()
        stdout.write(statusLine('ok', 'Screen and conversation cleared.'))
        stdout.write('\n')
      },
    },
    {
      name: '/exit',
      aliases: ['/quit'],
      usage: '/exit',
      summary: 'Quit',
      handler: () => 'exit',
    },
  ]

  async function handleCommand(input) {
    const firstSpace = input.indexOf(' ')
    const command = (firstSpace === -1 ? input : input.slice(0, firstSpace)).toLowerCase()
    const argument = firstSpace === -1 ? '' : input.slice(firstSpace + 1).trim()
    const entry = commands.find((candidate) => candidate.name === command || (candidate.aliases || []).includes(command))
    if (!entry) {
      const suggestion = commands.find((candidate) => candidate.name.startsWith(command))
      stdout.write(statusLine('warn', `Unknown command ${ui.bold(command)}`, suggestion ? `${glyph.bullet} did you mean ${suggestion.name}?` : `${glyph.bullet} type /help`))
      return
    }
    return entry.handler(argument)
  }

  const onInterrupt = () => {
    if (activeController) activeController.abort()
    else { stdout.write('\n'); terminal.close() }
  }
  process.on('SIGINT', onInterrupt)

  // Ctrl+L wipes the screen without touching the conversation, like a shell.
  const onKeypress = (_chunk, key) => {
    if (!key || !key.ctrl || key.name !== 'l') return
    clearScreen()
    renderBanner()
    terminal.prompt(true)
  }
  if (stdin.isTTY) stdin.on('keypress', onKeypress)

  try {
    if (options.prompt) {
      await runTurn(options.prompt)
      return
    }
    while (true) {
      let input
      try { input = (await terminal.question(`${INDENT}${promptLabel()}`)).trim() } catch { break }
      if (!input) continue
      if (input.startsWith('/')) {
        if (await handleCommand(input) === 'exit') break
      } else await runTurn(input)
    }
  } finally {
    await persistPreferences()
    process.off('SIGINT', onInterrupt)
    if (stdin.isTTY) stdin.off('keypress', onKeypress)
    terminal.close()
  }
}

main().catch((error) => {
  process.stderr.write(errorLine(error.message || error))
  process.exitCode = 1
})
