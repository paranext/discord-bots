import type { Config } from "../../config/config.js";
import type { RawThread } from "../core/prd.js";
import type { DigestPayload, DigestPublisher } from "../store/types.js";

const API = "https://discord.com/api/v10";

export interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: { id: string; bot?: boolean; username: string };
}

export interface DiscordApplication {
  id: string;
  flags: number;
}

/**
 * GATEWAY_MESSAGE_CONTENT and GATEWAY_MESSAGE_CONTENT_LIMITED — **application
 * flags**, NOT the gateway intents bitfield. Both values are confirmed against
 * Discord's documented application-flags table (`GATEWAY_MESSAGE_CONTENT` =
 * `1 << 18` = 262144, `GATEWAY_MESSAGE_CONTENT_LIMITED` = `1 << 19` = 524288).
 *
 * The application-flags/gateway-intents distinction is the part worth keeping in
 * mind, because it is what made this easy to get wrong: the gateway intents
 * bitfield ALSO has a `MESSAGE_CONTENT`, at `1 << 15`, and the application-flags
 * table independently has a `GATEWAY_GUILD_MEMBERS_LIMITED` at `1 << 15` — the
 * same number in two different fields. This bot has no gateway connection at
 * all; it reads `flags` from `GET /applications/@me`, so the application-flags
 * table is the only one that applies.
 *
 * `rest.test.ts` pins these to raw literals. That pin stays: it is what would
 * catch a future edit to either constant, and deriving the fixture from the
 * constant is what made an earlier version of it tautological.
 */
export const FLAG_MESSAGE_CONTENT = 1 << 18;
export const FLAG_MESSAGE_CONTENT_LIMITED = 1 << 19;

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
   * One page, newest-first with no cursor; ascending after `after`; descending
   * (older) before `before`. `before` is what a first-run backward walk needs —
   * see Task 14 — since `after=<newest id>` has no messages newer than it to find.
   * Caps at 100.
   */
  getMessages(
    channelId: string,
    opts: { after?: string; before?: string; limit?: number },
  ): Promise<RestResult<DiscordMessage[]>> {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 100) });
    if (opts.after !== undefined) params.set("after", opts.after);
    if (opts.before !== undefined) params.set("before", opts.before);
    return this.call<DiscordMessage[]>("GET", `/channels/${channelId}/messages?${params.toString()}`);
  }

  patchMessage(channelId: string, messageId: string, payload: DigestPayload): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("PATCH", `/channels/${channelId}/messages/${messageId}`, payload);
  }

  postMessage(channelId: string, payload: DigestPayload | { content: string }): Promise<RestResult<DiscordMessage>> {
    return this.call<DiscordMessage>("POST", `/channels/${channelId}/messages`, payload);
  }

  /**
   * The 2026 pins route. `GET /channels/{id}/pins` is deprecated and returns a
   * different shape, so using it would silently report the digest as unpinned
   * forever.
   */
  getPins(channelId: string): Promise<RestResult<{ items: { message: DiscordMessage }[] }>> {
    return this.call<{ items: { message: DiscordMessage }[] }>("GET", `/channels/${channelId}/messages/pins`);
  }

  /**
   * Guild-wide, NOT per-channel: results must be filtered by `parent_id`. There
   * is no channel-scoped active-threads route.
   */
  getActiveThreads(guildId: string): Promise<RestResult<{ threads: RawThread[] }>> {
    return this.call<{ threads: RawThread[] }>("GET", `/guilds/${guildId}/threads/active`);
  }

  /**
   * Ordered by `archive_timestamp` descending, and it reports `has_more`. We
   * read ONE page and ignore `has_more` deliberately: only the newest slice can
   * survive the 24-option cap anyway. (Pagination is available if that ever
   * changes — `before` here is an ISO8601 timestamp, not a snowflake.)
   */
  getArchivedPublicThreads(
    channelId: string,
    limit: number,
  ): Promise<RestResult<{ threads: RawThread[]; has_more?: boolean }>> {
    return this.call<{ threads: RawThread[]; has_more?: boolean }>(
      "GET",
      `/channels/${channelId}/threads/archived/public?limit=${limit}`,
    );
  }

  getApplication(): Promise<RestResult<DiscordApplication>> {
    return this.call<DiscordApplication>("GET", "/applications/@me");
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
      const result = await rest.postMessage(channelId, { content });
      return result.ok ? { ok: true, messageId: result.value.id } : { ok: false, status: result.status };
    },
    messageUrl(messageId) {
      return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    },
  };
}
