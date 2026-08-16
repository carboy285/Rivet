import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE } from '../backend/lib/approval-modes.js'

const fileMutationTools = new Set(['write_file', 'append_file', 'edit_file', 'delete_file'])
const commandTools = new Set(['run_command'])
const mutatingTools = new Set([...fileMutationTools, ...commandTools])

export function createApprovedRuntime(runtime, { confirm, mode: initialMode = DEFAULT_APPROVAL_MODE }) {
  let mode = APPROVAL_MODES.includes(initialMode) ? initialMode : DEFAULT_APPROVAL_MODE

  function setMode(next) {
    if (APPROVAL_MODES.includes(next)) mode = next
  }

  return {
    get mode() { return mode },
    setMode,
    async execute(name, input) {
      if (!mutatingTools.has(name)) return runtime.execute(name, input)
      if (mode === 'bypass') return runtime.execute(name, input)
      if (mode === 'plan') throw new Error(`Blocked by Plan mode: ${name} is disabled. Switch modes with /mode to make changes.`)
      if (mode === 'acceptEdits' && fileMutationTools.has(name)) return runtime.execute(name, input)
      const decision = await confirm(name, input)
      if (decision === 'all') setMode('bypass')
      else if (decision !== 'once') throw new Error('User denied this tool call.')
      return runtime.execute(name, input)
    },
  }
}
