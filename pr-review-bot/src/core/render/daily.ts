import type { Config } from "../../../config/config.js";
import { isOpen, type PrRecord } from "../record.js";
import { relTs } from "../time.js";

export interface DailyInput {
  records: PrRecord[];
  digestMessageUrl: string | null;
  config: Config;
}

/**
 * Posted only when something is waiting, so a clear queue is silent and the post
 * never becomes wallpaper. Names counts and the oldest age — never an individual,
 * which is what keeps it outside the non-goal on per-person nudges.
 */
export function renderDailyPost(input: DailyInput): string | null {
  const open = input.records.filter(isOpen);
  if (open.length === 0) return null;

  const oldest = open.reduce((a, b) => (a.firstRequestedAt <= b.firstRequestedAt ? a : b));
  const noun = open.length === 1 ? "PR" : "PRs";

  const sentences: string[] = [
    `**${open.length} ${noun} waiting for review.** Oldest was requested ${relTs(oldest.firstRequestedAt)}.`,
  ];

  const blocking = open.filter((r) => r.urgency === "blocking");
  if (blocking.length > 0) {
    sentences.push(blocking.length === 1 ? "One is blocking." : `${blocking.length} are blocking.`);
  }

  if (input.digestMessageUrl !== null) {
    sentences.push(`[Jump to the list ↗](${input.digestMessageUrl})`);
  }

  return sentences.join(" ");
}
