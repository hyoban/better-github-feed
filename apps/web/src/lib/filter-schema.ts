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

export const filterFnList: FnSchema[] = presetFilter;

/**
 * Empty filter group for creating new user filters
 */
export const emptyFilterGroup = createFilterGroup({
  op: "and",
  conditions: [],
});

/**
 * Serialize a FilterGroup object to JSON string with special date handling
 */
export function serializeFilterGroup(filterGroup: unknown): string {
  const replacer = function (this: Record<string, unknown>, key: string) {
    const value = this[key];
    if (value instanceof Date) {
      return {
        __type: "Date",
        value: value.toISOString(),
      };
    }
    return value;
  };
  return JSON.stringify(filterGroup, replacer);
}
