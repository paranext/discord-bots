import type { Config } from "../../config/config.js";
import { extractPrUrls, isAllowlisted } from "../core/urls.js";
import type { Command } from "../store/types.js";
import type { DiscordMessage, DiscordRest } from "./rest.js";

export interface ScanOutcome {
  commands: Command[];
  /** Only channels whose pages were fully processed appear here. */
  cursors: Record<string, string>;
  /** Where an unfinished BACKWARD walk should resume from next tick, per
   *  channel. A string sets the resume point; `null` clears it, meaning the
   *  lookback window has been walked all the way back. Channels absent from
   *  this map are left exactly as they were. */
  backfill: Record<string, string | null>;
  pagesRead: number;
  hitPageCap: boolean;
}

const PAGE_SIZE = 100;

function toCommands(
  messages: DiscordMessage[],
  channelId: string,
  botUserId: string,
  config: Config,
  now: number,
): Command[] {
  const commands: Command[] = [];
  for (const message of messages) {
    // The bot's own request messages would double-count their own PRs.
    if (message.author.id === botUserId) continue;

    for (const pr of extractPrUrls(message.content)) {
      if (!isAllowlisted(pr, config.repoAllowlist)) continue;
      commands.push({
        kind: "upsertScanned",
        now,
        input: {
          pr,
          channelId,
          messageId: message.id,
          // The MESSAGE's timestamp, not the scan time. This is what lets a
          // scanned record ever satisfy the exit condition: a record whose
          // review already happened is born resolved.
          messageTimestamp: Date.parse(message.timestamp),
          title: `${pr.repo}#${pr.number}`,
          prAuthorLogin: null,
          isDraft: false,
        },
      });
    }
  }
  return commands;
}

interface OneChannelOutcome {
  commands: Command[];
  cursor: string | null;
  /** `undefined` leaves the stored resume point untouched; `null` clears it. */
  backfill: string | null | undefined;
  pagesRead: number;
  hitCap: boolean;
}

async function scanOne(
  rest: DiscordRest,
  config: Config,
  channelId: string,
  cursor: string | undefined,
  backfill: string | undefined,
  botUserId: string,
  now: number,
  pageBudget: number,
): Promise<OneChannelOutcome> {
  const lookbackFrom = now - config.scanLookbackMs;

  const firstRun = cursor === undefined;
  if (firstRun || backfill !== undefined) {
    // No stored cursor (a first run), or a backward walk that a previous tick's
    // page cap left unfinished. `GET /channels/{id}/messages` with no query
    // returns the NEWEST 100 messages. Paging FORWARD from there with
    // after=<newest id> would ask for messages newer than the newest — there are
    // none — so the only way to reach the configured lookback window is to walk
    // BACKWARDS with before=<oldest id seen so far>, stopping once a message
    // predates `now - scanLookbackMs` or the page cap is hit.
    //
    // When the cap stops the walk, the resume point is carried in `backfill` and
    // the next tick continues from there. Advancing only the forward cursor and
    // dropping the rest — as this did — meant every later tick paged FORWARD
    // from the newest id, so the older remainder of the lookback window was
    // never read by any tick, ever: a permanent gap, invisible in the tick log,
    // in exactly the backfill shadow mode exists to check.
    const commands: Command[] = [];
    let before: string | undefined = backfill;
    let newestOfFirstPage: string | null = null;
    let pagesRead = 0;
    let hitCap = false;
    let reachedWindowEdge = false;

    while (pagesRead < pageBudget) {
      // Counted BEFORE the outcome is known: `pagesRead` is what the tick report
      // bills as subrequests and what the page budget is spent from, and a failed
      // request was still issued. Counting only successes let a channel returning
      // 5xx spend a request per tick that no budget saw and no report showed.
      pagesRead += 1;
      const page = await rest.getMessages(channelId, before === undefined ? {} : { before });
      if (!page.ok) {
        // Leave both cursors alone: a tick that dies mid-run re-scans rather than
        // skipping, and re-scanning is safe because identity is owner/repo/number.
        return { commands: [], cursor: null, backfill: undefined, pagesRead, hitCap: false };
      }

      const messages: DiscordMessage[] = page.value;
      if (messages.length === 0) {
        reachedWindowEdge = true;
        break;
      }

      // Ascending by id.
      const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (newestOfFirstPage === null) newestOfFirstPage = ordered.at(-1)!.id;

      const inWindow = ordered.filter((m) => Date.parse(m.timestamp) >= lookbackFrom);
      commands.push(...toCommands(inWindow, channelId, botUserId, config, now));

      const hitLookbackEdge = inWindow.length < ordered.length;
      before = ordered[0]!.id;

      if (hitLookbackEdge || messages.length < PAGE_SIZE) {
        reachedWindowEdge = true;
        break;
      }
      if (pagesRead >= pageBudget) {
        hitCap = true;
        break;
      }
    }

    // On a first run the cursor advances to the newest message seen — the FIRST
    // page fetched, since a first-run backward walk starts at "now" — so later
    // ticks can page FORWARD with after=<cursor>. A RESUMED walk starts partway
    // back, so its newest id says nothing about the channel's head: leave the
    // forward cursor exactly where the first run put it.
    return {
      commands,
      cursor: firstRun ? newestOfFirstPage : null,
      backfill: reachedWindowEdge ? null : before ?? null,
      pagesRead,
      hitCap,
    };
  }

  // A cursor exists: page FORWARD with after=<cursor>, which is what the
  // endpoint actually supports for "give me what's new since I last looked".
  const commands: Command[] = [];
  let after: string | undefined = cursor;
  let newestProcessed: string | null = null;
  let pagesRead = 0;
  let hitCap = false;

  while (pagesRead < pageBudget) {
    // Counted before the outcome is known, for the same reason as the backward
    // walk above.
    pagesRead += 1;
    const page = await rest.getMessages(channelId, { after });
    if (!page.ok) {
      return { commands: [], cursor: null, backfill: undefined, pagesRead, hitCap: false };
    }

    const messages: DiscordMessage[] = page.value;
    if (messages.length === 0) break;

    const ordered = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    newestProcessed = ordered.at(-1)!.id;
    after = newestProcessed;
    commands.push(...toCommands(ordered, channelId, botUserId, config, now));

    if (messages.length < PAGE_SIZE) break;
    if (pagesRead >= pageBudget) {
      hitCap = true;
      break;
    }
  }

  return { commands, cursor: newestProcessed, backfill: undefined, pagesRead, hitCap };
}

