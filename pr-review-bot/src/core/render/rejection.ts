import type { Config } from "../../../config/config.js";
import { URL_MAX_LENGTH, type SubmitRejection, type SubmittedValues } from "../submit.js";
import { noteRequiredLevel, urgencyText } from "../urgency.js";

export const RETRY_PREFIX = "request:retry:";

const MESSAGE_LIMIT = 2000;
const FIELD_ECHO_LIMIT = 300;

const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_PRIMARY = 1;

/** The values cannot travel in the button — a PR URL alone is most of the
 *  100-character `custom_id` cap — so the button carries only the stash key. */
export function retryCustomId(interactionId: string): string {
  return `${RETRY_PREFIX}${interactionId}`.slice(0, 100);
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function headline(rejection: SubmitRejection, config: Config): string {
  switch (rejection.reason) {
    case "not-a-pr":
      return "That does not look like a GitHub pull request link. Expected shape: `https://github.com/owner/repo/pull/123`";
    case "url-too-long":
      return (
        `That link is longer than ${URL_MAX_LENGTH} characters, which is more than a PR link needs. ` +
        "It was not shortened for you — a truncated link can still point at a real but *different* PR. " +
        "Paste the plain `https://github.com/owner/repo/pull/123` form, without tracking parameters."
      );
    case "invalid-team":
      return (
        `That team is not on the current list — pick one of: ${config.teams.join(", ")}. ` +
        "It may have changed since this form was opened."
      );
    case "invalid-urgency":
      return (
        `That urgency is not on the current list — pick one of: ${config.urgencies.map((u) => urgencyText(u)).join(", ")}. ` +
        "It may have changed since this form was opened."
      );
    case "note-required": {
      const level = noteRequiredLevel(config);
      const name = level === null ? "Blocking" : urgencyText(level);
      return (
        `**${name}** needs a note saying what is blocked. ` +
        "The modal cannot ask for it conditionally — it has no re-render — so it is checked here instead."
      );
    }
    case "merged":
      return "That PR is already **merged**, so there is nothing left to review.";
    case "closed":
      return "That PR is **closed**, so there is nothing left to review.";
    case "not-found":
      return (
        `The bot could not read **${clamp(rejection.slug, 120)}**. Either the PR does not exist, or the bot ` +
        "cannot see it — GitHub answers both the same way, so this message cannot tell them apart. " +
        "Check the number first; if it is right, the repo is private to the bot."
      );
    case "credential":
      return (
        `The bot's GitHub **credential** for **${clamp(rejection.slug, 120)}** is failing, so it could not check ` +
        "that PR. This is not something you can fix from here — the request was not recorded. Check `/health`."
      );
  }
}

/**
 * A rejection the requester sees and nobody else.
 *
 * Ephemeral is not silent: every rejection names the specific problem and its
 * fix, and echoes the submitted values inline. The echo is not decoration — the
 * retry button dies with its 15-minute interaction token, and after that the
 * echoed text is the only copy of what the user typed.
 */
export function renderRejection(input: {
  rejection: SubmitRejection;
  values: SubmittedValues;
  stashKey: string | null;
  config: Config;
}): { content: string; components: unknown[] } {
  const { values } = input;
  const echo = [
    `> **Link:** ${clamp(values.url, FIELD_ECHO_LIMIT)}`,
    `> **Team:** ${clamp(values.team, FIELD_ECHO_LIMIT)} · **Urgency:** ${clamp(values.urgency, FIELD_ECHO_LIMIT)}`,
    ...(values.note.trim() === "" ? [] : [`> **Note:** ${clamp(values.note, FIELD_ECHO_LIMIT)}`]),
  ].join("\n");

  const content = clamp(
    `${headline(input.rejection, input.config)}\n\nNothing was posted. What you entered:\n${echo}`,
    MESSAGE_LIMIT,
  );

  const components =
    input.stashKey === null
      ? []
      : [
          {
            type: COMPONENT_ACTION_ROW,
            components: [
              {
                type: COMPONENT_BUTTON,
                style: BUTTON_STYLE_PRIMARY,
                label: "Fix and retry",
                custom_id: retryCustomId(input.stashKey),
              },
            ],
          },
        ];

  return { content, components };
}
