#!/usr/bin/env node

import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { stdin, stdout } from 'node:process'
import { parseArgs, HELP, VERSION } from './args.js'
import { createApprovedRuntime } from './approval.js'
import { printBanner, toolDescription, toolResultDescription, ui } from './ui.js'
import { createWorkspaceManager } from '../backend/services/workspace-manager.js'
import { DEFAULT_SYSTEM_PROMPT, normalizeSettings } from '../backend/services/settings-store.js'
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

function friendlyError(error, baseUrl) {
  if (error.name === 'AbortError') return 'Request cancelled.'
  if (error.message === 'fetch failed' || /ECONNREFUSED|UND_ERR_CONNECT/.test(String(error.cause))) {
    return `Cannot reach LM Studio at ${baseUrl}. Start its local server and load a model.`
  }
  return error.message || String(error)
}

function printStatus(workspace, settings, baseUrl, approvals) {
  const info = workspace.info()
  stdout.write(`\n${ui.bold('Status')}\n`)
  stdout.write(`  ${ui.muted('project')}      ${info.path}\n`)
  if (info.extraDirs?.length) stdout.write(`  ${ui.muted('extra dirs')}   ${info.extraDirs.join(', ')}\n`)
  stdout.write(`  ${ui.muted('model')}        ${settings.model}\n`)
  stdout.write(`  ${ui.muted('temperature')}  ${settings.temperature}\n`)
  stdout.write(`  ${ui.muted('max tokens')}   ${settings.maxTokens}\n`)
  stdout.write(`  ${ui.muted('server')}       ${baseUrl}\n`)
  stdout.write(`  ${ui.muted('approvals')}    ${approvals.approveAll ? 'automatic for this session' : 'ask before changes'}\n\n`)
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
    process.stderr.write(`${ui.red('error')} ${error.message}\n\n${HELP}`)
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
  let settings = normalizeSettings({
    systemPrompt: process.env.CODING_AGENT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  })
  let conversation = []
  let activeController = null

  async function confirmTool(name, input) {
    if (!stdin.isTTY) return false
    const detail = toolDescription(name, input)
    const answer = (await terminal.question(`  ${ui.yellow('?')} Allow ${ui.bold(name)} ${ui.muted(detail)}? ${ui.muted('[y/N/a]')} `)).trim().toLowerCase()
    if (answer === 'a' || answer === 'all') return 'all'
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
  try {
    models = await getModels(options.url, AbortSignal.timeout(2500))
    connected = true
  } catch { /* The interactive shell can still start while LM Studio is offline. */ }
  const displayedModel = settings.model === 'auto' && models.length ? models[0].id : settings.model
  printBanner({ project: workspace.info().path, url: options.url, model: displayedModel, connected })
  if (options.yes) stdout.write(`${ui.yellow('!')} Changes and commands are automatically approved for this session.\n\n`)

  async function runTurn(prompt) {
    const userMessage = { role: 'user', content: prompt }
    const requestMessages = [...conversation, userMessage]
    let assistantText = ''
    let lineOpen = false
    activeController = new AbortController()

    function finishLine() {
      if (lineOpen) stdout.write('\n')
      lineOpen = false
    }

    function onEvent(event) {
      if (event.type === 'text') {
        if (!lineOpen) stdout.write(`\n${ui.accent('agent')}\n`)
        stdout.write(event.content)
        assistantText += event.content
        lineOpen = true
      } else if (event.type === 'tool_call') {
        finishLine()
        stdout.write(`  ${ui.cyan('↳')} ${ui.bold(event.toolName)} ${ui.muted(toolDescription(event.toolName, event.input))}\n`)
      } else if (event.type === 'tool_result') {
        finishLine()
        const color = event.isError ? ui.red : ui.green
        stdout.write(`  ${color(event.isError ? '✗' : '✓')} ${toolResultDescription(event.toolName, event.result, event.isError)}\n`)
        if (options.verboseTools) stdout.write(`${ui.muted(JSON.stringify(event.result, null, 2))}\n`)
      }
    }

    try {
      await runCodingAgent({ baseUrl: options.url, messages: requestMessages, settings, runtime: approvals, onEvent, signal: activeController.signal })
      finishLine()
      conversation.push(userMessage)
      if (assistantText.trim()) conversation.push({ role: 'assistant', content: assistantText })
      stdout.write('\n')
    } catch (error) {
      finishLine()
      stdout.write(`\n${ui.red('error')} ${friendlyError(error, options.url)}\n\n`)
      if (options.prompt) process.exitCode = 1
    } finally { activeController = null }
  }

  const commands = [
    {
      name: '/help',
      usage: '/help',
      summary: 'Show this command list',
      handler() {
        stdout.write(`\n${ui.bold('Commands')}\n`)
        for (const entry of commands) {
          const label = [entry.name, ...(entry.aliases || [])].join(', ').padEnd(24)
          stdout.write(`  ${ui.accent(label)} ${entry.summary}\n`)
        }
        stdout.write('\n')
      },
    },
    {
      name: '/project',
      aliases: ['/cd'],
      usage: '/project <path>',
      summary: 'Switch to another project (relative paths work)',
      async handler(argument) {
        if (!argument) { stdout.write(`${ui.yellow('usage')} /project /absolute/path/to/project\n`); return }
        try {
          const nextProject = argument.startsWith('~') ? argument : path.resolve(argument)
          await workspace.select(nextProject)
          conversation = []
          resetApprovals()
          stdout.write(`${ui.green('✓')} Opened ${workspace.info().path}\n${ui.muted('  Conversation and approval state cleared.')}\n`)
        } catch (error) { stdout.write(`${ui.red('error')} ${error.message}\n`) }
      },
    },
    {
      name: '/add-dir',
      usage: '/add-dir <path>',
      summary: 'Grant file access to another folder for this session',
      async handler(argument) {
        if (!argument) { stdout.write(`${ui.yellow('usage')} /add-dir /absolute/path/to/folder\n`); return }
        try {
          const info = await workspace.addDir(argument)
          stdout.write(`${ui.green('✓')} Added ${info.extraDirs[info.extraDirs.length - 1]}\n${ui.muted('  Accessible:')} ${[info.path, ...info.extraDirs].join(', ')}\n`)
        } catch (error) { stdout.write(`${ui.red('error')} ${error.message}\n`) }
      },
    },
    {
      name: '/server',
      usage: '/server <url>',
      summary: 'Change the LM Studio server URL',
      async handler(argument) {
        if (!argument) { stdout.write(`${ui.yellow('usage')} /server <url>\n`); return }
        const nextUrl = argument.trim().replace(/\/$/, '')
        options.url = nextUrl
        try {
          models = await getModels(nextUrl, AbortSignal.timeout(5000))
          connected = true
          stdout.write(`${ui.green('✓')} Server set to ${nextUrl} · ${models.length} model(s) loaded.\n`)
        } catch (error) {
          connected = false
          stdout.write(`${ui.green('✓')} Server set to ${nextUrl}\n${ui.yellow('!')} Cannot reach it yet: ${friendlyError(error, nextUrl)}\n`)
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
          stdout.write(`\n${models.length ? models.map((model) => `  ${model.id === settings.model ? ui.accent('●') : '○'} ${model.id}`).join('\n') : ui.yellow('No models are loaded.')}\n\n`)
        } catch (error) { stdout.write(`${ui.red('error')} ${friendlyError(error, options.url)}\n`) }
      },
    },
    {
      name: '/model',
      usage: '/model <id|auto>',
      summary: 'Change the active model',
      handler(argument) {
        if (!argument) { stdout.write(`${ui.yellow('usage')} /model <id|auto>\n`); return }
        settings = { ...settings, model: argument }
        stdout.write(`${ui.green('✓')} Model set to ${argument}.\n`)
      },
    },
    {
      name: '/config',
      usage: '/config [key=value ...]',
      summary: 'View or change temperature, maxTokens, systemPrompt, verboseTools',
      handler(argument) {
        if (!argument) {
          const prompt = settings.systemPrompt.length > 200 ? `${settings.systemPrompt.slice(0, 200)}…` : settings.systemPrompt
          stdout.write(`\n${ui.bold('Config')}\n`)
          stdout.write(`  ${ui.muted('temperature')}   ${settings.temperature}\n`)
          stdout.write(`  ${ui.muted('maxTokens')}     ${settings.maxTokens}\n`)
          stdout.write(`  ${ui.muted('verboseTools')}  ${options.verboseTools}\n`)
          stdout.write(`  ${ui.muted('systemPrompt')}  ${prompt}\n\n`)
          return
        }
        let updates
        try { updates = parseConfigUpdates(argument) } catch (error) { stdout.write(`${ui.red('error')} ${error.message}\n`); return }
        const unknown = Object.keys(updates).filter((key) => !CONFIG_KEYS.includes(key))
        if (unknown.length) { stdout.write(`${ui.yellow('unknown setting')} ${unknown.join(', ')}. Valid: ${CONFIG_KEYS.join(', ')}.\n`); return }
        if ('verboseTools' in updates) {
          const value = updates.verboseTools.toLowerCase()
          if (['on', 'true', '1', 'yes'].includes(value)) options.verboseTools = true
          else if (['off', 'false', '0', 'no'].includes(value)) options.verboseTools = false
          else { stdout.write(`${ui.red('error')} verboseTools must be on or off.\n`); return }
          delete updates.verboseTools
        }
        settings = normalizeSettings({ ...settings, ...updates })
        stdout.write(`${ui.green('✓')} Config updated.\n`)
      },
    },
    {
      name: '/status',
      usage: '/status',
      summary: 'Show the project, model, server, and approval mode',
      handler() { printStatus(workspace, settings, options.url, approvals) },
    },
    {
      name: '/compact',
      usage: '/compact',
      summary: 'Summarize and shrink the conversation to free up context',
      async handler() {
        if (!conversation.length) { stdout.write(`${ui.yellow('!')} Nothing to compact yet.\n`); return }
        stdout.write(`${ui.muted('Summarizing conversation…')}\n`)
        try {
          const summaryModel = settings.model === 'auto' && models.length ? models[0].id : settings.model
          const summary = await summarizeConversation({ baseUrl: options.url, model: summaryModel, conversation, maxTokens: settings.maxTokens })
          conversation = [{ role: 'user', content: `Summary of earlier conversation:\n${summary}` }]
          stdout.write(`${ui.green('✓')} Conversation compacted.\n`)
        } catch (error) { stdout.write(`${ui.red('error')} ${friendlyError(error, options.url)}\n`) }
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
          stdout.write(`${ui.green('✓')} Exported to ${target}\n`)
        } catch (error) { stdout.write(`${ui.red('error')} ${error.message}\n`) }
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
          stdout.write(diffOutput.trim() ? `\n${diffOutput}\n` : `${ui.muted('No changes.')}\n`)
        } catch (error) {
          if (error.code === 'ENOENT') stdout.write(`${ui.red('error')} git is not installed or not on PATH.\n`)
          else if (/not a git repository/i.test(error.stderr || error.message)) stdout.write(`${ui.yellow('!')} ${projectPath} is not a git repository.\n`)
          else stdout.write(`${ui.red('error')} ${(error.stderr || error.message).trim()}\n`)
        }
      },
    },
    {
      name: '/doctor',
      usage: '/doctor',
      summary: 'Run local health checks (Node, server, project, git)',
      async handler() {
        stdout.write(`\n${ui.bold('Doctor')}\n`)
        const checks = []
        const nodeMajor = Number(process.version.slice(1).split('.')[0])
        checks.push({ ok: nodeMajor >= 20, name: 'Node.js version', detail: process.version })
        try {
          const doctorModels = await getModels(options.url, AbortSignal.timeout(3000))
          checks.push({ ok: true, name: 'LM Studio server', detail: `${options.url} · ${doctorModels.length} model(s) loaded` })
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
        for (const check of checks) stdout.write(`  ${check.ok ? ui.green('✓') : ui.red('✗')} ${check.name} ${ui.muted(check.detail)}\n`)
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
        stdout.write(`\n${ui.bold('Usage')}\n`)
        stdout.write(`  ${ui.muted('turns')}          ${conversation.length}\n`)
        stdout.write(`  ${ui.muted('approx tokens')}  ~${approxTokens} ${ui.muted('(rough estimate, 4 chars/token)')}\n`)
        stdout.write(`  ${ui.muted('max response')}   ${settings.maxTokens} tokens\n`)
        stdout.write(`  ${ui.muted('note')}           local model — no billing or cost tracking\n\n`)
      },
    },
    {
      name: '/clear',
      aliases: ['/new'],
      usage: '/clear',
      summary: 'Clear conversation context',
      handler() { conversation = []; stdout.write(`${ui.green('✓')} Conversation cleared.\n`) },
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
    if (!entry) { stdout.write(`${ui.yellow('unknown command')} ${command}. Type /help.\n`); return }
    return entry.handler(argument)
  }

  const onInterrupt = () => {
    if (activeController) activeController.abort()
    else { stdout.write('\n'); terminal.close() }
  }
  process.on('SIGINT', onInterrupt)

  try {
    if (options.prompt) {
      await runTurn(options.prompt)
      return
    }
    while (true) {
      let input
      try { input = (await terminal.question(`${ui.accent('you')} ${ui.muted('❯')} `)).trim() } catch { break }
      if (!input) continue
      if (input.startsWith('/')) {
        if (await handleCommand(input) === 'exit') break
      } else await runTurn(input)
    }
  } finally {
    process.off('SIGINT', onInterrupt)
    terminal.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${ui.red('error')} ${error.message || error}\n`)
  process.exitCode = 1
})
