import type { Config, UrgencyLevel } from "../../config/config.js";
import type { PrRecord } from "./record.js";

/**
 * The one place an urgency key is resolved against the configured levels, and
 * the one place a level is turned into display text.
 *
 * Both exist because an urgency level's emoji is OPTIONAL. Six call sites used
 * to interpolate `${level.emoji} ${level.label}` directly, which puts a leading
 * space in front of every level that has no emoji, and one of them recovered
 * the emoji alone by splitting that string on its first space — which returns
 * the label's first word, not an emoji, exactly when there is no emoji.
 */

/** Null for no key, and for a key the config no longer lists — a stored record
 *  can outlive the level it was filed under, and a modal can be submitted after
 *  a config deploy removed the level it offered. */
export function urgencyLevel(key: string | null, config: Config): UrgencyLevel | null {
  if (key === null) return null;
  return config.urgencies.find((u) => u.key === key) ?? null;
}

export function urgencyFor(record: PrRecord, config: Config): UrgencyLevel | null {
  return urgencyLevel(record.urgency, config);
}

/** `"🔥 Blocking"`, or `"Soon"` for a level with no emoji. `bold` wraps the
 *  label only, so the emoji is never inside the markdown. */
export function urgencyText(level: UrgencyLevel, options: { bold?: boolean } = {}): string {
  const label = options.bold === true ? `**${level.label}**` : level.label;
  return level.emoji === null ? label : `${level.emoji} ${label}`;
}

/** The record's urgency emoji alone, or null — for a record with no urgency AND
 *  for a level with no emoji. Never falls back to part of the label.
 *
 *  Used where only the icon fits (claimed rows, menu options), so there a level
 *  with no emoji looks the same as no urgency. That is accepted: by then the PR
 *  is claimed or already sorted, and only 🔥 / 🧊 still carry an instruction. */
export function urgencyEmojiFor(record: PrRecord, config: Config): string | null {
  return urgencyFor(record, config)?.emoji ?? null;
}

/** The level whose selection requires a note, or null if none does. */
export function noteRequiredLevel(config: Config): UrgencyLevel | null {
  return config.urgencies.find((u) => u.requiresNote) ?? null;
}
