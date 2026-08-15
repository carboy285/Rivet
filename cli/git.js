export function gitDiffArgs(projectPath, pathspec = '') {
  const args = ['-C', projectPath, 'diff', '--color=never']
  if (pathspec) args.push('--', pathspec)
  return args
}
