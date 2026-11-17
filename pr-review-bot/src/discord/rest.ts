import type { Config } from "../../config/config.js";
import type { DigestPayload, DigestPublisher } from "../store/types.js";
import { SUPPRESS_EMBEDS_FLAG } from "./components.js";

const API = "https://discord.com/api/v10";

/** Only the id: the bot posts, edits and pins messages but never reads them. */
export interface DiscordMessage {
  id: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  /** Discord's display name. Nullable — fall back to `username`. */
  global_name?: string | null;
}

export type RestResult<T> = { ok: true; value: T } | { ok: false; status: number; body: string };

export class DiscordRest {
  constructor(private readonly token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<RestResult<T>> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "pr-review-bot (https://github.com/paranext, 1.0)",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, body: await response.text() };
    }
    if (response.status === 204) return { ok: true, value: undefined as T };
    return { ok: true, value: (await response.json()) as T };
  }

  /**
   * Edits the deferred reply to an interaction.
   *
   * Deliberately does NOT go through `call()`: that method sends
   * `Authorization: Bot …` on everything, and this route is authenticated by the
   * interaction token in the PATH. Discord's docs do not say whether a bot
   * header is tolerated here, so this sends none rather than resting on
   * folklore — and it keeps the bot token off a route that has no need of it.
   *
   * The token expires 15 minutes after the interaction; a 404 here is the
   * expected shape of "too late", not an error worth retrying.
   */
  async editInteractionResponse(
    appId: string,
    token: string,
    body: { content?: string; components?: unknown[]; flags?: number },
  ): Promise<RestResult<unknown>> {
    const response = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "pr-review-bot (https://github.com/paranext, 1.0)",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) return { ok: false, status: response.status, body: await response.text() };
    if (response.status === 204) return { ok: true, value: undefined };
    return { ok: true, value: await response.json() };
  }

  /**
   * Reactors for one custom emoji on one message.
   *
   * `emoji` must be the literal `name:id` form — Discord requires the colon in
   * the path. `encodeURIComponent` on its own does NOT leave `:` alone (it
   * escapes it to `%3A`, which reads back as 10014 Unknown Emoji on every
   * read) — only `encodeURI` does that. So the name and id are encoded
   * separately and rejoined with a literal colon: today's id is numeric and
   * needs no escaping, but a future emoji whose NAME needs escaping is still
   * covered.
   *
   * `type` is Discord's reaction type: 0 NORMAL (the default), 1 BURST (super
   * reactions). Only the release path reads type 1 — see `readReactors`.
   */
  getReactions(
    channelId: string,
    messageId: string,
    emoji: string,
    opts: { limit: number; type?: 0 | 1 },
  ): Promise<RestResult<DiscordUser[]>> {
    const params = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.type !== undefined) params.set("type", String(opts.type));
    const colon = emoji.lastIndexOf(":");
    const encodedEmoji =
      colon === -1
        ? encodeURIComponent(emoji)
        : `${encodeURIComponent(emoji.slice(0, colon))}:${encodeURIComponent(emoji.slice(colon + 1))}`;
    return this.call<DiscordUser[]>(
      "GET",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}?${params.toString()}`,
    );
  }

  patchMessage(channelId: string, messageId: string, payload: DigestPayload): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
  }

  /** Embeds only. Plain-content posts go through `postContent`, which is the
   *  one place `SUPPRESS_EMBEDS_FLAG` is set — keeping the two shapes on
   *  separate methods means the flag can never reach a message whose embeds it
   *  would blank. */
  postMessage(channelId: string, payload: DigestPayload): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("POST", `/channels/${channelId}/messages`, payload);
  }

  /** Every message this bot sends as `content` carries a link somewhere — a PR
   *  URL, a jump link, or free text from GitHub or a user — so the unfurl is
   *  always suppressed here rather than remembered at each call site. */
  postContent(channelId: string, content: string): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("POST", `/channels/${channelId}/messages`, {
      content,
      flags: SUPPRESS_EMBEDS_FLAG,
    });
  }

  /**
   * Opens (or returns) the DM channel with one user. Idempotent — Discord
   * returns the existing channel if there is one.
   */
  createDmChannel(userId: string): Promise<RestResult<{ id: string }>> {
    return this.call<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
  }

  /**
   * The 2026 pins route. `GET /channels/{id}/pins` is deprecated and returns a
   * different shape, so using it would silently report the digest as unpinned
   * forever.
   */
  getPins(channelId: string): Promise<RestResult<{ items: { message: DiscordMessage }[] }>> {
    return this.call<{ items: { message: DiscordMessage }[] }>("GET", `/channels/${channelId}/messages/pins`);
  }
}

export function makeDigestPublisher(
  rest: DiscordRest,
  guildId: string,
  config: Config,
): DigestPublisher {
  const channelId = config.digestChannelId;
  return {
    async listPinnedMessageIds() {
      const result = await rest.getPins(channelId);
      if (!result.ok) return [];
      return result.value.items.map((item) => item.message.id);
    },
    async patchDigest(messageId, payload) {
      const result = await rest.patchMessage(channelId, messageId, payload);
      return result.ok ? { ok: true } : { ok: false, status: result.status };
    },
    async createDigest(payload) {
      const result = await rest.postMessage(channelId, payload);
      return result.ok ? { ok: true, messageId: result.value.id } : { ok: false, status: result.status };
    },
    async postDaily(content) {
      // The daily post's jump link points at a discord.com message URL, which
      // Discord previews like any other link — `postContent` suppresses it.
      const result = await rest.postContent(channelId, content);
      return result.ok ? { ok: true, messageId: result.value.id } : { ok: false, status: result.status };
    },
    messageUrl(messageId) {
      return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    },
  };
}
