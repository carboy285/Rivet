export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the UTF-8 contents of a file in the project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to the project root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file in the project. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'Complete file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append UTF-8 content to a file in the project, creating it if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'Content to append.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory relative to the project root. Defaults to the root.' },
          recursive: { type: 'boolean', description: 'List nested entries up to four levels deep.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete one file in the project. Directories cannot be deleted.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to the project root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command inside the project and return stdout, stderr, and the exit code.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run.' },
          cwd: { type: 'string', description: 'Working directory relative to the project root.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: 'Optional timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  },
]
