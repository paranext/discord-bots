import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProvider } from "../../src/github/credentials.js";
import { buildQuery, fetchSnapshots } from "../../src/github/query.js";
import batch from "../../fixtures/responses/github-batch.json" with { type: "json" };
import rateLimited from "../../fixtures/responses/github-rate-limited.json" with { type: "json" };

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const HOUR = 3_600_000;

// A throwaway 2048-bit RSA key generated for tests only — see Step 2. Not a
// credential. Real (not a placeholder string) because the "groups by credential"
// test below actually mints an App JWT, and an unparseable PEM throws before the
// test can assert anything about the request it's meant to check.
const TEST_PEM_PLACEHOLDER =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDYZawEfbQ0JgKi\naNfd1vBTk9GxV3Bou4fofH3Y1+idgZgqop/Lrh//rEEUAyWLK59TktiVbnHs1tDH\nXvQIK0NEOQBntxCOXQBDqVS2wpX+biiW6lt127moHS8KQcQwPGY6ArIMyWRwCYwd\neFxKeTy4mk6l4k4OouiMx/zVdNd1WiuKZ1f+TqdCLCZHxAygag/1qPvYe0GKXOV7\nR5OksKfWyyPJGWopLU5W1C9zifOVzqNcn8izT2eEgowKkNE87+pmnPjlGPmZkFWR\nEmW0t1ocdVwz7TQQbtJRjvNHan5mWYH2jJ1FRick7fsTfuQwOQ0hYVGM8zNC+0Ec\nrTjVzuzLAgMBAAECggEAXeV4B5bX24zmtbwSdtLuAwXwBihvwTImHc3u+WluKPHz\nqgRYnBOZFOKUdm+LGeE6yBO+4NBEpMTtYKUl9Gl5TaACOf6oM23NUI6oEIlMdlMs\nT5evSeummnjXUXcJ/vgmT2OeCIhWiXrLDnqMaVBD9cIXAEm7HwS3LWcVoTWKzAMg\n75udsSlnGvwsmKUjtaoA5zdlRmNcfB2fk8sl+/LHOhL/woSisExwEVJBw9z0re1d\n4BfkWzoPhNBoykzRkrigSXCBbq6ZbthNTh8EOFIM1aYEKmPTmTMDGpPwUOGgjLSv\nDwObZU7OgZW6/dxA12Sbhfu6VTXkwqhxoYjrI7jsmQKBgQDxk9iMx2L24aZvv4J6\noGl/PdBdspVqbnZod37/bBEiPPJ7PFi6xA4inwaW6rSnvB0bS16TFaR9dDwCd6Ha\nveEa16HQae8eMJ3rC0GaRZ2SRVE3DqqN4xpy90RB6q2daLWkGgiXLI2BpZhUF9hl\noHNzO0W3szYgAcVwd9vKxqRBjwKBgQDlUPtCr9JKedNO3yrRc0xHbZCmBJ6PjdCv\n+S5jfZVUYuvA/tzsdWWaFssFOAfSVm4BsbAUEnFD+KLQqw3lZ61MFBnNpUkFrlbo\ndj0XBhOoWlV4fqUSbh9/uEj00Ys8amwnNx5SDNq2i1nAjaqX1+moBvkgy+HE4l5Z\nmxl/KG+LBQKBgCZl+qi91JQrX9opVaMKNlqcR69tAGTvc/C89bnBwqNvjpdaCzx8\nh0anglOgsOBsfS/mdfzpFsE+JX+65kYvokUy+yx2eiSRU7iVjHLqF9a1H+ihcyik\nbYLSnM3hcIExsJWJ8c2drkxqNuE+/Q2CSHeLd1Rwruy9e1WaJ5x+oIMvAoGBAODn\nb8aT0leg7BHq5n/N6P4VA00QMsLwf8BXT5vcS10cN8RtMhfne+KIgE16CpHMms+m\nid7lx5i2fljRqytXZ6u5+ySp+thLiIktjfTKzPTMxA8NhrBwuQv2nfcenMSAS9qa\nQG6QlOF8AmbLioiqBkv5qtTzoVYL/iU77OG9sshRAoGAHFhgW6E8WUdMsJeE46dI\nq/rGnbgVtVeHplxSsNa3mbH8/4o+OehFJbYuQId3pSr0ygxSDScIz+QsF5zJCE8K\nxLo5WZ5/cKWKwcj3om1Mzdvttoqrzq8xmKcfJnMSh1bGsd5P0t7JqaCTuZJOYLYm\n6k8W8ucCfi3OORkMQsw+pBQ=\n-----END PRIVATE KEY-----\n";

