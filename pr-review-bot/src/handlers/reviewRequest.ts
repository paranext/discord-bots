import type { Config } from "../../config/config.js";
import type { PrRecord, RequestFields } from "../core/record.js";
import { renderRejection, RETRY_PREFIX } from "../core/render/rejection.js";
import { renderRequestMessage } from "../core/render/request.js";
import { NOTE_MAX_LENGTH, parseSubmission, type SubmitRejection, type SubmittedValues } from "../core/submit.js";
import { prSlug, type ParsedPr } from "../core/urls.js";
import {
  CallbackType,
  EPHEMERAL_FLAG,
  ephemeral,
  SUPPRESS_EMBEDS_FLAG,
  type InteractionResponse,
} from "../discord/components.js";
import type { DiscordRest } from "../discord/rest.js";
import type { CredentialProvider } from "../github/credentials.js";
import { fetchSnapshots } from "../github/query.js";
import type { Store } from "../store/types.js";
import { buildRequestModal } from "./modal.js";

export interface RequestDeps {
  store: Store;
  config: Config;
  rest: DiscordRest;
  credentials: CredentialProvider;
  appId: string;
  now: () => number;
  waitUntil: (work: Promise<unknown>) => void;
}

interface SubmitInteraction {
  id?: string;
  token?: string;
  channel_id?: string;
  member?: { user: { id: string; global_name?: string | null; username: string } };
  user?: { id: string; global_name?: string | null; username: string };
  data?: { components?: unknown };
}

function actorOf(i: SubmitInteraction): { id: string; name: string } | null {
  const user = i.member?.user ?? i.user;
  return user === undefined ? null : { id: user.id, name: user.global_name ?? user.username };
}

/**
 * Flags for the deferred reply and every edit of it. SUPPRESS_EMBEDS because the
 * confirmation names a PR and a rejection echoes the requester's own pasted link
 * back verbatim, so both unfurl without it.
 */
const REPLY_FLAGS = EPHEMERAL_FLAG | SUPPRESS_EMBEDS_FLAG;

/**
 * The one place this handler PATCHes the deferred reply.
 *
 * A missing token is not attempted: without it the PATCH is malformed by
 * construction, guaranteed to 404, and — before this — that 404 was thrown
 * away along with every other unchecked `RestResult` on this path, leaving no
 * diagnostic signature for "the spinner never resolved". Both a missing token
 * and a non-ok result are logged, naming which edit failed and why.
 */
async function editReply(
  deps: RequestDeps,
  interaction: SubmitInteraction,
  what: string,
  payload: { content: string; components?: unknown[] },
): Promise<void> {
  if (interaction.token === undefined) {
    console.error(`reviewRequest: no interaction token, could not ${what}`);
    return;
  }
  // The deferral already set these flags; they are repeated here because
  // Discord's edit docs say to send every previously set bit whenever `flags` is
  // present, and so the suppression does not hinge on the deferred flags
  // carrying over to the edit. See `REPLY_FLAGS`.
  const result = await deps.rest.editInteractionResponse(deps.appId, interaction.token, {
    ...payload,
    flags: REPLY_FLAGS,
  });
  if (!result.ok) {
    console.error(`reviewRequest: ${what} failed`, result.status);
  }
}

/** Built from the cache and nothing else — see `buildRequestModal`. */
export async function openRequestModal(deps: RequestDeps, prefill?: SubmittedValues): Promise<InteractionResponse> {
  const state = await deps.store.readState();
  return buildRequestModal(deps.config, state.meta.prdCache, prefill);
}

export async function handleRetryButton(
  interaction: SubmitInteraction,
  customId: string,
  deps: RequestDeps,
): Promise<InteractionResponse> {
  const who = actorOf(interaction);
  if (who === null) return ephemeral("Could not identify who pressed that.");

  const key = customId.slice(RETRY_PREFIX.length);
  const state = await deps.store.readState();
  const stashed = state.meta.retryStash[key];

  // Defensive, not user-facing: the rejection is ephemeral, so in practice only
  // the submitter can see the button. A stash key is not a capability, and this
  // check is what makes that true.
  if (stashed !== undefined && stashed.userId !== who.id) {
    return ephemeral("That is not your form. Run `/review-request` to start your own.");
  }

  if (stashed === undefined || stashed.expiresAt <= deps.now()) {
    return ephemeral(
      "That form has expired. Run `/review-request` again — the values are still in the message above, ready to copy.",
    );
  }

  return openRequestModal(deps, stashed.values);
}

