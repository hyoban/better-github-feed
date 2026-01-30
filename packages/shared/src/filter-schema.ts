import type { FilterGroup, FnSchema, SingleFilter } from '@fn-sphere/filter'
import {
  createFilterGroup,
  defineTypedFn,
  presetFilter,
} from '@fn-sphere/filter'
import { z } from 'zod'

export type { FilterGroup, SingleFilter }

/**
 * Custom filter: not starts with
 */
const notStartsWith = defineTypedFn({
  name: 'notStartsWith',
  define: z.function({
    input: [z.string(), z.coerce.string()],
    output: z.boolean(),
  }),
  implement: (value, target) => {
    if (!target)
      return true
    if (typeof value !== 'string')
      return false
    return !value.toLowerCase().startsWith(target.toLowerCase())
  },
})

/**
 * Custom filter: not ends with
 */
const notEndsWith = defineTypedFn({
  name: 'notEndsWith',
  define: z.function({
    input: [z.string(), z.coerce.string()],
    output: z.boolean(),
  }),
  implement: (value, target) => {
    if (!target)
      return true
    if (typeof value !== 'string')
      return false
    return !value.toLowerCase().endsWith(target.toLowerCase())
  },
})

const customFilters = [notStartsWith, notEndsWith]

/**
 * Zod schema for feedItem fields (for fn-sphere validation)
 * This schema defines the filterable fields from feedItem table
 */
export const feedItemFilterSchema = z.object({
  title: z.string().describe('Title'),
  repo: z.string().describe('Repository'),
  type: z.string().describe('Type'),
  summary: z.string().describe('Summary'),
  content: z.string().describe('Content'),
  githubUserLogin: z.string().describe('GitHub User'),
  publishedAt: z.date().describe('Published Date'),
})

export type FeedItemFilterSchema = z.infer<typeof feedItemFilterSchema>

export const filterFnList: FnSchema[] = [...presetFilter, ...customFilters]

/**
 * Empty filter group for creating new user filters
 */
export const emptyFilterGroup: FilterGroup = createFilterGroup({
  op: 'and',
  conditions: [],
})

/**
 * Serialize a FilterGroup object to JSON string with special date handling
 */
export function serializeFilterGroup(filterGroup: unknown): string {
  const replacer = function (this: Record<string, unknown>, key: string) {
    const value = this[key]
    if (value instanceof Date) {
      return {
        __type: 'Date',
        value: value.toISOString(),
      }
    }
    return value
  }
  return JSON.stringify(filterGroup, replacer)
}
