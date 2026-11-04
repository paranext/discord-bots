import type { Config } from "../../config/config.js";
import { parsePrUrl, type ParsedPr, type ParseFailure } from "./urls.js";
import { urgencyLevel } from "./urgency.js";

/**
 * A modal submission exactly as the user typed it, before any interpretation.
 *
 * Raw strings, not parsed values, because this is what the "Fix and retry"
 * prefill has to put back into the form — a normalised or partially-parsed copy
 * would hand the user back something they did not type.
 */
export interface SubmittedValues {
  url: string;
  team: string;
  urgency: string;
  note: string;
}

/** The modal's own custom_id, so the interaction router can tell this submit
 *  apart from any other MODAL_SUBMIT. Written by the builder (Task 6), read by
 *  the parser below (Task 7). */
export const MODAL_ID = "request:modal";

/** The modal's four field custom_ids — the vocabulary the builder writes and
 *  the parser reads, kept in one place so the two cannot drift apart. */
export const FIELD_IDS = {
  url: "url",
  team: "team",
  urgency: "urgency",
  note: "note",
} as const;

/** Discord's own text-input cap is 4000 characters; these are ours, tighter,
 *  and enforced twice: as `max_length` on the modal's own inputs (the modal is
 *  what a well-behaved client obeys) and again here at parse time (the modal is
 *  client-side, so this is the trust boundary a stale or modified client can't
 *  cross). A long URL or note otherwise threatens the retry stash's 2 MB
 *  Durable Object value and the digest's per-row render budget. */
export const URL_MAX_LENGTH = 200;
export const NOTE_MAX_LENGTH = 500;

/**
 * Every way a submission can be turned down, offline and online alike.
 *
 * The last four are produced by the handler after the GitHub fetch rather than
 * by `parseSubmission`. They live in the same union so ONE renderer covers every
 * rejection — a second rejection renderer is how two rejection paths come to
 * disagree about whether they carry a retry button.
 */
export type SubmitRejection =
  | { reason: "not-a-pr"; detail: ParseFailure }
  | { reason: "url-too-long" }
  | { reason: "invalid-team" }
  | { reason: "invalid-urgency" }
  | { reason: "note-required" }
  | { reason: "merged" }
  | { reason: "closed" }
  | { reason: "not-found"; slug: string }
  | { reason: "credential"; slug: string };

export type SubmitParse =
  | { ok: true; pr: ParsedPr; values: SubmittedValues }
  | { ok: false; values: SubmittedValues; rejection: SubmitRejection };

/**
 * Flattens a modal submission into `custom_id -> value`.
 *
 * It WALKS the tree rather than indexing fixed positions, and reads both a text
 * input's `value` and a select's `values[0]`. Discord has already changed this
 * shape once — modals moved from action rows to `Label` wrappers — and a parser
 * that indexes positions breaks silently on the next such change, turning every
 * submission into a validation error nobody can explain.
 */
export function collectValues(components: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  // Guards against a cyclic object: without it, a self-referential payload
  // would recurse until the stack overflows, which is a throw by another name.
  const seen = new WeakSet<object>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      if (seen.has(node)) return;
      seen.add(node);
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    const rec = node as Record<string, unknown>;

    const id = rec["custom_id"];
    if (typeof id === "string") {
      if (typeof rec["value"] === "string") found[id] = rec["value"];
      else if (Array.isArray(rec["values"]) && typeof rec["values"][0] === "string") found[id] = rec["values"][0];
    }

    visit(rec["component"]);
    visit(rec["components"]);
  };

  visit(components);
  return found;
}

export function parseSubmission(components: unknown, config: Config): SubmitParse {
  const raw = collectValues(components);
  const rawUrl = raw[FIELD_IDS.url] ?? "";

  // Unnormalised APART FROM the two length caps: this is what the retry prefill
  // hands back, and a user who typed trailing whitespace should see their own
  // text, not a cleaned copy. The caps are applied here and nowhere later
  // because `values` is the copy `reject()` STASHES, and the stash is the 2 MB
  // Durable Object value the caps exist to protect — clamping only on the
  // success path leaves the persisting path unbounded.
  const values: SubmittedValues = {
    url: rawUrl.slice(0, URL_MAX_LENGTH),
    team: raw[FIELD_IDS.team] ?? "",
    urgency: raw[FIELD_IDS.urgency] ?? "",
    note: (raw[FIELD_IDS.note] ?? "").slice(0, NOTE_MAX_LENGTH),
  };

  // Cast-then-trust downstream (`RequestFields["team"]`/`["urgency"]`) is only
  // safe because this rejects anything not currently in config first. A stale
  // modal held open across a config deploy, or a select with no value chosen at
  // all (empty string), would otherwise sort to the top of the digest as a
  // bogus section — `ranking.ts`'s `config.teams.indexOf` returns -1 for
  // anything not in the list, which sorts before every real team.
  if (!config.teams.includes(values.team as Config["teams"][number])) {
    return { ok: false, values, rejection: { reason: "invalid-team" } };
  }

  const level = urgencyLevel(values.urgency, config);
  if (level === null) {
    return { ok: false, values, rejection: { reason: "invalid-urgency" } };
  }
  if (level.requiresNote === true && values.note.trim() === "") {
    // Enforced HERE and not in the modal: `required` is static in a payload
    // Discord renders before the user picks an urgency, and a modal has no
    // conditional logic and no re-render.
    return { ok: false, values, rejection: { reason: "note-required" } };
  }

  // Rejected, not parsed-after-clamping. A clamp can leave a link that still
  // parses — `.../pull/12345` truncated to `.../pull/1234` is a valid URL for a
  // DIFFERENT PR — so silently accepting the clamped copy would track the wrong
  // pull request. Only the length is judged from the raw value; everything
  // downstream reads the clamped `values`.
  if (rawUrl.length > URL_MAX_LENGTH) {
    return { ok: false, values, rejection: { reason: "url-too-long" } };
  }

  const parsed = parsePrUrl(values.url);
  if (!parsed.ok) return { ok: false, values, rejection: { reason: "not-a-pr", detail: parsed.reason } };

  return { ok: true, pr: parsed.pr, values };
}
