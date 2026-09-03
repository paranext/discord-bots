import type { Config } from "../../config/config.js";
import { FIELD_IDS, MODAL_ID, NOTE_MAX_LENGTH, PRD_NONE, URL_MAX_LENGTH, type SubmittedValues } from "../core/submit.js";
import type { PrdCache } from "../core/prd.js";
import { CallbackType, type InteractionResponse } from "../discord/components.js";

// Discord's documented caps. Clamped here rather than discovered at runtime: a
// 400 from Discord on this path is an outage on the primary command.
const TITLE = 45;
const LABEL = 45;
const DESCRIPTION = 100;
const OPTION = 100;
const TEXT_VALUE = 4000;

const COMPONENT_LABEL = 18;
const COMPONENT_SELECT = 3;
const COMPONENT_TEXT = 4;
const TEXT_STYLE_SHORT = 1;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function label(text: string, description: string | undefined, component: Record<string, unknown>) {
  return {
    type: COMPONENT_LABEL,
    label: clamp(text, LABEL),
    ...(description === undefined ? {} : { description: clamp(description, DESCRIPTION) }),
    component,
  };
}

function select(
  customId: string,
  options: { label: string; value: string; description?: string }[],
  chosen: string | null,
) {
  return {
    type: COMPONENT_SELECT,
    custom_id: customId,
    min_values: 1,
    max_values: 1,
    options: options.map((o) => ({
      label: clamp(o.label, OPTION),
      value: clamp(o.value, OPTION),
      ...(o.description === undefined ? {} : { description: clamp(o.description, OPTION) }),
      ...(chosen !== null && o.value === chosen ? { default: true } : {}),
    })),
  };
}

function text(customId: string, opts: {
  required: boolean;
  placeholder?: string;
  value?: string | undefined;
  maxLength?: number;
}) {
  const maxLength = opts.maxLength ?? TEXT_VALUE;
  return {
    type: COMPONENT_TEXT,
    custom_id: customId,
    style: TEXT_STYLE_SHORT,
    required: opts.required,
    max_length: maxLength,
    ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
    ...(opts.value === undefined ? {} : { value: clamp(opts.value, maxLength) }),
  };
}

/**
 * The `/review-request` modal, built ENTIRELY from cached data.
 *
 * Nothing here may fetch. A modal cannot be sent after a deferred response, so
 * if the 3-second budget is missed the user sees "The application did not
 * respond" on the primary command with no escape hatch — any live call on this
 * path is a latent outage.
 *
 * A cold or failed cache is not an error: the PRD select falls back to None
 * alone and says why. One request with no PRD attached is exactly what every
 * scanned record already looks like.
 */
export function buildRequestModal(config: Config, prd: PrdCache | null, prefill?: SubmittedValues): InteractionResponse {
  const prdOptions = [
    { label: "None", value: PRD_NONE },
    ...(prd?.options ?? []).map((o) => ({ label: o.name, value: o.id })),
  ];

  // The two notes are mutually exclusive: an empty cache is never truncated.
  const prdNote =
    prd === null || prd.options.length === 0
      ? "The PRD list is still loading — pick None and re-request later if you need one."
      : prd.truncated
        ? "Showing the 24 most recently active PRDs."
        : undefined;

  return {
    type: CallbackType.Modal,
    data: {
      custom_id: MODAL_ID,
      title: clamp("Request a review", TITLE),
      components: [
        label("PR link", undefined, text(FIELD_IDS.url, {
          required: true,
          placeholder: "https://github.com/owner/repo/pull/123",
          value: prefill?.url,
          maxLength: URL_MAX_LENGTH,
        })),
        label("Team", undefined, select(
          FIELD_IDS.team,
          config.teams.map((t) => ({ label: t, value: t })),
          prefill?.team ?? null,
        )),
        label("Urgency", undefined, select(
          FIELD_IDS.urgency,
          config.urgencies.map((u) => ({
            label: `${u.emoji} ${u.label}`,
            value: u.key,
            // The requirement rides on the OPTION that triggers it, not on the
            // note field: the field's `required` is static in a payload Discord
            // renders before any choice is made, so the rule is enforced on
            // submit and this is the only place a user can be warned in advance.
            ...(u.requiresNote ? { description: "Requires a note explaining what is blocked." } : {}),
          })),
          prefill?.urgency ?? null,
        )),
        label("PRD", prdNote, select(FIELD_IDS.prd, prdOptions, prefill?.prdThreadId ?? PRD_NONE)),
        label("Note", "Optional, except for 🔥 Blocking.", text(FIELD_IDS.note, {
          required: false,
          placeholder: "just the CSS bit / needs a P10 build",
          value: prefill?.note,
          maxLength: NOTE_MAX_LENGTH,
        })),
      ],
    },
  };
}