const secrets = {
  appId: "1",
  appInstallationId: "2",
  appPrivateKeyPem: TEST_PEM_PLACEHOLDER,
  publicToken: "ghp_public",
};

// buildQuery aliases each PR as `p0: repository(...) { pullRequest(number: N) { ... } }`,
// so a real response nests the PR node one level deeper than the alias — the
// implementation reads `body.data?.[alias]?.pullRequest`. Every fixture below must
// carry that wrapper, or every one of these tests would land every slug in
// `notFound` against a real server, however green they are against each other.
function prNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    pullRequest: {
      number,
      title: `PT-${number}`,
      isDraft: false,
      merged: false,
      state: "OPEN",
      author: { login: "jolie" },
      reviews: { nodes: [] },
      ...overrides,
    },
  };
}

/**
 * Routes by URL, exactly like Task 17's `stubAll`: an App-credential mint
 * (`/access_tokens`) is itself a `fetch` that a call-count-only stub would
 * misroute — the mint request has no JSON body, so treating it as a GraphQL call
 * would blow up `JSON.parse`. Only `/graphql` calls are pushed into `requests`.
 */
function stubGraphql(bodies: unknown[]) {
  const requests: { query: string }[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = String(input);
    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: "ghs_x", expires_at: new Date(T0 + HOUR).toISOString() }),
        { status: 201 },
      );
    }
    requests.push(JSON.parse(String(init.body)) as { query: string });
    const body = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("buildQuery", () => {
  const prs = [{ alias: "p0", owner: "eten-tech-foundation", repo: "scripture-editors", number: 341 }];

  it("requests reviews with submittedAt, state and a Bot-aware author", () => {
    const query = buildQuery(prs);
    expect(query).toContain("reviews(last: 20)");
    expect(query).toContain("submittedAt");
    expect(query).toContain("__typename");
  });

  it("NEVER requests reviewDecision", () => {
    expect(buildQuery(prs)).not.toContain("reviewDecision");
  });

  it("aliases each PR so a partial error can be mapped back to one record", () => {
    expect(buildQuery(prs)).toContain("p0:");
  });
});

