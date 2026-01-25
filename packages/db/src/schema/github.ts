import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Global GitHub user table - stores GitHub users that can be subscribed to
// Primary key is the GitHub login (username)
export const githubUser = sqliteTable("github_user", {
  login: text("login").primaryKey(),
  id: text("id"), // GitHub user ID (e.g., "38493346"), optional
  lastRefreshedAt: integer("last_refreshed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});

// Global feed item table - stores activity items for GitHub users
export const feedItem = sqliteTable(
  "feed_item",
  {
    id: text("id").primaryKey(),
    githubUserLogin: text("github_user_login").notNull(),
    title: text("title").notNull(),
    link: text("link"),
    repo: text("repo"),
    type: text("type").notNull(),
    summary: text("summary"),
    content: text("content"),
    hidden: integer("hidden", { mode: "boolean" }).default(false).notNull(),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("feed_item_github_user_login_idx").on(table.githubUserLogin),
    index("feed_item_github_user_login_published_at_idx").on(
      table.githubUserLogin,
      table.publishedAt,
    ),
    // 支持纯时间排序的游标分页
    index("feed_item_published_at_idx").on(table.publishedAt),
    // 支持类型过滤 + 时间排序
    index("feed_item_type_published_at_idx").on(table.type, table.publishedAt),
  ],
);

// Subscription table - links users to GitHub users they follow
export const subscription = sqliteTable(
  "subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    githubUserLogin: text("github_user_login").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("subscription_user_id_idx").on(table.userId),
    index("subscription_github_user_login_idx").on(table.githubUserLogin),
    uniqueIndex("subscription_user_github_user_idx").on(table.userId, table.githubUserLogin),
  ],
);

// User filter rules table - stores custom filter rules for each user
export const userFilter = sqliteTable(
  "user_filter",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    filterRule: text("filter_rule").notNull(), // Serialized FilterGroup JSON
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [index("user_filter_user_id_idx").on(table.userId)],
);
