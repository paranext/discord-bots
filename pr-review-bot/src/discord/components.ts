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
  DeferredUpdateMessage: 6,
} as const;

export const EPHEMERAL_FLAG = 1 << 6;

export interface InteractionResponse {
  type: number;
  data?: { content?: string; flags?: number; embeds?: { color: number; description: string }[] };
}

export function pong(): InteractionResponse {
  return { type: CallbackType.Pong };
}

/** Rejections are ephemeral, so a mistake leaves no noise in the channel — but
 *  ephemeral is not silent: every message names the problem and its fix. */
export function ephemeral(content: string): InteractionResponse {
  return {
    type: CallbackType.ChannelMessageWithSource,
    data: { content, flags: EPHEMERAL_FLAG },
  };
}

/** An ephemeral response carrying embeds rather than plain content. Plain
 *  `content` caps at 2000 characters, which is the whole reason the digest is an
 *  embed in the first place; a reply that is supposed to show MORE than the
 *  digest cannot be built out of the surface the digest had to escape. */
export function ephemeralEmbeds(embeds: { color: number; description: string }[]): InteractionResponse {
  return {
    type: CallbackType.ChannelMessageWithSource,
    data: { embeds, flags: EPHEMERAL_FLAG },
  };
}
