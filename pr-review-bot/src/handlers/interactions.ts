import type { Config } from "../../config/config.js";
import { decodeOptionValue } from "../core/ranking.js";
import { isOpen } from "../core/record.js";
import { RETRY_PREFIX } from "../core/render/rejection.js";
import { MODAL_ID } from "../core/submit.js";
import { CUSTOM_IDS, ephemeral, InteractionType, pong } from "../discord/components.js";
import type { DiscordRest } from "../discord/rest.js";
import { verifyDiscordRequest } from "../discord/verify.js";
import type { CredentialProvider } from "../github/credentials.js";
import type { Command, CommandResult, Store } from "../store/types.js";
import { renderReviewList } from "./reviewList.js";
import { handleModalSubmit, handleRetryButton, openRequestModal, type RequestDeps } from "./reviewRequest.js";

export interface InteractionDeps {
  store: Store;
  config: Config;
  publicKey: string;
  now: () => number;
  /** Injectable so tests need not sign real payloads; defaults to the real check. */
  verify?: (body: string, signature: string | null, timestamp: string | null, key: string) => Promise<boolean>;
  /** The worker's `ctx.waitUntil`. The submit path answers Discord inside three
   *  seconds and finishes afterwards; without this there is nowhere for the
   *  "afterwards" to run. Injectable so tests can await the background work
   *  instead of racing it. */
  waitUntil: (work: Promise<unknown>) => void;
  /** Present only once the command is enabled; the digest menus need none of
   *  these. See `requestDeps`. */
  rest?: DiscordRest;
  credentials?: CredentialProvider;
  appId?: string;
}

interface Interaction {
  type: number;
  /** The interaction's own id. Used as the retry stash key — it is unique per
   *  submission and already inside the 100-character `custom_id` budget. */
  id?: string;
  /** Valid for 15 minutes. The credential for editing the deferred reply. */
  token?: string;
  data?: { custom_id?: string; values?: string[]; name?: string; components?: unknown };
  member?: { user: { id: string; global_name?: string | null; username: string } };
  user?: { id: string; global_name?: string | null; username: string };
  channel_id?: string;
}

/**
 * `/review-request`'s channel gate.
 *
 * The v1 spec documents `config.allowedChannelIds` as where the command works,
 * but before this it was read only by the scanner (`src/discord/scan.ts`) —
 * the command itself, its modal submit, and its retry button answered from any
 * channel in the guild, and `reviewRequest.ts` takes `interaction.channel_id`
 * straight into the record's `channelId`. Matches `scan.ts`'s own semantics:
 * plain membership in the list, nothing more.
 */
function isAllowedChannel(config: Config, channelId: string | undefined): boolean {
  return channelId !== undefined && config.allowedChannelIds.includes(channelId);
}

function notAllowedChannel(config: Config) {
  if (config.allowedChannelIds.length === 0) {
    return ephemeral("`/review-request` is not available in any channel right now.");
  }
  const names = config.allowedChannelIds.map((id) => `<#${id}>`).join(", ");
  return ephemeral(`\`/review-request\` only works in ${names}.`);
}