/**
 * Answers Discord inside its 3-second budget and finishes afterwards.
 *
 * The deferral is returned SYNCHRONOUSLY and the work is scheduled through
 * `waitUntil`. Doing the work first and deferring after would miss the budget on
 * every submission that touches GitHub — which is all of them.
 */
export function handleModalSubmit(interaction: SubmitInteraction, deps: RequestDeps): InteractionResponse {
  deps.waitUntil(finishSubmit(interaction, deps));
  return { type: CallbackType.DeferredChannelMessageWithSource, data: { flags: REPLY_FLAGS } };
}

async function reject(
  interaction: SubmitInteraction,
  rejection: SubmitRejection,
  values: SubmittedValues,
  deps: RequestDeps,
): Promise<void> {
  const now = deps.now();
  const userId = actorOf(interaction)?.id ?? null;
  const key = interaction.id ?? null;

  // The button is offered only where the stash was actually WRITTEN, which is
  // why the key it renders with is assigned inside the same guard rather than
  // tested twice. `submit()` rejects an offline-invalid submission BEFORE it
  // throws on a missing actor, so an interaction carrying neither `member` nor
  // `user` reaches here: it used to render a live-looking "Fix and retry" backed
  // by nothing, whose only outcome was "that form has expired" for a form that
  // never existed.
  let stashKey: string | null = null;

  if (key !== null && userId !== null) {
    // Guarded because the stash is a CONVENIENCE and the rejection is the
    // answer. A throw here used to escape `reject` into `finishSubmit`'s catch,
    // which replaced a precise, offline-decided "that repo is not on the
    // allowlist" with "the PR may already be tracked" — false, since nothing was
    // recorded, and it hides the one thing the user needs to know. Falling
    // through with `stashKey = null` costs them the prefill, not the answer.
    try {
      await deps.store.apply(
        [{
          kind: "stashSubmission",
          key,
          entry: { userId, values, expiresAt: now + deps.config.retryStashMs },
          now,
        }],
        { now, rerender: false },
      );
      stashKey = key;
    } catch (error) {
      console.warn(`[REQUEST] could not stash ${key} for retry: ${String(error)}`);
    }
  }

  const rendered = renderRejection({ rejection, values, stashKey, config: deps.config });
  await editReply(deps, interaction, "report a rejection", {
    content: rendered.content,
    components: rendered.components,
  });
}

/**
 * Best-effort "it broke" edit, and the last thing that can inform the user.
 *
 * The message has to be TRUE about an unknown state: the record is written
 * before the channel post, so a failure past that point means the PR probably
 * IS tracked. Telling the user nothing happened would send them to re-request
 * something already on the list.
 */
async function reportFailure(interaction: SubmitInteraction, deps: RequestDeps): Promise<void> {
  try {
    await editReply(deps, interaction, "report a failure", {
      content:
        "Something went wrong while recording that request, and I cannot tell you how far it got. " +
        "The PR may already be tracked — check `/review-list` before requesting it again.",
    });
  } catch (error) {
    // This edit uses the same unguarded `fetch` as everything else, so it can
    // reject too. There is nowhere left to report to, so log and stop rather
    // than letting a second rejection escape into `waitUntil`.
    console.error("finishSubmit could not report its own failure", error);
  }
}

/**
 * The submit path, with the only safety net it gets.
 *
 * `fetchSnapshots` (`src/github/query.ts`) and both REST paths
 * (`src/discord/rest.ts`) issue bare `fetch`es and call `response.json()`
 * unguarded, so a DNS failure, a subrequest-limit abort, or a 200 carrying
 * non-JSON REJECTS rather than returning `{ ok: false }`. This runs under
 * `waitUntil`, which swallows a rejection whole: no log, and the deferral is
 * never edited, so the spinner spins forever and the user cannot tell whether
 * the PR was recorded — it may well have been.
 */
export async function finishSubmit(interaction: SubmitInteraction, deps: RequestDeps): Promise<void> {
  try {
    await submit(interaction, deps);
  } catch (error) {
    console.error("finishSubmit failed", error);
    await reportFailure(interaction, deps);
  }
}

