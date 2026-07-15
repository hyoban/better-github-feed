import type { FilterGroup, FnSchema, SingleFilter } from '@fn-sphere/filter'
import { createFilterGroup, defineTypedFn, presetFilter } from '@fn-sphere/filter'
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
    if (!target) return true
    if (typeof value !== 'string') return false
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
    if (!target) return true
    if (typeof value !== 'string') return false
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

const filterIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FilterGroup['id'])
const filterMetaSchema = z.record(z.string(), z.unknown()).optional()
const stringFieldSchema = z.enum(['title', 'repo', 'type', 'summary', 'content', 'githubUserLogin'])
const stringValueOperatorSchema = z.enum([
  'equals',
  'notEqual',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'notStartsWith',
  'notEndsWith',
])
const stringPresenceOperatorSchema = z.enum(['isEmpty', 'isNotEmpty'])
const dateOperatorSchema = z.enum(['before', 'after'])
const singleFilterBaseSchema = {
  id: filterIdSchema,
  type: z.literal('Filter'),
  invert: z.boolean().optional(),
  meta: filterMetaSchema,
}
const singleFilterSchema: z.ZodType<SingleFilter> = z.union([
  z.object({
    ...singleFilterBaseSchema,
    path: z.tuple([stringFieldSchema]),
    name: stringValueOperatorSchema,
    args: z.tuple([z.string()]),
  }),
  z.object({
    ...singleFilterBaseSchema,
    path: z.tuple([stringFieldSchema]),
    name: stringPresenceOperatorSchema,
    args: z.tuple([]),
  }),
  z.object({
    ...singleFilterBaseSchema,
    path: z.tuple([z.literal('publishedAt')]),
    name: dateOperatorSchema,
    args: z.tuple([z.date()]),
  }),
])

const recursiveFilterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    id: filterIdSchema,
    type: z.literal('FilterGroup'),
    op: z.enum(['and', 'or']),
    conditions: z.array(z.union([singleFilterSchema, recursiveFilterGroupSchema])).min(1),
    invert: z.boolean().optional(),
    meta: filterMetaSchema,
  }),
)

export const filterGroupSchema = recursiveFilterGroupSchema

export const filterFnList: FnSchema[] = [...presetFilter, ...customFilters]

/**
 * Empty filter group for creating new user filters
 */
export const emptyFilterGroup: FilterGroup = createFilterGroup({
  op: 'and',
  conditions: [],
})
