import type { Config } from "../../../config/config.js";
import type { PrRecord } from "../record.js";
import { urgencyFor, urgencyText } from "../urgency.js";

const DISCORD_MESSAGE_LIMIT = 2000;

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderRequestMessage(r: PrRecord, config: Config): string {
  const level = urgencyFor(r, config);
  const url = `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;

  const headParts: string[] = [];
  if (level !== null) headParts.push(urgencyText(level, { bold: true }));
  if (r.team !== null) headParts.push(r.team.toLowerCase());
  headParts.push(clamp(r.title, 400));
  if (r.isDraft) headParts.push("draft");

  const lines: string[] = [headParts.join(" · ")];

  const attribution: string[] = [];
  if (r.prdThreadId !== null) attribution.push(`<#${r.prdThreadId}>`);
  if (r.requesterId !== null) attribution.push(`requested by <@${r.requesterId}>`);
  if (attribution.length > 0) lines.push(attribution.join(" · "));

  if (r.note !== null && r.note.trim() !== "") lines.push(clamp(r.note.trim(), 400));

  // The URL must survive clamping intact: a truncated link kills the unfurl,
  // which is the whole reason it sits alone on its own line. So the budget is
  // spent on everything else first.
  const maxHeadLength = DISCORD_MESSAGE_LIMIT - url.length - 1;
  if (maxHeadLength < 1) {
    // URL alone exceeds the limit; clamp it and accept the overflow.
    return clamp(url, DISCORD_MESSAGE_LIMIT);
  }
  const head = clamp(lines.join("\n"), maxHeadLength);
  return `${head}\n${url}`;
}
