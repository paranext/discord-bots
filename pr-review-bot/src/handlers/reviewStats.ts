import { renderReviewStats } from "../core/render/stats.js";
import { reviewStatsSummary } from "../core/stats/figures.js";
import { ephemeralEmbeds, type InteractionResponse } from "../discord/components.js";
import type { StoreState } from "../store/types.js";

/** Private, so it works in any channel: the figures are team-wide and
 *  anonymous, and an ephemeral reply leaves nothing behind in a channel. */
export function reviewStatsResponse(state: StoreState): InteractionResponse {
  return ephemeralEmbeds(renderReviewStats(reviewStatsSummary(state.stats)));
}
