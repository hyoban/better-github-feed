export type ActivityItem = {
  id: string;
  actor: string;
  title: string;
  link: string | null;
  repo: string | null;
  type: string;
  publishedAt: string;
  publishedAtMs: number;
  summary: string | null;
  content: string | null;
  source: string;
};

export type ActivityError = {
  login: string;
  message: string;
};

export type RefreshProgressEvent =
  | { type: "start"; total: number }
  | { type: "success"; login: string; index: number; itemCount: number }
  | { type: "error"; login: string; index: number; message: string }
  | { type: "done"; errors: ActivityError[] };

export function normalizeLogin(input: string) {
  return input.trim().replace(/^@/, "").toLowerCase();
}

export function chunkArray<T>(items: T[], size: number) {
  if (items.length <= size) {
    return [items];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function decodeHtmlEntities(value: string) {
  const entityMap: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };

  return value
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (match) => entityMap[match] ?? match)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtmlTags(value: string) {
  return value.replace(/<[^>]*>/g, " ");
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function extractTagValue(source: string, tag: string) {
  const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim() ?? null;
}

function extractLinkHref(source: string) {
  const alternate = source.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alternate?.[1]) {
    return alternate[1];
  }

  const anyLink = source.match(/<link[^>]*href=["']([^"']+)["']/i);
  return anyLink?.[1] ?? null;
}

function extractRepoFromLink(link: string | null) {
  if (!link) {
    return null;
  }

  try {
    const url = new URL(link);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
  } catch {
    return null;
  }

  return null;
}

function extractRepoFromTitle(title: string) {
  const match = title.match(/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  return match?.[1] ?? null;
}

function extractTypeFromId(entryId: string): string {
  // ID format: tag:github.com,2008:<type>/<number>
  const match = entryId.match(/tag:github\.com,\d+:([^/]+)/);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

function parseEntry(entry: string, fallbackActor: string): ActivityItem | null {
  const titleRaw = extractTagValue(entry, "title");
  if (!titleRaw) {
    return null;
  }

  const link = extractLinkHref(entry);
  const publishedRaw = extractTagValue(entry, "published") ?? extractTagValue(entry, "updated");
  const publishedDate = publishedRaw ? new Date(publishedRaw) : null;
  const publishedAt = publishedDate?.toISOString() ?? new Date().toISOString();
  const publishedAtMs = publishedDate?.getTime() ?? Date.now();

  const authorBlock = extractTagValue(entry, "author");
  const authorName = authorBlock ? extractTagValue(authorBlock, "name") : null;

  const title = decodeHtmlEntities(titleRaw);
  const contentRaw = extractTagValue(entry, "content");
  const summaryText = contentRaw
    ? collapseWhitespace(stripHtmlTags(decodeHtmlEntities(contentRaw)))
    : null;
  const summary = summaryText ? summaryText.slice(0, 220) : null;
  const content = contentRaw ? decodeHtmlEntities(contentRaw) : null;
  const repo = extractRepoFromLink(link) ?? extractRepoFromTitle(title);
  const entryId = decodeHtmlEntities(extractTagValue(entry, "id") ?? link ?? title);

  return {
    id: entryId,
    actor: authorName ?? fallbackActor,
    title,
    link,
    repo,
    type: extractTypeFromId(entryId),
    publishedAt,
    publishedAtMs,
    summary,
    content,
    source: fallbackActor,
  };
}

function parseGithubAtomFeed(feedXml: string, login: string) {
  const entries = feedXml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) ?? [];
  return entries
    .map((entry) => parseEntry(entry, login))
    .filter((item): item is ActivityItem => item !== null);
}

export function extractGithubIdFromFeed(feedXml: string): string | null {
  // Extract github ID from media:thumbnail URL
  // Format: https://avatars.githubusercontent.com/u/38493346?s=30&v=4
  const match = feedXml.match(
    /<media:thumbnail[^>]*url=["']https:\/\/avatars\.githubusercontent\.com\/u\/(\d+)/i,
  );
  return match?.[1] ?? null;
}

export async function fetchGithubUserId(login: string): Promise<string | null> {
  try {
    const url = `https://github.com/${login}.atom`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "better-github-feed",
      },
    });

    if (!response.ok) {
      return null;
    }

    const feedText = await response.text();
    return extractGithubIdFromFeed(feedText);
  } catch {
    return null;
  }
}

export async function fetchGithubActivity(login: string) {
  const url = `https://github.com/${login}.atom`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "better-github-feed",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${login} activity`);
  }

  const feedText = await response.text();
  return {
    items: parseGithubAtomFeed(feedText, login),
    githubId: extractGithubIdFromFeed(feedText),
  };
}

export type FeedItemRow = {
  id: string;
  githubUserLogin: string;
  title: string;
  link: string | null;
  repo: string | null;
  type: string;
  summary: string | null;
  content: string | null;
  hidden?: boolean;
  publishedAt: Date;
  createdAt?: Date;
};

export function mapFeedItemRow(row: FeedItemRow): ActivityItem {
  const publishedAt = row.publishedAt instanceof Date ? row.publishedAt : new Date(row.publishedAt);
  const publishedAtMs = publishedAt.getTime();
  const safeDate = Number.isNaN(publishedAtMs) ? new Date() : publishedAt;

  return {
    id: row.id,
    actor: row.githubUserLogin,
    title: row.title,
    link: row.link,
    repo: row.repo,
    type: row.type,
    publishedAt: safeDate.toISOString(),
    publishedAtMs: Number.isNaN(publishedAtMs) ? safeDate.getTime() : publishedAtMs,
    summary: row.summary,
    content: row.content,
    source: row.githubUserLogin,
  };
}