describe("fetchSnapshots", () => {
  const provider = () => new CredentialProvider(secrets);

  it("returns a snapshot per requested slug", async () => {
    stubGraphql([{ data: { p0: prNode(341) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      title: "PT-341",
      state: "OPEN",
      authorLogin: "jolie",
    });
  });

  it("chunks to 25 PRs per query", async () => {
    const slugs = Array.from({ length: 60 }, (_, i) => `eten-tech-foundation/scripture-editors/${i + 1}`);
    const data = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, prNode(i + 1)]));
    const requests = stubGraphql([{ data }, { data }, { data }]);
    const outcome = await fetchSnapshots(provider(), slugs, T0);
    expect(requests).toHaveLength(3);
    expect(outcome.subrequests).toBe(3);
  });

  it("maps a NOT_FOUND alias to notFound and leaves every other record alone", async () => {
    stubGraphql([
      {
        data: { p0: prNode(341), p1: null },
        errors: [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a PullRequest" }],
      },
    ]);
    const outcome = await fetchSnapshots(
      provider(),
      ["eten-tech-foundation/scripture-editors/341", "eten-tech-foundation/scripture-editors/999"],
      T0,
    );
    expect(outcome.notFound).toEqual(["eten-tech-foundation/scripture-editors/999"]);
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/341")).toBe(true);
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/999")).toBe(false);
  });

  it("fails the group on a RATE_LIMITED 200 instead of reporting every PR missing", async () => {
    // The defect this pins: GitHub answers a rate limit with HTTP 200 and
    // `{errors: [...], data: null}`. Reading that as "every PR in the chunk was
    // deleted" pushes every slug onto notFound while failedGroups stays empty,
    // so the caller keeps syncOk true, writes a fresh lastSync, and paints
    // "sync paused" on every row of a digest whose header claims it just
    // synced. notFound MUST be empty here — that assertion is the whole test.
    stubGraphql([
      {
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      },
    ]);
    const outcome = await fetchSnapshots(
      provider(),
      ["eten-tech-foundation/scripture-editors/341", "eten-tech-foundation/scripture-editors/342"],
      T0,
    );
    expect(outcome.failedGroups).toEqual(["public"]);
    expect(outcome.notFound).toEqual([]);
    expect(outcome.snapshots.size).toBe(0);
  });

  it("stops sending a group's later chunks once one comes back rate limited", async () => {
    // Unlike a transient 500 (which `continue`s to the next chunk), a rate limit
    // is a property of the credential, not of the chunk — the next chunk hits
    // the same limit. Needs 2+ chunks to be able to fail: with one chunk,
    // break and continue are indistinguishable.
    const slugs = Array.from({ length: 30 }, (_, i) => `eten-tech-foundation/scripture-editors/${i + 1}`);
    const requests = stubGraphql([
      { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
    ]);
    const outcome = await fetchSnapshots(provider(), slugs, T0);
    expect(requests).toHaveLength(1);
    expect(outcome.subrequests).toBe(1);
    expect(outcome.failedGroups).toEqual(["public"]);
    expect(outcome.notFound).toEqual([]);
  });

  it("keeps a partial response's good rows but will not call an unexplained alias missing", async () => {
    // Partial data plus a non-NOT_FOUND error: p0 resolved, p1 did not, and
    // nothing says p1 is gone. The good row is still worth keeping; calling p1
    // "not found" would be the data:null misreading one row at a time, so the
    // group is failed and p1 is left untouched instead.
    stubGraphql([
      {
        data: { p0: prNode(341), p1: null },
        errors: [{ type: "SERVICE_UNAVAILABLE", path: ["p1"], message: "timed out" }],
      },
    ]);
    const outcome = await fetchSnapshots(
      provider(),
      ["eten-tech-foundation/scripture-editors/341", "eten-tech-foundation/scripture-editors/999"],
      T0,
    );
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/341")).toBe(true);
    expect(outcome.notFound).toEqual([]);
    expect(outcome.failedGroups).toEqual(["public"]);
  });

  it("parses reviews, flagging bot authors by __typename", async () => {
    stubGraphql([
      {
        data: {
          p0: prNode(341, {
            reviews: {
              nodes: [
                { submittedAt: "2026-08-30T10:00:00Z", state: "COMMENTED", author: { login: "copilot", __typename: "Bot" } },
                { submittedAt: "2026-08-30T11:00:00Z", state: "APPROVED", author: { login: "katherine", __typename: "User" } },
                { submittedAt: null, state: "PENDING", author: { login: "ira", __typename: "User" } },
              ],
            },
          }),
        },
      },
    ]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    const reviews = outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")!.reviews;
    expect(reviews[0]).toMatchObject({ authorIsBot: true });
    expect(reviews[1]).toMatchObject({ authorIsBot: false, authorLogin: "katherine" });
    expect(reviews[2]).toMatchObject({ submittedAt: null });
  });

  it("derives MERGED state from the merged flag, not from GitHub's own state field", async () => {
    // GitHub's raw state says CLOSED here — an implementation that passed raw.state
    // straight through, ignoring `merged`, would also produce a plausible-looking
    // result if the fixture's state field already said "MERGED".
    stubGraphql([{ data: { p0: prNode(341, { merged: true, state: "CLOSED" }) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      merged: true,
      state: "MERGED",
    });
  });

  it("keeps CLOSED state when merged is false", async () => {
    stubGraphql([{ data: { p0: prNode(341, { merged: false, state: "CLOSED" }) } }]);
    const outcome = await fetchSnapshots(provider(), ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.snapshots.get("eten-tech-foundation/scripture-editors/341")).toMatchObject({
      merged: false,
      state: "CLOSED",
    });
  });

  it("groups by credential, so paranext and other owners are separate queries", async () => {
    // paranext routes to "app", which mints a JWT and hits /access_tokens BEFORE
    // it can query — that mint is a real fetch too, and must not be counted as
    // one of the two graphql requests this test exists to prove.
    const requests = stubGraphql([{ data: { p0: prNode(1) } }, { data: { p0: prNode(2) } }]);
    await fetchSnapshots(provider(), ["paranext/paranext-core/1", "eten-tech-foundation/scripture-editors/2"], T0);
    expect(requests).toHaveLength(2);
  });

  it("keeps querying later chunks after one chunk transiently fails, returning partial data", async () => {
    // A transient per-chunk failure (a 500, not a 401/403 auth failure) marks
    // the group failed but must NOT abort the group: later chunks are still
    // worth their data. This is `continue`, not `break` — the distinction
    // only shows up with 2+ chunks in one group, which is why every other
    // test here (single chunk) could pass whether the code used continue or
    // break.
    const slugs = Array.from({ length: 30 }, (_, i) => `eten-tech-foundation/scripture-editors/${i + 1}`);
    let call = 0;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(T0 + HOUR).toISOString() }), { status: 201 });
      }
      call += 1;
      if (call === 1) {
        // First chunk (slugs 1-25) fails transiently.
        return new Response(JSON.stringify({ message: "server error" }), { status: 500 });
      }
      // Second chunk (slugs 26-30): 5 targets, aliased p0..p4.
      void init;
      const data = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${i}`, prNode(26 + i)]));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });

    const outcome = await fetchSnapshots(provider(), slugs, T0);

    expect(outcome.failedGroups).toEqual(["public"]);
    // The second chunk's data made it through.
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/26")).toBe(true);
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/30")).toBe(true);
    // The first (failed) chunk contributed nothing — its data is simply
    // absent, not present-but-wrong.
    expect(outcome.snapshots.has("eten-tech-foundation/scripture-editors/1")).toBe(false);
    expect(outcome.snapshots.size).toBe(5);
  });

  it("records a failed group on a 401 rather than throwing, and fails it closed", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const shared = provider();
    const outcome = await fetchSnapshots(shared, ["eten-tech-foundation/scripture-editors/341"], T0);
    expect(outcome.failedGroups).toEqual(["public"]);
    expect(outcome.snapshots.size).toBe(0);
    expect(await shared.tokenFor("public", T0)).toMatchObject({ ok: false, failedClosed: true });
  });

  it("does no work and no subrequests for an empty slug list", async () => {
    const requests = stubGraphql([]);
    const outcome = await fetchSnapshots(provider(), [], T0);
    expect(requests).toHaveLength(0);
    expect(outcome.subrequests).toBe(0);
  });

  it("parses a recorded real GitHub response", async () => {
    stubGraphql([batch]);
    const outcome = await fetchSnapshots(provider(), ["paranext/paranext-core/2695"], T0);
    const snapshot = outcome.snapshots.get("paranext/paranext-core/2695");
    expect(snapshot).toBeDefined();
    expect(typeof snapshot!.title).toBe("string");
    expect(Array.isArray(snapshot!.reviews)).toBe(true);
  });

  it("fails the group on a recorded real rate-limit response", async () => {
    // The hand-written RATE_LIMITED tests above assert against a shape this
    // file asserts is real: HTTP 200, `data: null`, no `path` on the error.
    stubGraphql([rateLimited]);
    const outcome = await fetchSnapshots(provider(), ["paranext/paranext-core/2695"], T0);
    expect(outcome.failedGroups).toEqual(["app"]);
    expect(outcome.notFound).toEqual([]);
    expect(outcome.snapshots.size).toBe(0);
  });
});