export async function scanChannels(
  rest: DiscordRest,
  config: Config,
  cursors: Record<string, string>,
  backfill: Record<string, string>,
  botUserId: string,
  now: number,
): Promise<ScanOutcome> {
  const commands: Command[] = [];
  const nextCursors: Record<string, string> = {};
  const nextBackfill: Record<string, string | null> = {};
  let pagesRead = 0;
  let hitPageCap = false;

  // Two guards against one channel eating the whole budget, which is not a
  // hypothetical: during the first-run backfill a busy channel wants every page
  // it can get, for as many ticks as its 7-day lookback takes. Spent
  // front-to-back, that left every later channel not merely behind but never
  // STARTED — no forward cursor established, so nothing posted there was
  // ingested at all in the meantime.
  //
  // 1. Rotate the starting channel per tick, so no channel is permanently last.
  //    Derived from the tick bucket rather than a stored counter: this is an
  //    adapter, the ordering only has to vary, and a counter would be one more
  //    thing to persist and fence.
  const channels = config.allowedChannelIds;
  const start = channels.length === 0 ? 0 : Math.floor(now / config.refreshIntervalMs) % channels.length;
  const ordered = [...channels.slice(start), ...channels.slice(0, start)];

  for (let index = 0; index < ordered.length; index += 1) {
    const channelId = ordered[index]!;
    const budgetLeft = config.budgets.scanPagesPerTick - pagesRead;
    if (budgetLeft <= 0) {
      hitPageCap = true;
      break;
    }
    // 2. Hold back one page for each channel still to come, so every channel in
    //    the rotation gets at least one — enough to establish its cursor and
    //    take the newest page — before any channel gets a second. A single
    //    configured channel still gets the whole budget.
    const stillToCome = ordered.length - index - 1;
    const allowance = Math.max(1, budgetLeft - stillToCome);
    const outcome = await scanOne(rest, config, channelId, cursors[channelId], backfill[channelId], botUserId, now, allowance);
    commands.push(...outcome.commands);
    pagesRead += outcome.pagesRead;
    if (outcome.hitCap) hitPageCap = true;
    if (outcome.cursor !== null) nextCursors[channelId] = outcome.cursor;
    if (outcome.backfill !== undefined) nextBackfill[channelId] = outcome.backfill;
  }

  return { commands, cursors: nextCursors, backfill: nextBackfill, pagesRead, hitPageCap };
}
