import type { Config } from "../../config/config.js";
import { renderDigest } from "../core/render/digest.js";
import { ephemeralEmbeds, type InteractionResponse } from "../discord/components.js";
import type { StoreState } from "../store/types.js";

/** No truncation at this level: an ephemeral message is not a permanent
 *  surface, so show everything that fits rather than the digest's 20-row
 *  budget. */
const REVIEW_LIST_MAX_ROWS = 200;

/**
 * The same content, ephemerally. Cheap, and it decouples the tool's value from a
 * pin the bot cannot restore itself — which is why it is registered from day one
 * rather than when the command half ships.
 *
 * Returns the renderer's EMBEDS, not a flattened `content` string. Flattening
 * capped this reply at Discord's 2000-character message limit — the very limit
 * the digest is an embed to escape — so the surface the digest's overflow notice
 * names as the way to "see everything" held about ten rows against the digest's
 * twenty, and its cut landed mid-markdown-link, rendering the last row as broken
 * syntax. Embeds carry 4096 per description and 6000 across them, and
 * `renderDigest` already packs whole rows into that budget and names anything it
 * could not fit.
 */
export function renderReviewList(state: StoreState, config: Config, now: number): InteractionResponse {
  const render = renderDigest({
    records: Object.values(state.records),
    lastSync: state.meta.lastSync,
    now,
    maxRows: REVIEW_LIST_MAX_ROWS,
    config,
  });

  return ephemeralEmbeds(render.embeds);
}
