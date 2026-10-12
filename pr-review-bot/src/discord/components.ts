export const CUSTOM_IDS = {
  claim: "digest:claim",
  resolve: "digest:resolve",
} as const;

export const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ModalSubmit: 5,
} as const;

export const CallbackType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  /** Answers now, finishes later. The ONLY way the submit path fits Discord's
   *  3-second budget while doing GitHub and Discord I/O. */
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  /** Opens a modal. Not valid in response to a MODAL_SUBMIT or a PING, which is
   *  why a rejected submission gets a button rather than another modal. */
  Modal: 9,
} as const;

export const EPHEMERAL_FLAG = 1 << 6;

/**
 * Suppresses every embed on a message — the link unfurls Discord generates AND
 * any rich embed the message itself carries. That second half is the whole
 * reason this is a named constant with a comment rather than a `4` at each call
 * site: setting it on the digest would leave the pinned list blank while the
 * PATCH still succeeded and the body hash still advanced, so nothing downstream
 * would report a problem. Set it on plain-content messages only.
 *
 * Every message this bot sends as `content` carries a link somewhere — a PR
 * URL, a jump link, or a user's own free text echoed back — and an unfurl under
 * each one is noise reviewers delete by hand. `components.test.ts` pins the bit.
 */
export const SUPPRESS_EMBEDS_FLAG = 1 << 2;

export interface InteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    embeds?: { color: number; description: string }[];
    components?: unknown[];
    custom_id?: string;
    title?: string;
  };
}

export function pong(): InteractionResponse {
  return { type: CallbackType.Pong };
}

/** Rejections are ephemeral, so a mistake leaves no noise in the channel — but
 *  ephemeral is not silent: every message names the problem and its fix.
 *
 *  Unfurls are suppressed. No caller writes a URL, but several interpolate a PR
 *  title straight from GitHub, and a title is free text: "Revert
 *  https://github.com/o/r/pull/9" would unfurl under the reply. */
export function ephemeral(content: string): InteractionResponse {
  return {
    type: CallbackType.ChannelMessageWithSource,
    data: { content, flags: EPHEMERAL_FLAG | SUPPRESS_EMBEDS_FLAG },
  };
}

/** An ephemeral response carrying embeds rather than plain content. Plain
 *  `content` caps at 2000 characters, which is the whole reason the digest is an
 *  embed in the first place; a reply that is supposed to show MORE than the
 *  digest cannot be built out of the surface the digest had to escape.
 *
 *  Deliberately does NOT carry `SUPPRESS_EMBEDS_FLAG`, unlike `ephemeral`: that
 *  flag hides a message's own embeds too, so here it would return an empty
 *  reply. */
export function ephemeralEmbeds(embeds: { color: number; description: string }[]): InteractionResponse {
  return {
    type: CallbackType.ChannelMessageWithSource,
    data: { embeds, flags: EPHEMERAL_FLAG },
  };
}
