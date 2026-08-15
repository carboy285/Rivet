const mutatingTools = new Set(['write_file', 'append_file', 'delete_file', 'run_command'])

export function createApprovedRuntime(runtime, { confirm, autoApprove = false }) {
  let approveAll = autoApprove
  return {
    get approveAll() { return approveAll },
    async execute(name, input) {
      if (mutatingTools.has(name) && !approveAll) {
        const decision = await confirm(name, input)
        if (decision === 'all') approveAll = true
        else if (decision !== 'once') throw new Error('User denied this tool call.')
      }
      return runtime.execute(name, input)
    },
  }
}
