/**
 * Applies ordered search/replace edits to text and records the hunks that
 * resulted, without running a generic two-file diff. Because each edit names
 * the exact text it replaces, staleness/conflicts are caught by requiring
 * that text to match uniquely in the current content, no separate hashing
 * needed.
 */
export function applyEdits(content, edits, label = 'the file') {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('At least one edit is required.')

  let working = content
  const hunks = []

  edits.forEach((edit, position) => {
    const editNumber = position + 1
    const search = edit?.search
    const replace = edit?.replace
    if (typeof search !== 'string' || search === '') {
      throw new Error(`Edit ${editNumber}: "search" must be a non-empty string.`)
    }
    if (typeof replace !== 'string') {
      throw new Error(`Edit ${editNumber}: "replace" must be a string.`)
    }

    const index = working.indexOf(search)
    if (index === -1) {
      throw new Error(`Edit ${editNumber}: search text was not found in ${label}. The file may have changed — read it again before retrying.`)
    }
    const nextIndex = working.indexOf(search, index + search.length)
    if (nextIndex !== -1) {
      throw new Error(`Edit ${editNumber}: search text matches more than once in ${label}. Include more surrounding context to make it unique.`)
    }

    const before = working.slice(0, index)
    const after = working.slice(index + search.length)
    const startLine = before.split('\n').length

    hunks.push({
      index: editNumber,
      startLine,
      removedLines: search.split('\n'),
      addedLines: replace.split('\n'),
    })

    working = before + replace + after
  })

  return { result: working, hunks }
}
