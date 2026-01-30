import { db } from "@better-github-feed/db";
import {
  feedItem,
  githubUser,
  subscription,
  userFilter,
} from "@better-github-feed/db/schema/github";
import { eventIterator, ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import { deserializeFilterGroup, filterRuleToDrizzleWhere } from "../filter/drizzle-transform";
import { adminProcedure, protectedProcedure } from "../index";
import {
  type ActivityError,
  chunkArray,
  fetchGithubActivity,
  mapFeedItemRow,
  normalizeLogin,
  type RefreshProgressEvent,
} from "./utils";

const loginSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^@?[a-zA-Z0-9-]+$/, "Invalid GitHub username");

export const feedRouter = {
  list: protectedProcedure
    .input(
      z
        .object({
          cursor: z.number().optional(),
          limit: z.number().min(1).max(100).default(20),
          users: z.array(z.string()).optional(),
          types: z.array(z.string()).optional(),
        })
        .optional(),
    )
    .handler(async ({ context, input }) => {
      const userId = context.session.user.id;
      const limit = input?.limit ?? 20;
      const cursor = input?.cursor;
      const usersFilter = input?.users ?? [];
      const typeFilter = input?.types ?? [];

      // Load user's filter rules from DB
      const userFilters = await db.select().from(userFilter).where(eq(userFilter.userId, userId));

      // Build dynamic filter conditions
      const filterConditions = [];

      // Apply user rules
      for (const uf of userFilters) {
        try {
          const rule = deserializeFilterGroup(uf.filterRule);
          const where = filterRuleToDrizzleWhere(rule);
          if (where) filterConditions.push(where);
        } catch {
          // Skip invalid rules
        }
      }

      // Build query with optional cursor filter
      const baseQuery = db
        .select({
          id: feedItem.id,
          githubUserLogin: githubUser.login,
          title: feedItem.title,
          link: feedItem.link,
          repo: feedItem.repo,
          type: feedItem.type,
          summary: feedItem.summary,
          content: feedItem.content,
          publishedAt: feedItem.publishedAt,
        })
        .from(feedItem)
        .innerJoin(githubUser, eq(feedItem.githubUserLogin, githubUser.login))
        .innerJoin(
          subscription,
          and(
            eq(feedItem.githubUserLogin, subscription.githubUserLogin),
            eq(subscription.userId, userId),
          ),
        );

      // Build filter conditions
      const conditions = [];
      // Apply dynamic filter conditions
      if (filterConditions.length > 0) {
        conditions.push(and(...filterConditions));
      }
      if (cursor) {
        conditions.push(sql`${feedItem.publishedAt} < ${cursor}`);
      }
      if (usersFilter.length > 0) {
        conditions.push(inArray(githubUser.login, usersFilter));
      }
      if (typeFilter.length > 0) {
        conditions.push(inArray(feedItem.type, typeFilter));
      }

      const rows = await baseQuery
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(feedItem.publishedAt))
        .limit(limit + 1);

      // Check if there are more items
      const hasMore = rows.length > limit;
      const itemRows = hasMore ? rows.slice(0, limit) : rows;

      const items = itemRows.map((row) => mapFeedItemRow(row));

      // Get next cursor from last item
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem ? lastItem.publishedAtMs : null;

      // Get all types with counts (only on first page for efficiency)
      let types: string[] = [];
      let typeCounts: Record<string, number> = {};
      if (!cursor) {
        // Build conditions for type counts (respects user filter but not type filter)
        const typeCountConditions = [];
        // Apply dynamic filter conditions for type counts too
        if (filterConditions.length > 0) {
          typeCountConditions.push(and(...filterConditions));
        }
        if (usersFilter.length > 0) {
          typeCountConditions.push(inArray(githubUser.login, usersFilter));
        }

        const typeRows = await db
          .select({
            type: feedItem.type,
            count: sql<string>`count(*)`.as("count"),
          })
          .from(feedItem)
          .innerJoin(githubUser, eq(feedItem.githubUserLogin, githubUser.login))
          .innerJoin(
            subscription,
            and(
              eq(feedItem.githubUserLogin, subscription.githubUserLogin),
              eq(subscription.userId, userId),
            ),
          )
          .where(typeCountConditions.length > 0 ? and(...typeCountConditions) : undefined)
          .groupBy(feedItem.type);

        types = typeRows.map((row) => row.type);
        typeCounts = Object.fromEntries(typeRows.map((row) => [row.type, Number(row.count) || 0]));
      }

      return {
        items,
        nextCursor,
        hasMore,
        types,
        typeCounts,
      };
    }),

  refresh: protectedProcedure
    .output(eventIterator(z.custom<RefreshProgressEvent>()))
    .handler(async function* ({ context }) {
      const userId = context.session.user.id;
      // Get all github users that this user is subscribed to
      const subs = await db
        .select({
          githubUserLogin: subscription.githubUserLogin,
        })
        .from(subscription)
        .innerJoin(githubUser, eq(subscription.githubUserLogin, githubUser.login))
        .where(eq(subscription.userId, userId))
        .orderBy(asc(githubUser.lastRefreshedAt));

      if (subs.length === 0) {
        yield { type: "done", errors: [] } as RefreshProgressEvent;
        return;
      }

      yield { type: "start", total: subs.length } as RefreshProgressEvent;

      const refreshedAt = new Date();
      const errors: ActivityError[] = [];
      const events: RefreshProgressEvent[] = [];
      let completed = 0;

      // Start all fetches concurrently
      const promises = subs.map(async (sub, index) => {
        const login = sub.githubUserLogin;

        try {
          const { items, githubId } = await fetchGithubActivity(login);

          const rows = items.map((item) => ({
            id: item.id,
            githubUserLogin: login,
            title: item.title,
            link: item.link,
            repo: item.repo,
            type: item.type,
            summary: item.summary,
            content: item.content,
            publishedAt: new Date(item.publishedAtMs),
          }));

          const chunks = chunkArray(rows, 8);
          for (const chunk of chunks) {
            if (chunk.length === 0) {
              continue;
            }
            await db.insert(feedItem).values(chunk).onConflictDoNothing();
          }

          // Update both lastRefreshedAt and githubId
          const updateData: { lastRefreshedAt: Date; id?: string } = {
            lastRefreshedAt: refreshedAt,
          };
          if (githubId) {
            updateData.id = githubId;
          }

          await db.update(githubUser).set(updateData).where(eq(githubUser.login, login));

          events.push({ type: "success", login, index, itemCount: items.length });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to refresh feed";
          errors.push({ login, message });
          events.push({ type: "error", login, index, message });
        }
        completed += 1;
      });

      // Yield events as they complete
      while (completed < subs.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        while (events.length > 0) {
          yield events.shift()!;
        }
      }

      // Wait for all to complete and yield remaining events
      await Promise.all(promises);
      while (events.length > 0) {
        yield events.shift()!;
      }

      yield { type: "done", errors } as RefreshProgressEvent;
    }),

  refreshOne: protectedProcedure
    .input(z.object({ login: loginSchema }))
    .handler(async ({ context, input }) => {
      const userId = context.session.user.id;
      const login = normalizeLogin(input.login);

      // Verify the user is subscribed to this login
      const existingSub = await db
        .select({ githubUserLogin: subscription.githubUserLogin })
        .from(subscription)
        .where(and(eq(subscription.userId, userId), eq(subscription.githubUserLogin, login)))
        .limit(1);

      const existingSubRow = existingSub[0];
      if (!existingSubRow) {
        throw new ORPCError("NOT_FOUND", { message: "User not in your subscription list" });
      }

      const refreshedAt = new Date();
      const { items, githubId } = await fetchGithubActivity(login);

      const rows = items.map((item) => ({
        id: item.id,
        githubUserLogin: login,
        title: item.title,
        link: item.link,
        repo: item.repo,
        type: item.type,
        summary: item.summary,
        content: item.content,
        publishedAt: new Date(item.publishedAtMs),
      }));

      const chunks = chunkArray(rows, 8);
      for (const chunk of chunks) {
        if (chunk.length === 0) {
          continue;
        }
        await db.insert(feedItem).values(chunk).onConflictDoNothing();
      }

      // Update both lastRefreshedAt and githubId
      const updateData: { lastRefreshedAt: Date; id?: string } = {
        lastRefreshedAt: refreshedAt,
      };
      if (githubId) {
        updateData.id = githubId;
      }

      await db.update(githubUser).set(updateData).where(eq(githubUser.login, login));

      return {
        refreshedAt: refreshedAt.toISOString(),
        itemCount: items.length,
      };
    }),

  clear: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    // Get all github users that this user is subscribed to
    const subs = await db
      .select({ githubUserLogin: subscription.githubUserLogin })
      .from(subscription)
      .where(eq(subscription.userId, userId));

    const githubUserLogins = subs.map((s) => s.githubUserLogin);

    if (githubUserLogins.length > 0) {
      // Delete feed items for subscribed github users
      await db.delete(feedItem).where(inArray(feedItem.githubUserLogin, githubUserLogins));

      // Reset lastRefreshedAt for these github users
      await db
        .update(githubUser)
        .set({ lastRefreshedAt: null })
        .where(inArray(githubUser.login, githubUserLogins));
    }

    return { ok: true };
  }),

  cleanup: adminProcedure
    .input(z.object({ maxItemsPerUser: z.number().min(1).max(1000).default(200) }).optional())
    .handler(async ({ input }) => {
      const maxItems = input?.maxItemsPerUser ?? 200;
      return cleanupOldFeedItems(maxItems);
    }),
};

