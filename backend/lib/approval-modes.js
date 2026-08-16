export const APPROVAL_MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'bypass']

export const DEFAULT_APPROVAL_MODE = 'auto'

export const APPROVAL_MODE_INFO = {
  auto: { label: 'Auto', detail: 'Ask before file edits and commands' },
  manual: { label: 'Manual', detail: 'Always ask before making changes' },
  acceptEdits: { label: 'Accept edits', detail: 'Automatically accept file edits, still ask before running commands' },
  plan: { label: 'Plan', detail: 'Research and propose changes — file edits and commands are blocked' },
  bypass: { label: 'Bypass permissions', detail: 'Accepts all permissions, no prompts' },
}
