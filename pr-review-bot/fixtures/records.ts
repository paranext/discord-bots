import type { TeamName, UrgencyKey } from "../config/config.js";
import type { ParsedPr } from "../src/core/urls.js";
import { newCommandRecord, resolveRecord, type PrRecord } from "../src/core/record.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixed so no fixture depends on the real clock: 2026-08-31T16:00:00Z, which is
 * 11:00 America/Chicago. Same instant as `T0` in every other task's tests — the
 * digest renderer only uses relative offsets, but keeping one value everywhere
 * removes a trap for anyone who later adds a date- or local-hour-dependent
 * assertion here.
 */
export const FIXTURE_NOW = 1_788_192_000_000;

export interface Scenario {
  key: string;
  label: string;
  tests: string;
  records: PrRecord[];
  lastSync: number | null;
  now: number;
  maxRows?: number;
}

export interface TestRecordInput {
  pr: ParsedPr;
  channelId: string;
  messageId: string | null;
  messageTimestamp: number;
  title: string;
  prAuthorLogin: string | null;
  isDraft: boolean;
}

/** A command record with no team, urgency, note or requester — what tests that
 *  need a bare open row used to get from the scan's factory — with `overrides`
 *  spread on top. */
export function testRecord(input: TestRecordInput, overrides: Partial<PrRecord> = {}): PrRecord {
  const record = newCommandRecord({
    pr: input.pr,
    at: input.messageTimestamp,
    // Placeholders for the required fields, nulled below: a real request
    // always has them, and `RequestFields` says so.
    fields: {
      team: "Power",
      urgency: "soon",
      note: null,
      requesterId: "",
      requesterName: "",
      channelId: input.channelId,
      messageId: input.messageId,
    },
    title: input.title,
    prAuthorLogin: input.prAuthorLogin,
    isDraft: input.isDraft,
  });
  return { ...record, team: null, urgency: null, requesterId: null, requesterName: null, ...overrides };
}

interface MakeInput {
  owner?: string;
  repo: string;
  number: number;
  title: string;
  team?: TeamName | null;
  urgency?: UrgencyKey | null;
  ageMs: number;
  note?: string | null;
  isDraft?: boolean;
  claimedByName?: string | null;
  lastClaimedByName?: string | null;
  syncPaused?: boolean;
}

export function make(input: MakeInput): PrRecord {
  return testRecord(
    {
      pr: { owner: input.owner ?? "paranext", repo: input.repo, number: input.number },
      channelId: "chan",
      messageId: `msg-${input.repo}-${input.number}`,
      messageTimestamp: FIXTURE_NOW - input.ageMs,
      title: input.title,
      prAuthorLogin: "jolie",
      isDraft: input.isDraft ?? false,
    },
    {
      team: input.team ?? null,
      urgency: input.urgency ?? null,
      note: input.note ?? null,
      requesterId: "u-jolie",
      requesterName: "Jolie",
      claimedBy: input.claimedByName == null ? null : "u-claimer",
      claimedByName: input.claimedByName ?? null,
      claimedAt: input.claimedByName == null ? null : FIXTURE_NOW - 2 * HOUR,
      lastClaimedByName: input.lastClaimedByName ?? null,
      claimClearedAt: input.lastClaimedByName == null ? null : FIXTURE_NOW - HOUR,
      syncPausedSince: input.syncPaused === true ? FIXTURE_NOW - DAY : null,
    },
  );
}

const ordinaryDay: PrRecord[] = [
  make({ repo: "paratext-10-studio", number: 177, title: "PT-4398 P10 backend sync-activity signal", team: "Power", urgency: "blocking", ageMs: 3 * DAY, note: "needs a P10 build before Thursday's demo" }),
  make({ repo: "paranext-core", number: 2701, title: "PT-4401 Sync activity indicator", team: "Power", urgency: "soon", ageMs: 6 * HOUR }),
  make({ repo: "paranext-core", number: 2695, title: "PT-4363 Internet Settings UI Enhancements", team: "Simple", urgency: "thisWeek", ageMs: 8 * DAY, isDraft: true }),
  make({ repo: "paranext-core", number: 3408, title: "PT-3408 Collapse extra spaces in Find queries", team: "Power", urgency: "blocking", ageMs: 2 * DAY, claimedByName: "Katherine" }),
  make({ repo: "paranext-core", number: 4325, title: "PT-4325 Registration Needed Dot", team: "Simple", urgency: "soon", ageMs: 1 * DAY, claimedByName: "Ira" }),
];