/**
 * Clean up old feed items - used by cron job
 * Keeps only the most recent N items per GitHub user
 */
export async function cleanupOldFeedItems(maxItemsPerUser = 200) {
  // Get all github users
  const users = await db.select({ login: githubUser.login }).from(githubUser);

  let totalDeleted = 0;

  for (const user of users) {
    const login = user.login;

    // Get the publishedAt of the Nth newest item (the cutoff point)
    const cutoffResult = await db
      .select({ publishedAt: feedItem.publishedAt })
      .from(feedItem)
      .where(eq(feedItem.githubUserLogin, login))
      .orderBy(desc(feedItem.publishedAt))
      .limit(1)
      .offset(maxItemsPerUser - 1);

    const cutoff = cutoffResult[0]?.publishedAt;
    if (!cutoff) {
      // Less than maxItems, nothing to delete
      continue;
    }

    // Delete items older than the cutoff
    const deleted = await db
      .delete(feedItem)
      .where(and(eq(feedItem.githubUserLogin, login), lt(feedItem.publishedAt, cutoff)));

    totalDeleted += deleted.meta.changes;
  }

  return { deleted: totalDeleted };
}

/**
 * Refresh feeds for all github users - used by cron job
 * Only refreshes the 50 least recently refreshed github users each run
 */
