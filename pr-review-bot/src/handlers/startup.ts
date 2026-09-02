import type { DiscordRest } from "../discord/rest.js";
import { FLAG_MESSAGE_CONTENT, FLAG_MESSAGE_CONTENT_LIMITED } from "../discord/rest.js";

export type IntentCheck =
  | { ok: true; limited: boolean }
  | { ok: false; code: "INTENT_MISSING" | "UNREACHABLE"; detail: string };

/**
 * Without the Message Content privileged intent, GET /channels/{id}/messages
 * returns content: "" for every message the bot did not author — so scanning
 * silently extracts zero links and the whole of shadow mode reports an empty
 * list. This check reads the application's declared flags, which is the only
 * signal that distinguishes "no links" from "no content".
 */
export async function assertMessageContentIntent(rest: DiscordRest): Promise<IntentCheck> {
  const application = await rest.getApplication();
  if (!application.ok) {
    return { ok: false, code: "UNREACHABLE", detail: `GET /applications/@me returned ${application.status}` };
  }
  const flags = application.value.flags;
  const full = (flags & FLAG_MESSAGE_CONTENT) !== 0;
  const limited = (flags & FLAG_MESSAGE_CONTENT_LIMITED) !== 0;
  if (!full && !limited) {
    return {
      ok: false,
      code: "INTENT_MISSING",
      detail:
        "MESSAGE CONTENT intent is not enabled. Enable it in the Developer Portal " +
        "(Bot → Privileged Gateway Intents). Without it, channel scanning reads " +
        "empty content and the digest will be silently empty.",
    };
  }
  return { ok: true, limited: !full && limited };
}