/**
 * The submit path proper, run in the background after the deferral.
 *
 * Order matters and is load-bearing: offline validation first (no network at
 * all on a bad link), then GitHub, then the record, then the channel post. The
 * record is written BEFORE the post because the stored record is what
 * `renderRequestMessage` renders and the record is where the posted message's id
 * has to go — a cycle that the `setRequestMessageId` command breaks. If the post
 * fails the record survives and the digest still shows it.
 */
async function submit(interaction: SubmitInteraction, deps: RequestDeps): Promise<void> {
  const now = deps.now();
  const who = actorOf(interaction);
  const parse = parseSubmission(interaction.data?.components, deps.config);

  if (!parse.ok) {
    await reject(interaction, parse.rejection, parse.values, deps);
    return;
  }
  if (who === null) {
    // Discord sends `member` in a guild and `user` in a DM, so this is
    // unreachable in practice — but a silent `return` would leave the deferral
    // hanging exactly as a thrown `fetch` does. Throwing routes it into
    // `finishSubmit`'s safety net, which at least says something true.
    throw new Error("modal submission carried neither member nor user");
  }

  const pr: ParsedPr = parse.pr;
  const slug = prSlug(pr);
  const outcome = await fetchSnapshots(deps.credentials, [slug], now);
  const snapshot = outcome.snapshots.get(slug);

  if (snapshot === undefined) {
    // A credential that failed wholesale is a different problem with a different
    // fix, and it is the ONE case GitHub's NOT_FOUND does not swallow.
    const reason: SubmitRejection =
      outcome.failedGroups.length > 0 ? { reason: "credential", slug } : { reason: "not-found", slug };
    await reject(interaction, reason, parse.values, deps);
    return;
  }
  if (snapshot.merged) {
    await reject(interaction, { reason: "merged" }, parse.values, deps);
    return;
  }
  if (snapshot.state === "CLOSED") {
    await reject(interaction, { reason: "closed" }, parse.values, deps);
    return;
  }

  // The modal's own `max_length` bounds a well-behaved client, but the modal is
  // client-side and this is the trust boundary: a stale interaction re-opened
  // across a config or code deploy could still carry a longer note. Clamped
  // here, before it ever reaches the record, so neither the retry stash's
  // 128 KiB Durable Object value nor the digest's per-row render budget can be
  // blown by one long entry.
  const trimmedNote = parse.values.note.trim();
  const fields: RequestFields = {
    team: parse.values.team as RequestFields["team"],
    urgency: parse.values.urgency as RequestFields["urgency"],
    prdThreadId: parse.values.prdThreadId,
    note: trimmedNote === "" ? null : trimmedNote.slice(0, NOTE_MAX_LENGTH),
    requesterId: who.id,
    requesterName: who.name,
    channelId: interaction.channel_id ?? deps.config.digestChannelId,
    messageId: null,
  };

  const applied = await deps.store.apply(
    [{
      kind: "upsertRequest",
      pr,
      at: now,
      fields,
      title: snapshot.title,
      prAuthorLogin: snapshot.authorLogin,
      isDraft: snapshot.isDraft,
    }],
    { now, rerender: deps.config.immediateDigestRewrite },
  );

  const created = applied.results[0]?.kind === "created";
  const state = await deps.store.readState();
  const record: PrRecord | undefined = state.records[slug];

  let postedNote = "";
  if (record !== undefined) {
    const post = await deps.rest.postContent(fields.channelId, renderRequestMessage(record, deps.config));
    if (post.ok) {
      await deps.store.apply([{ kind: "setRequestMessageId", id: slug, messageId: post.value.id }], {
        now,
        rerender: false,
      });
    } else {
      // The record is already stored, so the row is on the list either way. Say
      // what failed rather than implying nothing happened.
      postedNote = ` I could not post the request message in the channel (Discord said ${post.status}), so nobody was pinged — but the PR is tracked.`;
    }
  }

  await editReply(deps, interaction, "confirm the request", {
    content:
      (created
        ? `**${record?.title ?? slug}** is on the list.`
        : `Updated your existing request for **${record?.title ?? slug}** — it is back at the top of its team's section.`) +
      postedNote,
  });
}