// Every request names a team, so the only way a row reaches Needs triage now is
// a team that was removed from config after the request was made. The cast is
// the point: "Retired" is not a `TeamName` any more.
const triage: PrRecord[] = [
  make({ repo: "paratext-10-studio", number: 177, title: "PT-4398 P10 backend sync-activity signal", team: "Retired" as TeamName, urgency: "blocking", ageMs: 3 * DAY }),
  make({ repo: "paranext-core", number: 2708, title: "PT-4412 Registration dot placement", team: "Retired" as TeamName, urgency: "soon", ageMs: 1 * DAY }),
  make({ owner: "eten-tech-foundation", repo: "scripture-editors", number: 341, title: "Fix marker parsing for \\fig", team: "Retired" as TeamName, urgency: "thisWeek", ageMs: 2 * DAY }),
  make({ repo: "paranext-core", number: 2701, title: "PT-4401 Sync activity indicator", team: "Power", urgency: "soon", ageMs: 6 * HOUR }),
];

const notSyncing: PrRecord[] = [
  make({ repo: "paranext-core", number: 2701, title: "PT-4401 Sync activity indicator", team: "Power", urgency: "soon", ageMs: 6 * HOUR, syncPaused: true }),
  make({ repo: "paranext-core", number: 2688, title: "PT-4370 Settings migration", team: "Power", urgency: "thisWeek", ageMs: 4 * DAY, lastClaimedByName: "Ira" }),
  resolveRecord(make({ repo: "paranext-core", number: 2690, title: "PT-4371 Marker cleanup", team: "Power", urgency: "soon", ageMs: 5 * DAY }), FIXTURE_NOW - 10 * MINUTE, "review by Katherine"),
  resolveRecord(make({ repo: "paratext-assistant", number: 88, title: "PT-4390 Assistant streaming errors", team: "Simple", urgency: "soon", ageMs: 2 * DAY }), FIXTURE_NOW - 25 * MINUTE, "cleared by Jolie"),
];

const atCapacity: PrRecord[] = Array.from({ length: 31 }, (_, i) =>
  make({
    repo: "paranext-core",
    number: 2600 + i,
    title: `PT-${4300 + i} A change with a realistically long descriptive title`,
    team: i % 2 === 0 ? "Power" : "Simple",
    urgency: i === 30 ? "blocking" : "thisWeek",
    ageMs: i === 30 ? 90 * MINUTE : (31 - i) * DAY,
    note: i === 30 ? "blocks the release branch cut" : null,
  }),
);

export const SCENARIOS: Scenario[] = [
  { key: "ordinary", label: "An ordinary day", tests: "team grouping · urgency within · 🔥 reason inline · claim age suppressed", records: ordinaryDay, lastSync: FIXTURE_NOW - 2 * MINUTE, now: FIXTURE_NOW },
  { key: "triage", label: "A team removed from config", tests: "Needs triage · rows whose team is gone", records: triage, lastSync: FIXTURE_NOW - 4 * MINUTE, now: FIXTURE_NOW },
  { key: "stale", label: "Not syncing, with recently cleared rows", tests: "the banner that could never fire · resolve accountability", records: notSyncing, lastSync: FIXTURE_NOW - 47 * MINUTE, now: FIXTURE_NOW },
  { key: "capacity", label: "At capacity", tests: "visible set equals actionable set · open count vs rendered count", records: atCapacity, lastSync: FIXTURE_NOW - MINUTE, now: FIXTURE_NOW, maxRows: 20 },
  { key: "empty", label: "Nothing waiting", tests: "no components at all", records: [], lastSync: FIXTURE_NOW - MINUTE, now: FIXTURE_NOW },
  { key: "never-synced", label: "Fresh deploy, never synced", tests: "a store with no lastSync admits it", records: [], lastSync: null, now: FIXTURE_NOW },
];
