import { createFilterGroup, type FnSchema, presetFilter } from "@fn-sphere/filter";
import { z } from "zod";

/**
 * Zod schema for feedItem fields (for fn-sphere validation)
 * This schema defines the filterable fields from feedItem table
 */
export const feedItemFilterSchema = z.object({
  title: z.string().describe("Title"),
  repo: z.string().describe("Repository"),
  type: z.string().describe("Type"),
  summary: z.string().describe("Summary"),
  content: z.string().describe("Content"),
  githubUserLogin: z.string().describe("GitHub User"),
  publishedAt: z.date().describe("Published Date"),
});

export type FeedItemFilterSchema = z.infer<typeof feedItemFilterSchema>;

/**
 * Filter function list (subset of fn-sphere presets)
 * Prioritized for common use cases
 */
const filterPriority = [
  "contains",
  "notContains",
  "equals",
  "notEqual",
  "startsWith",
  "isEmpty",
  "isNotEmpty",
  "before",
  "after",
];

export const filterFnList: FnSchema[] = presetFilter
  .filter(
    (fn) =>
      // Exclude less useful filters for this use case
      fn.name !== "endsWith" && fn.name !== "enumEquals" && fn.name !== "enumNotEqual",
  )
  .sort((a, b) => {
    const indexA = filterPriority.indexOf(a.name);
    const indexB = filterPriority.indexOf(b.name);
    return (indexA === -1 ? Infinity : indexA) - (indexB === -1 ? Infinity : indexB);
  });

/**
 * Empty filter group for creating new user filters
 */
export const emptyFilterGroup = createFilterGroup({
  op: "and",
  conditions: [],
});