export async function refreshAllUsersFeeds() {
  // Get the 50 least recently refreshed github users
  const usersToRefresh = await db
    .select({
      login: githubUser.login,
    })
    .from(githubUser)
    .orderBy(asc(githubUser.lastRefreshedAt))
    .limit(50);

  if (usersToRefresh.length === 0) {
    return [];
  }

  const refreshedAt = new Date();
  let success = 0;
  let failed = 0;

  // Process feeds concurrently
  const promises = usersToRefresh.map(async ({ login }) => {
    try {
      const { items, githubId } = await fetchGithubActivity(login);
      const rows = items.map((item) => ({
        id: item.id,
        githubUserLogin: login,
        title: item.title,
        link: item.link,
        repo: item.repo,
        type: item.type,
        summary: item.summary,
        content: item.content,
        publishedAt: new Date(item.publishedAtMs),
      }));

      const chunks = chunkArray(rows, 8);
      for (const chunk of chunks) {
        if (chunk.length === 0) {
          continue;
        }
        await db.insert(feedItem).values(chunk).onConflictDoNothing();
      }

      // Update both lastRefreshedAt and githubId
      const updateData: { lastRefreshedAt: Date; id?: string } = {
        lastRefreshedAt: refreshedAt,
      };
      if (githubId) {
        updateData.id = githubId;
      }

      await db.update(githubUser).set(updateData).where(eq(githubUser.login, login));

      return { success: true };
    } catch {
      return { success: false };
    }
  });

  const promiseResults = await Promise.all(promises);
  for (const result of promiseResults) {
    if (result.success) {
      success++;
    } else {
      failed++;
    }
  }

  return [{ refreshed: usersToRefresh.length, success, failed }];
}
