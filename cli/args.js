export const VERSION = '1.0.0'

export const HELP = `Rivet ${VERSION}

Usage:
  rivet [project] [options]
  pnpm agent -- [project] [options]

Options:
  -p, --prompt <text>       Run one task, then exit
  -m, --model <id>          LM Studio model id (default: auto)
  -t, --temperature <0-1>  Sampling temperature (default: 0.2)
      --max-tokens <number> Maximum response tokens (default: 4096)
      --url <url>           LM Studio API URL (default: http://localhost:1234/v1)
      --allow-insecure-http Allow cleartext HTTP to a non-loopback server
  -y, --yes                 Approve file changes and commands for this session
      --verbose-tools       Show complete tool results
  -h, --help                Show this help
  -v, --version             Show the version

Run the agent and type /help to see interactive commands (/project, /server,
/models, /model, /config, /status, /compact, /export, /diff, /doctor, /usage,
/add-dir, /clear, /exit, and more).

In the shell: ctrl+c cancels a response, ctrl+l redraws a clean screen, and
/clear wipes the screen and starts a fresh conversation.
`

/**
 * LM Studio serves its OpenAI-compatible API under /v1, but its UI shows the
 * bare host and port. Accept either form so `http://host:1234` does not turn
 * into a request for /models that the server has no route for.
 */
export function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'localhost'
      || hostname === '::1'
      || hostname === '[::1]'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  } catch {
    return false
  }
}

export function isInsecureRemoteUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && !isLoopbackUrl(url.href)
  } catch {
    return false
  }
}

export function normalizeBaseUrl(value, { allowInsecureRemote = false } = {}) {
  const trimmed = String(value).trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('Server URL must use HTTP or HTTPS.')
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed.replace(/^\/+/, '')}`
  let url
  try { url = new URL(withScheme) } catch { throw new Error(`Invalid server URL: ${value}`) }
  if (!url.hostname) throw new Error(`Invalid server URL: ${value}`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Server URL must use HTTP or HTTPS.')
  if (url.username || url.password) throw new Error('Server URL must not include credentials.')
  const pathname = url.pathname.replace(/\/+$/, '')
  const normalized = `${url.origin}${pathname || '/v1'}`
  if (isInsecureRemoteUrl(normalized) && !allowInsecureRemote) {
    throw new Error('Remote LM Studio servers must use HTTPS. Pass --allow-insecure-http only for a trusted network.')
  }
  return normalized
}

function nextValue(argv, index, option) {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} requires a value.`)
  return value
}

export function parseArgs(argv) {
  const options = {
    project: '', prompt: '', model: 'auto', temperature: 0.2, maxTokens: 4096,
    url: process.env.LM_STUDIO_URL || 'http://localhost:1234/v1',
    yes: false, verboseTools: false, allowInsecureHttp: false, help: false, version: false,
    // Flags the user actually typed, so saved preferences know which fields they may fill in.
    explicit: new Set(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '-h' || argument === '--help') options.help = true
    else if (argument === '-v' || argument === '--version') options.version = true
    else if (argument === '-y' || argument === '--yes') options.yes = true
    else if (argument === '--verbose-tools') { options.verboseTools = true; options.explicit.add('verboseTools') }
    else if (argument === '--allow-insecure-http') options.allowInsecureHttp = true
    else if (argument === '-p' || argument === '--prompt') { options.prompt = nextValue(argv, index, argument); index += 1 }
    else if (argument.startsWith('--prompt=')) options.prompt = argument.slice(9)
    else if (argument === '-m' || argument === '--model') { options.model = nextValue(argv, index, argument); options.explicit.add('model'); index += 1 }
    else if (argument.startsWith('--model=')) { options.model = argument.slice(8); options.explicit.add('model') }
    else if (argument === '-t' || argument === '--temperature') { options.temperature = Number(nextValue(argv, index, argument)); options.explicit.add('temperature'); index += 1 }
    else if (argument.startsWith('--temperature=')) { options.temperature = Number(argument.slice(14)); options.explicit.add('temperature') }
    else if (argument === '--max-tokens') { options.maxTokens = Number(nextValue(argv, index, argument)); options.explicit.add('maxTokens'); index += 1 }
    else if (argument.startsWith('--max-tokens=')) { options.maxTokens = Number(argument.slice(13)); options.explicit.add('maxTokens') }
    else if (argument === '--url') { options.url = nextValue(argv, index, argument); options.explicit.add('url'); index += 1 }
    else if (argument.startsWith('--url=')) { options.url = argument.slice(6); options.explicit.add('url') }
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    else if (!options.project) options.project = argument
    else throw new Error(`Unexpected argument: ${argument}`)
  }

  if (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1) throw new Error('Temperature must be between 0 and 1.')
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 128 || options.maxTokens > 32768) throw new Error('Max tokens must be an integer between 128 and 32768.')
  options.url = normalizeBaseUrl(options.url, { allowInsecureRemote: options.allowInsecureHttp })
  return options
}
