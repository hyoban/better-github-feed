import type { FilterGroup, SingleFilter } from "@better-github-feed/shared";

import { feedItem } from "@better-github-feed/db/schema/github";
import { type SQL, and, eq, gt, isNotNull, isNull, like, lt, ne, not, or, sql } from "drizzle-orm";

/**
 * Column mapping from filter path to Drizzle column
 */
const columnMap = {
  title: feedItem.title,
  repo: feedItem.repo,
  type: feedItem.type,
  summary: feedItem.summary,
  content: feedItem.content,
  githubUserLogin: feedItem.githubUserLogin,
  publishedAt: feedItem.publishedAt,
} as const;

type ColumnName = keyof typeof columnMap;

function getColumn(path: (string | number)[] | undefined) {
  if (!path || path.length === 0) return null;
  const columnName = path[0] as ColumnName;
  return columnMap[columnName] ?? null;
}

/**
 * Transform a single filter to Drizzle WHERE clause
 */
function transformSingleFilter(filter: SingleFilter): SQL | null {
  const column = getColumn(filter.path);
  if (!column || !filter.name) return null;

  const value = filter.args?.[0];

  // Handle operators
  switch (filter.name) {
    case "equals": {
      if (value === undefined || value === null) return null;
      if (column === feedItem.publishedAt && value instanceof Date) {
        return eq(column, value);
      }
      return eq(column as typeof feedItem.title, String(value));
    }

    case "notEqual": {
      if (value === undefined || value === null) return null;
      if (column === feedItem.publishedAt && value instanceof Date) {
        return ne(column, value);
      }
      return ne(column as typeof feedItem.title, String(value));
    }

    case "contains": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return like(column as typeof feedItem.title, `%${escapeLike(value)}%`);
    }

    case "notContains": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return not(like(column as typeof feedItem.title, `%${escapeLike(value)}%`));
    }

    case "startsWith": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return like(column as typeof feedItem.title, `${escapeLike(value)}%`);
    }

    case "endsWith": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return like(column as typeof feedItem.title, `%${escapeLike(value)}`);
    }

    case "notStartsWith": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return not(like(column as typeof feedItem.title, `${escapeLike(value)}%`));
    }

    case "notEndsWith": {
      if (value === undefined || value === null || typeof value !== "string") return null;
      return not(like(column as typeof feedItem.title, `%${escapeLike(value)}`));
    }

    case "isEmpty": {
      // For nullable strings: value is null OR value is empty string
      return or(isNull(column), eq(column as typeof feedItem.title, "")) ?? null;
    }

    case "isNotEmpty": {
      // For nullable strings: value is not null AND value is not empty string
      return and(isNotNull(column), ne(column as typeof feedItem.title, "")) ?? null;
    }

    case "before": {
      if (!(value instanceof Date)) return null;
      return lt(feedItem.publishedAt, value);
    }

    case "after": {
      if (!(value instanceof Date)) return null;
      return gt(feedItem.publishedAt, value);
    }

    case "greaterThan": {
      if (typeof value !== "number") return null;
      // For numeric comparisons on non-date columns
      return sql`${column} > ${value}`;
    }

    case "lessThan": {
      if (typeof value !== "number") return null;
      // For numeric comparisons on non-date columns
      return sql`${column} < ${value}`;
    }

    default:
      return null;
  }
}

/**
 * Escape special characters in LIKE patterns
 */
function escapeLike(value: string): string {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Transform a filter group to Drizzle WHERE clause
 */
function transformFilterGroup(filterGroup: FilterGroup): SQL | null {
  if (!filterGroup.conditions || filterGroup.conditions.length === 0) {
    return null;
  }

  const conditions: SQL[] = [];

  for (const condition of filterGroup.conditions) {
    let result: SQL | null = null;

    if (condition.type === "Filter") {
      result = transformSingleFilter(condition);
    } else if (condition.type === "FilterGroup") {
      result = transformFilterGroup(condition);
    }

    if (result) {
      // Handle invert for individual conditions
      if (condition.invert) {
        conditions.push(not(result));
      } else {
        conditions.push(result);
      }
    }
  }

  if (conditions.length === 0) {
    return null;
  }

  // Combine conditions with AND or OR
  let combined: SQL;
  if (filterGroup.op === "or") {
    const orResult = or(...conditions);
    combined = conditions.length === 1 ? conditions[0]! : (orResult ?? conditions[0]!);
  } else {
    const andResult = and(...conditions);
    combined = conditions.length === 1 ? conditions[0]! : (andResult ?? conditions[0]!);
  }

  // Handle group-level invert
  if (filterGroup.invert) {
    return not(combined);
  }

  return combined;
}

/**
 * Transform fn-sphere FilterGroup to Drizzle WHERE clause
 */
export function filterRuleToDrizzleWhere(filterGroup: FilterGroup): SQL | null {
  return transformFilterGroup(filterGroup);
}

/**
 * Serialize a FilterGroup object to JSON string with special date handling
 */
export function serializeFilterGroup(filterGroup: FilterGroup): string {
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

/**
 * Deserialize a JSON string back to FilterGroup object
 */
export function deserializeFilterGroup(serialized: string): FilterGroup {
  const deserialized = JSON.parse(serialized, (_, value) => {
    // Revive Date objects from special format
    if (value && typeof value === "object" && value.__type === "Date") {
      return new Date(value.value);
    }
    return value;
  });

  // Type guard to ensure we have a valid FilterGroup
  if (!isValidFilterGroup(deserialized)) {
    throw new Error("Invalid FilterGroup structure");
  }
  return deserialized;
}

/**
 * Type guard to validate FilterGroup structure
 */
function isValidFilterGroup(obj: unknown): obj is FilterGroup {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "id" in obj &&
    typeof obj.id === "string" &&
    "type" in obj &&
    obj.type === "FilterGroup" &&
    "op" in obj &&
    (obj.op === "and" || obj.op === "or") &&
    "conditions" in obj &&
    Array.isArray(obj.conditions)
  );
}
