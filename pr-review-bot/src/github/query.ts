import type { PrSnapshot, ReviewEvent } from "../core/exit.js";
import { routeOwner, type CredentialGroup, type CredentialProvider } from "./credentials.js";

const GRAPHQL = "https://api.github.com/graphql";
/** Requests running longer than 10 seconds are terminated by GitHub with a 502/504. */
const CHUNK_SIZE = 25;

interface Target {
  alias: string;
  slug: string;
  owner: string;
  repo: string;
  number: number;
}

export interface FetchOutcome {
  snapshots: Map<string, PrSnapshot>;
  /** Aliases GitHub could not resolve. Map these to `sync paused`, never resolved. */
  notFound: string[];
  failedGroups: CredentialGroup[];
  subrequests: number;
}

export function buildQuery(prs: { alias: string; owner: string; repo: string; number: number }[]): string {
  const parts = prs.map(
    (pr) => `  ${pr.alias}: repository(owner: ${JSON.stringify(pr.owner)}, name: ${JSON.stringify(pr.repo)}) {
    pullRequest(number: ${pr.number}) {
      number
      title
      isDraft
      merged
      state
      mergedAt
      closedAt
      author { login }
      reviews(last: 20) {
        nodes {
          submittedAt
          state
          author { login __typename }
        }
      }
    }
  }`,
  );
  // No reviewDecision: it is null on unprotected branches, never resets after a
  // push, and ignores comment-only reviews. Requesting it at all is a defect.
  return `query {\n${parts.join("\n")}\n}`;
}

interface RawReview {
  submittedAt: string | null;
  state: string;
  author: { login: string; __typename?: string } | null;
}

interface RawPr {
  number: number;
  title: string;
  isDraft: boolean;
  merged: boolean;
  state: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  author: { login: string } | null;
  reviews: { nodes: RawReview[] } | null;
}

function toReview(raw: RawReview): ReviewEvent {
  return {
    submittedAt: raw.submittedAt === null ? null : Date.parse(raw.submittedAt),
    state: raw.state,
    authorLogin: raw.author?.login ?? null,
    authorIsBot: raw.author?.__typename === "Bot",
  };
}

function toSnapshot(slug: string, raw: RawPr): PrSnapshot {
  return {
    slug,
    title: raw.title,
    state: raw.merged ? "MERGED" : raw.state === "CLOSED" ? "CLOSED" : "OPEN",
    merged: raw.merged,
    isDraft: raw.isDraft,
    authorLogin: raw.author?.login ?? null,
    reviews: (raw.reviews?.nodes ?? []).map(toReview),
    mergedAt: raw.mergedAt ? Date.parse(raw.mergedAt) : null,
    closedAt: raw.closedAt ? Date.parse(raw.closedAt) : null,
  };
}

function parseSlug(slug: string, index: number): Target | null {
  const [owner, repo, numberRaw] = slug.split("/");
  if (owner === undefined || repo === undefined || numberRaw === undefined) return null;
  const number = Number(numberRaw);
  if (!Number.isInteger(number)) return null;
  return { alias: `p${index}`, slug, owner, repo, number };
}

export async function fetchSnapshots(
  provider: CredentialProvider,
  slugs: string[],
  now: number,
): Promise<FetchOutcome> {
  const snapshots = new Map<string, PrSnapshot>();
  const notFound: string[] = [];
  const failedGroups: CredentialGroup[] = [];
  let subrequests = 0;

  const byGroup = new Map<CredentialGroup, string[]>();
  for (const slug of slugs) {
    const owner = slug.split("/")[0] ?? "";
    const group = routeOwner(owner);
    byGroup.set(group, [...(byGroup.get(group) ?? []), slug]);
  }

  for (const [group, groupSlugs] of byGroup) {
    const token = await provider.tokenFor(group, now);
    if (!token.ok) {
      failedGroups.push(group);
      continue;
    }

    for (let offset = 0; offset < groupSlugs.length; offset += CHUNK_SIZE) {
      const chunk = groupSlugs.slice(offset, offset + CHUNK_SIZE);
      const targets = chunk
        .map((slug, index) => parseSlug(slug, index))
        .filter((t): t is Target => t !== null);
      if (targets.length === 0) continue;

      const response = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "pr-review-bot",
        },
        body: JSON.stringify({ query: buildQuery(targets) }),
      });
      subrequests += 1;

      // 429 joins 401/403 here so a rate limit reaches the provider's backoff
      // instead of falling into the `!response.ok` branch, which would retry the
      // next chunk immediately against a limit that just said stop.
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        provider.reportStatus(group, response.status, now, response.headers);
        if (!failedGroups.includes(group)) failedGroups.push(group);
        break;
      }
      if (!response.ok) {
        if (!failedGroups.includes(group)) failedGroups.push(group);
        continue;
      }

      const body = (await response.json()) as {
        data?: Record<string, { pullRequest: RawPr | null } | null>;
        errors?: { type?: string; path?: (string | number)[] }[];
      };

      // The errors array must be read even on HTTP 200: a batch containing one
      // inaccessible PR returns partial data plus a NOT_FOUND for that alias.
      // Treating the whole response as failed would freeze all syncing; treating
      // a null as "gone" would delete good records.
      const errors = body.errors ?? [];
      const missingAliases = new Set(
        errors
          .filter((e) => e.type === "NOT_FOUND")
          .map((e) => String(e.path?.[0] ?? ""))
          .filter((alias) => alias !== ""),
      );
      // NOT_FOUND is the only error type that describes one row. Every other
      // type — RATE_LIMITED, FORBIDDEN, SERVICE_UNAVAILABLE, a malformed query —
      // describes the request.
      const requestFailed = errors.some((e) => e.type !== "NOT_FOUND");

      // A GraphQL failure arrives as HTTP 200 with `data: null`, so status alone
      // cannot see it. Reading that as "every PR in this chunk was deleted" is
      // the worst available answer: it emits markSyncPaused for every open row
      // while `syncOk` stays true, so the tick writes a fresh `lastSync` and the
      // digest claims to be current while every row says it is not. One primary
      // rate limit would paint the whole list. Fail the group instead, and stop
      // sending — the next chunk hits the same limit.
      if (body.data === null || body.data === undefined) {
        if (!failedGroups.includes(group)) failedGroups.push(group);
        break;
      }

      for (const target of targets) {
        if (missingAliases.has(target.alias)) {
          notFound.push(target.slug);
          continue;
        }
        const raw = body.data[target.alias]?.pullRequest;
        if (raw === undefined || raw === null) {
          // No data for this alias and no NOT_FOUND naming it. If the response
          // carried a request-level error, that error is the explanation and
          // "gone" is not — this is the same misreading as the `data: null`
          // case, one row at a time. Only an otherwise-clean response makes a
          // missing alias mean the PR is really unreachable.
          if (requestFailed) {
            if (!failedGroups.includes(group)) failedGroups.push(group);
            continue;
          }
          notFound.push(target.slug);
          continue;
        }
        snapshots.set(target.slug, toSnapshot(target.slug, raw));
      }
    }
  }

  return { snapshots, notFound, failedGroups, subrequests };
}