function actor(interaction: Interaction): { id: string; name: string } | null {
  const user = interaction.member?.user ?? interaction.user;
  if (user === undefined) return null;
  return { id: user.id, name: user.global_name ?? user.username };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleInteraction(request: Request, deps: InteractionDeps): Promise<Response> {
  const raw = await request.text();
  const verify = deps.verify ?? verifyDiscordRequest;
  const verified = await verify(
    raw,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    deps.publicKey,
  );
  if (!verified) return new Response("invalid request signature", { status: 401 });

  let interaction: Interaction;
  try {
    interaction = JSON.parse(raw) as Interaction;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  if (interaction.type === InteractionType.Ping) return json(pong());

  if (interaction.type === InteractionType.MessageComponent) {
    return json(await handleComponent(interaction, deps));
  }

  if (interaction.type === InteractionType.ApplicationCommand) {
    if (interaction.data?.name === "review-list") {
      const state = await deps.store.readState();
      return json(renderReviewList(state, deps.config, deps.now()));
    }
    if (interaction.data?.name === "review-request") {
      if (!isAllowedChannel(deps.config, interaction.channel_id)) return json(notAllowedChannel(deps.config));
      const request = requestDeps(deps);
      if (request === null) return json(ephemeral("That command is not enabled yet."));
      return json(await openRequestModal(request));
    }
    return json(ephemeral("That command is not enabled yet."));
  }

  if (interaction.type === InteractionType.ModalSubmit) {
    // Gated on the modal's OWN id, not merely on the interaction type. A foreign
    // modal reaching `finishSubmit` would be parsed, rejected, and its values
    // STASHED — consuming a slot under `budgets.retryStashEntries` and evicting
    // a real user's pending retry.
    if (interaction.data?.custom_id !== MODAL_ID) return json(ephemeral("That form is no longer in use."));
    if (!isAllowedChannel(deps.config, interaction.channel_id)) return json(notAllowedChannel(deps.config));
    const request = requestDeps(deps);
    if (request === null) return json(ephemeral("That command is not enabled yet."));
    return json(handleModalSubmit(interaction, request));
  }

  return json(ephemeral("This interaction is not handled yet."));
}

async function handleComponent(interaction: Interaction, deps: InteractionDeps) {
  const who = actor(interaction);
  if (who === null) return ephemeral("Could not identify who selected that.");

  const customId = interaction.data?.custom_id ?? "";

  // Routing happens on custom_id FIRST. A button carries no `values`, so
  // decoding a selection before checking the id answered every button with
  // "Could not read that selection" and no button could ever reach a handler.
  if (customId.startsWith(RETRY_PREFIX)) return handleRetry(interaction, customId, deps);

  const rawValue = interaction.data?.values?.[0] ?? "";
  const reopen = rawValue.startsWith("reopen:");
  const decoded = decodeOptionValue(reopen ? rawValue.slice("reopen:".length) : rawValue);
  if (decoded === null) {
    return ephemeral("Could not read that selection. The list may have been rewritten — try again.");
  }

  const now = deps.now();
  const state = await deps.store.readState();
  const record = state.records[decoded.id];
  if (record === undefined) {
    return ephemeral(`That PR is no longer tracked — it may have been purged after 30 days.`);
  }

  if (customId === CUSTOM_IDS.claim) {
    // Selecting a row you already hold releases it.
    const command: Command =
      record.claimedBy === who.id
        ? { kind: "unclaim", id: decoded.id, userId: who.id }
        : {
            kind: "claim",
            id: decoded.id,
            userId: who.id,
            displayName: who.name,
            at: now,
            expectLastRequestedAt: decoded.lastRequestedAt,
          };

    const result = await deps.store.apply([command], {
      now,
      rerender: deps.config.immediateDigestRewrite,
    });
    return describe(result.results[0], record.title, command.kind === "unclaim" ? "unclaim" : "claim");
  }

  if (customId === CUSTOM_IDS.resolve) {
    if (reopen) {
      // Read from config, not a locally hand-written literal — the renderer decides
      // which rows are OFFERED as reopen options and this decides which are
      // ACCEPTED; the two numbers must be the same, and a config field with one
      // definition is what makes that true instead of merely hoped-for.
      if (record.resolvedAt === null || now - record.resolvedAt > deps.config.reopenWindowMs) {
        return ephemeral(`**${record.title}** cannot be reopened from here — resolve it again with the command.`);
      }
      const result = await deps.store.apply([{ kind: "reopen", id: decoded.id, at: now }], {
        now,
        rerender: deps.config.immediateDigestRewrite,
      });
      return describe(result.results[0], record.title, "reopen");
    }

    if (!isOpen(record)) {
      return ephemeral(
        `**${record.title}** was already cleared — ${record.resolvedBy ?? "resolved"}. Nothing changed.`,
      );
    }

    const result = await deps.store.apply(
      [{
        kind: "resolve",
        id: decoded.id,
        by: `cleared by ${who.name}`,
        at: now,
        expectLastRequestedAt: decoded.lastRequestedAt,
      }],
      { now, rerender: deps.config.immediateDigestRewrite },
    );
    return describe(result.results[0], record.title, "resolve");
  }

  return ephemeral("That control is no longer in use. Open the pinned list again.");
}

async function handleRetry(interaction: Interaction, customId: string, deps: InteractionDeps) {
  if (!isAllowedChannel(deps.config, interaction.channel_id)) return notAllowedChannel(deps.config);
  const request = requestDeps(deps);
  if (request === null) return ephemeral("That command is not enabled yet.");
  return handleRetryButton(interaction, customId, request);
}

/**
 * `rest`, `credentials` and `appId` are optional on `InteractionDeps` so the
 * digest's claim and resolve menus — which need none of them — keep working in
 * every test and every deployment that has not enabled the command yet. Anything
 * on the request path needs all three, and this is the one place that checks.
 */
function requestDeps(deps: InteractionDeps): RequestDeps | null {
  if (deps.rest === undefined || deps.credentials === undefined || deps.appId === undefined) {
    // A REGISTERED command answering "not enabled yet" is an outage with no
    // diagnostic signature otherwise — an unset DISCORD_APP_ID (or the other
    // two) leaves no trace anywhere else.
    const missing = [
      ...(deps.rest === undefined ? ["rest"] : []),
      ...(deps.credentials === undefined ? ["credentials"] : []),
      ...(deps.appId === undefined ? ["appId (DISCORD_APP_ID)"] : []),
    ].join(", ");
    console.error(`/review-request is registered but not enabled: missing ${missing}`);
    return null;
  }
  return { ...deps, rest: deps.rest, credentials: deps.credentials, appId: deps.appId };
}

function describe(result: CommandResult | undefined, title: string, action: "claim" | "unclaim" | "resolve" | "reopen") {
  if (result === undefined) return ephemeral("Nothing happened. Try again from the pinned list.");

  switch (result.kind) {
    case "ok":
      if (action === "claim") return ephemeral(`You are reviewing **${title}**. It has moved to *Being reviewed*.`);
      if (action === "unclaim") return ephemeral(`Released **${title}**. It is back in its team section.`);
      if (action === "reopen") return ephemeral(`**${title}** is back on the list.`);
      return ephemeral(`Cleared **${title}** from the list.`);
    case "already-claimed":
      return ephemeral(`**${result.byName}** is already reviewing **${title}**.`);
    case "stale":
      return ephemeral(
        `**${title}** changed since the list was drawn — it was re-requested. Nothing changed; open the pinned list again.`,
      );
    case "not-open":
      return ephemeral(`**${title}** is already off the list. Nothing changed.`);
    case "not-found":
      return ephemeral(`**${title}** is no longer tracked. Nothing changed.`);
    default:
      return ephemeral(`Nothing changed for **${title}**.`);
  }
}
