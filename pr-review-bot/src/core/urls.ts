export interface ParsedPr {
  owner: string;
  repo: string;
  number: number;
}

export type ParseFailure = "not-a-url" | "not-github" | "not-a-pr" | "is-issue" | "bad-number";

export type ParseResult = { ok: true; pr: ParsedPr } | { ok: false; reason: ParseFailure };

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Identity for deduplication. Lowercased because GitHub treats owner/repo case-insensitively. */
export function prSlug(pr: ParsedPr): string {
  return `${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}/${pr.number}`;
}

export function parsePrUrl(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "not-a-url" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }

  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: "not-github" };

  const parts = url.pathname.split("/").filter((p) => p !== "");
  const [owner, repo, kind, numberRaw] = parts;
  if (owner === undefined || repo === undefined) return { ok: false, reason: "not-a-pr" };
  if (kind === "issues") return { ok: false, reason: "is-issue" };
  if (kind !== "pull") return { ok: false, reason: "not-a-pr" };
  if (numberRaw === undefined) return { ok: false, reason: "not-a-pr" };
  if (!/^\d+$/.test(numberRaw)) return { ok: false, reason: "bad-number" };

  return { ok: true, pr: { owner, repo, number: Number(numberRaw) } };
}
