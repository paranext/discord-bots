import { afterEach, describe, expect, it, vi } from "vitest";
import { config as baseConfig } from "../../config/config.js";
import { DiscordRest, type DiscordMessage } from "../../src/discord/rest.js";
import { scanChannels } from "../../src/discord/scan.js";

const T0 = 1_788_192_000_000; // 2026-08-31T16:00:00Z = 11:00 America/Chicago
const CHANNEL = baseConfig.digestChannelId;
const config = { ...baseConfig, allowedChannelIds: [CHANNEL], digestChannelId: CHANNEL };

function message(id: string, content: string, opts: { authorId?: string; bot?: boolean; ageMs?: number } = {}): DiscordMessage {
  return {
    id,
    content,
    timestamp: new Date(T0 - (opts.ageMs ?? 3_600_000)).toISOString(),
    author: { id: opts.authorId ?? "human-1", bot: opts.bot ?? false, username: "jolie" },
  };
}

function stubPages(pages: DiscordMessage[][]) {
  const urls: string[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (input: string) => {
    urls.push(String(input));
    const page = pages[index] ?? [];
    index += 1;
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return urls;
}

/**
 * Keys each response off the `before`/`after` query parameter rather than call
 * order, so a test can actually assert which direction the scan paged in — a
 * call-order stub would accept either direction silently.
 */
function stubPagesByQuery(byParam: Record<string, DiscordMessage[]>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string) => {
    urls.push(String(input));
    const url = new URL(String(input));
    const key = url.searchParams.has("before")
      ? `before=${url.searchParams.get("before")}`
      : url.searchParams.has("after")
        ? `after=${url.searchParams.get("after")}`
        : "initial";
    return new Response(JSON.stringify(byParam[key] ?? []), { status: 200 });
  });
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

const PR = "https://github.com/paranext/paranext-core/pull/2695";
const OTHER = "https://github.com/paranext/paratext-10-studio/pull/177";

describe("scanChannels", () => {
  it("emits an upsertScanned command per allowlisted link", async () => {
    stubPages([[message("10", `please review ${PR}`)]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.commands[0]).toMatchObject({ kind: "upsertScanned" });
  });

  it("seeds messageTimestamp from the MESSAGE, not the scan time", async () => {
    const sixDaysAgo = 6 * 86_400_000;
    stubPages([[message("10", PR, { ageMs: sixDaysAgo })]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    const command = outcome.commands[0];
    if (command?.kind !== "upsertScanned") throw new Error("unreachable");
    expect(command.input.messageTimestamp).toBe(T0 - sixDaysAgo);
    expect(command.input.messageTimestamp).not.toBe(T0);
  });

  it("skips repos not on the allowlist", async () => {
    stubPages([[message("10", "https://github.com/paranext/some-experiment/pull/1")]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(0);
  });

  it("skips the bot's own messages to avoid double-counting its request posts", async () => {
    stubPages([[message("10", PR, { authorId: "bot-1", bot: true })]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(0);
  });

  it("finds two links in one message", async () => {
    stubPages([[message("10", `these two need eyes: ${PR} ${OTHER}`)]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(2);
  });

  it("pages until a short page arrives", async () => {
    // GET with no cursor returns the NEWEST 100 messages, so a first run pages OLDER
    // with before=<oldest id so far> — paging forward with after=<newest id> would
    // ask for messages newer than the newest, of which there are none.
    const newest = Array.from({ length: 100 }, (_, i) => message(String(300 + i), "no links"));
    const older = [message("299", PR)];
    const urls = stubPagesByQuery({
      initial: newest,
      "before=300": older,
    });
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(2);
    expect(outcome.commands).toHaveLength(1);
    expect(urls[1]).toContain("before=300");
  });

  it("stops at the page cap and advances the cursor to the newest fully processed message", async () => {
    // Ten 100-message groups, oldest-to-newest by index. A first run walks
    // backwards starting from the newest group (index 9).
    const groups = Array.from({ length: 10 }, (_, g) =>
      Array.from({ length: 100 }, (_, i) => message(String(g * 100 + i + 1), "no links")),
    );
    stubPagesByQuery({
      initial: groups[9]!,
      "before=901": groups[8]!,
      "before=801": groups[7]!,
    });
    const capped = { ...config, budgets: { ...config.budgets, scanPagesPerTick: 3 } };
    const outcome = await scanChannels(new DiscordRest("tok"), capped, {}, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(3);
    expect(outcome.hitPageCap).toBe(true);
    // "1000" is the NEWEST id seen (from the first, most-recent group), not the
    // oldest — the cursor lets the NEXT tick page forward with after=<cursor>.
    expect(outcome.cursors[CHANNEL]).toBe("1000");
    // And the unwalked remainder of the lookback window is recorded, so it is
    // resumed rather than abandoned. "701" is the oldest id of the last page
    // actually processed (group index 7).
    expect(outcome.backfill[CHANNEL]).toBe("701");
  });

  it("resumes a page-capped first-run backfill on the next tick, covering the whole window between them", async () => {
    // Three full pages, oldest-to-newest, with the PR link in the OLDEST — two
    // pages beyond a two-page budget. Before the resume cursor existed, tick one
    // set the forward cursor to the newest id and every later tick paged FORWARD
    // from there, so this link was never read by any tick, ever.
    const oldest = [message("1", PR), ...Array.from({ length: 99 }, (_, i) => message(String(2 + i), "no links"))];
    const middle = Array.from({ length: 100 }, (_, i) => message(String(101 + i), "no links"));
    const newest = Array.from({ length: 100 }, (_, i) => message(String(201 + i), "no links"));
    const capped = { ...config, budgets: { ...config.budgets, scanPagesPerTick: 2 } };

    const firstUrls = stubPagesByQuery({ initial: newest, "before=201": middle, "before=101": oldest });
    const first = await scanChannels(new DiscordRest("tok"), capped, {}, {}, "bot-1", T0);

    expect(first.pagesRead).toBe(2);
    expect(first.hitPageCap).toBe(true);
    expect(first.commands).toHaveLength(0);
    expect(first.cursors[CHANNEL]).toBe("300");
    expect(first.backfill[CHANNEL]).toBe("101");
    // The third page was NOT fetched on this tick — the cap really stopped it.
    expect(firstUrls.some((u) => u.includes("before=101"))).toBe(false);

    vi.unstubAllGlobals();
    const secondUrls = stubPagesByQuery({ initial: newest, "before=201": middle, "before=101": oldest, "before=1": [] });
    const second = await scanChannels(
      new DiscordRest("tok"),
      capped,
      { [CHANNEL]: first.cursors[CHANNEL]! },
      { [CHANNEL]: first.backfill[CHANNEL]! },
      "bot-1",
      T0,
    );

    // It picks up exactly where it stopped, walking BACKWARDS — not forwards
    // from the cursor.
    expect(secondUrls[0]).toContain("before=101");
    expect(second.commands).toHaveLength(1);
    expect(second.commands[0]).toMatchObject({ kind: "upsertScanned" });
    // The window is fully walked, so the resume point is cleared and later ticks
    // go back to paging forward from the cursor the first tick set.
    expect(second.backfill[CHANNEL]).toBeNull();
    // A resumed walk starts partway back, so its newest id says nothing about
    // the channel's head: the forward cursor must be left alone.
    expect(second.cursors[CHANNEL]).toBeUndefined();
  });

  it("takes the forward branch once the backfill is clear", async () => {
    // The complement of the test above: with a cursor and no resume point, the
    // walk must page FORWARD, or new messages would never be ingested.
    const urls = stubPagesByQuery({ "after=300": [message("301", PR)] });
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "300" }, {}, "bot-1", T0);
    expect(urls[0]).toContain("after=300");
    expect(outcome.commands).toHaveLength(1);
    expect(outcome.cursors[CHANNEL]).toBe("301");
  });

  it("hits the page cap on a forward walk too, advancing the cursor to the newest fully processed page", async () => {
    // The backward-walk cap test above only exercises the FIRST-run branch
    // (no stored cursor). Once a cursor exists, scanning pages FORWARD with
    // after=<cursor> instead, and that loop has its own, separate page-cap
    // check. A prior ruling confirmed the correct behaviour here is to
    // advance the cursor to the newest id of the last FULLY processed page —
    // not to the id of the last message merely seen — so a next tick that
    // resumes from this cursor never re-reads a page it already committed.
    const page1 = Array.from({ length: 100 }, (_, i) => message(String(501 + i), "no links"));
    const page2 = Array.from({ length: 100 }, (_, i) => message(String(601 + i), "no links"));
    // A third page exists on the server but must never be requested: hitting
    // the cap after page 2 must stop the walk right there.
    const page3 = [message("701", PR)];
    const urls = stubPagesByQuery({
      "after=500": page1,
      "after=600": page2,
      "after=700": page3,
    });
    const capped = { ...config, budgets: { ...config.budgets, scanPagesPerTick: 2 } };
    const outcome = await scanChannels(new DiscordRest("tok"), capped, { [CHANNEL]: "500" }, {}, "bot-1", T0);

    expect(outcome.pagesRead).toBe(2);
    expect(outcome.hitPageCap).toBe(true);
    // The newest id from the second (last fully processed) page, not "700"
    // reinterpreted some other way, and definitely not "701" from the
    // page never fetched.
    expect(outcome.cursors[CHANNEL]).toBe("700");
    expect(urls.some((u) => u.includes("after=700"))).toBe(false);
  });

  it("returns no cursor change when a channel has no new messages", async () => {
    stubPages([[]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, {}, "bot-1", T0);
    expect(outcome.cursors).toEqual({});
  });

  it("limits the first run to the lookback window rather than the whole history", async () => {
    const inside = message("10", PR, { ageMs: 3 * 86_400_000 });
    const outside = message("9", OTHER, { ageMs: 30 * 86_400_000 });
    stubPages([[outside, inside]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
    const command = outcome.commands[0];
    if (command?.kind !== "upsertScanned") throw new Error("unreachable");
    expect(command.input.pr.number).toBe(2695);
  });

  it("does not apply the lookback once a cursor exists", async () => {
    const old = message("600", PR, { ageMs: 30 * 86_400_000 });
    stubPages([[old]]);
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, {}, "bot-1", T0);
    expect(outcome.commands).toHaveLength(1);
  });

  it("leaves the cursor untouched for a channel whose fetch failed", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, {}, "bot-1", T0);
    expect(outcome.cursors).toEqual({});
    expect(outcome.commands).toHaveLength(0);
  });

  // `pagesRead` is billed as subrequests in the tick report and spent from the
  // page budget, and a failed page is a request that WAS issued. Counting only
  // successes let every channel returning 5xx spend a request the budget never
  // saw and the report never showed — in shadow mode, where the report is the
  // only view an operator has.
  it("counts a failed page in pagesRead, paging forward", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const outcome = await scanChannels(new DiscordRest("tok"), config, { [CHANNEL]: "500" }, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(1);
  });

  it("counts a failed page in pagesRead on a first run, paging backward", async () => {
    // The other walk: no cursor, so this is the backward first-run path.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(1);
  });
});

describe("scanChannels — sharing the page budget across channels", () => {
  const OTHER_CHANNEL = "channel-2";
  const two = { ...config, allowedChannelIds: [CHANNEL, OTHER_CHANNEL] };

  /** Routes by the channel id in the path, so a busy channel and a quiet one can
   *  be stubbed independently — a call-order stub could not tell which channel a
   *  page was served to, which is the whole question here. */
  function stubByChannel(pages: Record<string, DiscordMessage[]>) {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      urls.push(url);
      const channel = url.includes(`/channels/${OTHER_CHANNEL}/`) ? OTHER_CHANNEL : CHANNEL;
      return new Response(JSON.stringify(pages[channel] ?? []), { status: 200 });
    });
    return urls;
  }

  it("reserves a page for a later channel that a busy first channel would otherwise starve", async () => {
    // The defect: the budget was spent front-to-back, so a channel mid-backfill
    // consumed all 5 pages every tick and channel-2 was never even STARTED — no
    // forward cursor, so nothing posted there was ingested at all, for as long
    // as the busy channel's 7-day lookback took.
    //
    // channel-1 returns full pages forever (so it always wants another); the
    // other channel has one short page holding a PR link.
    const busy = Array.from({ length: 100 }, (_, i) => message(String(1000 + i), "no links"));
    const urls = stubByChannel({ [CHANNEL]: busy, [OTHER_CHANNEL]: [message("50", PR)] });

    const outcome = await scanChannels(new DiscordRest("tok"), two, {}, {}, "bot-1", T0);

    expect(urls.some((u) => u.includes(`/channels/${OTHER_CHANNEL}/`))).toBe(true);
    expect(outcome.cursors[OTHER_CHANNEL]).toBe("50");
    expect(outcome.commands).toHaveLength(1);
    // The busy channel still gets everything left over — the reserve is one page
    // per channel still to come, not an even split.
    expect(outcome.pagesRead).toBe(two.budgets.scanPagesPerTick);
  });

  it("rotates which channel goes first, so no channel is permanently last", async () => {
    // With a one-page budget the reserve cannot help: someone must go without.
    // Rotation is what stops it being the same channel every tick.
    const capped = { ...two, budgets: { ...two.budgets, scanPagesPerTick: 1 } };
    const full = Array.from({ length: 100 }, (_, i) => message(String(1000 + i), "no links"));

    const firstUrls = stubByChannel({ [CHANNEL]: full, [OTHER_CHANNEL]: full });
    await scanChannels(new DiscordRest("tok"), capped, {}, {}, "bot-1", T0);

    vi.unstubAllGlobals();
    const nextUrls = stubByChannel({ [CHANNEL]: full, [OTHER_CHANNEL]: full });
    await scanChannels(new DiscordRest("tok"), capped, {}, {}, "bot-1", T0 + capped.refreshIntervalMs);

    const firstChannelOf = (urls: string[]): string =>
      urls[0]!.includes(`/channels/${OTHER_CHANNEL}/`) ? OTHER_CHANNEL : CHANNEL;
    expect(firstChannelOf(firstUrls)).not.toBe(firstChannelOf(nextUrls));
  });

  it("still gives a single configured channel the entire budget", async () => {
    // The guard on both fixes above: with one channel there is nothing to
    // reserve for and nothing to rotate, and the shipped config has one channel.
    const full = Array.from({ length: 100 }, (_, i) => message(String(1000 + i), "no links"));
    stubByChannel({ [CHANNEL]: full });
    const outcome = await scanChannels(new DiscordRest("tok"), config, {}, {}, "bot-1", T0);
    expect(outcome.pagesRead).toBe(config.budgets.scanPagesPerTick);
  });
});
