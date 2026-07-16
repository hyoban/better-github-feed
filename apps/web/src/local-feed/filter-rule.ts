import type { FilterGroup, SingleFilter } from '@better-github-feed/shared'

type FilterableActivity = {
  title: string
  repo: string | null
  type: string
  summary: string | null
  content: string | null
  githubUserLogin: string
  publishedAt: Date
}

type SqlBoolean = boolean | null

function invert(value: SqlBoolean): SqlBoolean {
  return value === null ? null : !value
}

function stringValue(activity: FilterableActivity, path: SingleFilter['path']) {
  const key = path?.[0]
  if (
    key !== 'title' &&
    key !== 'repo' &&
    key !== 'type' &&
    key !== 'summary' &&
    key !== 'content' &&
    key !== 'githubUserLogin'
  ) {
    return undefined
  }
  return activity[key]
}

function evaluateSingle(filter: SingleFilter, activity: FilterableActivity): SqlBoolean {
  if (filter.path?.[0] === 'publishedAt') {
    const target = filter.args?.[0]
    if (!(target instanceof Date)) return null
    if (filter.name === 'before') return activity.publishedAt < target
    if (filter.name === 'after') return activity.publishedAt > target
    return null
  }

  const value = stringValue(activity, filter.path)
  if (value === undefined) return null
  if (filter.name === 'isEmpty') return value === null || value === ''
  if (filter.name === 'isNotEmpty') return value !== null && value !== ''
  if (value === null) return null

  const target = filter.args?.[0]
  if (typeof target !== 'string') return null
  const foldedValue = value.toLocaleLowerCase('en-US')
  const foldedTarget = target.toLocaleLowerCase('en-US')

  switch (filter.name) {
    case 'equals':
      return value === target
    case 'notEqual':
      return value !== target
    case 'contains':
      return foldedValue.includes(foldedTarget)
    case 'notContains':
      return !foldedValue.includes(foldedTarget)
    case 'startsWith':
      return foldedValue.startsWith(foldedTarget)
    case 'endsWith':
      return foldedValue.endsWith(foldedTarget)
    case 'notStartsWith':
      return !foldedValue.startsWith(foldedTarget)
    case 'notEndsWith':
      return !foldedValue.endsWith(foldedTarget)
    default:
      return null
  }
}

function evaluateGroup(group: FilterGroup, activity: FilterableActivity): SqlBoolean {
  if (group.conditions.length === 0) return null

  const values = group.conditions.map(condition => {
    const result =
      condition.type === 'Filter'
        ? evaluateSingle(condition, activity)
        : evaluateGroup(condition, activity)
    return condition.invert ? invert(result) : result
  })

  let result: SqlBoolean
  if (group.op === 'or') {
    result = values.some(value => value === true)
      ? true
      : values.some(value => value === null)
        ? null
        : false
  } else {
    result = values.some(value => value === false)
      ? false
      : values.some(value => value === null)
        ? null
        : true
  }

  return group.invert ? invert(result) : result
}

export function isHiddenByFilter(
  activity: FilterableActivity,
  filters: readonly { rule: FilterGroup | null }[],
) {
  for (const filter of filters) {
    if (!filter.rule) continue
    try {
      if (evaluateGroup(filter.rule, activity) === true) return true
    } catch {
      // Invalid legacy rules fail open so local history remains visible.
    }
  }
  return false
}
