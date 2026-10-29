import { mkdir, writeFile } from "node:fs/promises";
import { cwd } from "node:process";
import { pathToFileURL } from "node:url";
import { config } from "../config/config.js";
import { FIXTURE_NOW, SCENARIOS } from "../fixtures/records.js";
import { renderDigest } from "../src/core/render/digest.js";
import { buildRequestModal } from "../src/handlers/modal.js";
import { renderRejection } from "../src/core/render/rejection.js";
import type { SubmitRejection, SubmittedValues } from "../src/core/submit.js";
import { buildHtml, type ModalSpecimen, type RejectionSpecimen, type RenderedScenario } from "./template.js";

// Resolved against the invoking process's working directory, not import.meta.url:
// this script is run from its *emitted* .js location (see package.json's `preview`
// script, which compiles preview/build.ts with tsc before running plain node), so
// import.meta.url would point at a build-output directory rather than the repo,
// and "preview/out" would silently land somewhere nobody looks for it.
const OUT = new URL("preview/out/", pathToFileURL(`${cwd()}/`));

const rendered: RenderedScenario[] = SCENARIOS.map((scenario) => {
  const result = renderDigest({ ...scenario, config });
  return {
    key: scenario.key,
    label: scenario.label,
    tests: scenario.tests,
    embeds: result.embeds,
    components: result.components,
    openCount: result.openCount,
    renderedCount: result.renderedCount,
    droppedCount: result.droppedCount,
  };
});

// The two states the modal is built in: a fresh request, and a "Fix and retry"
// prefill.
const PREFILL: SubmittedValues = {
  url: "https://github.com/paranext/paranext-core/pull/2701",
  team: "Power",
  urgency: "blocking",
  note: "needs a P10 build before Thursday's demo",
};

const modals: ModalSpecimen[] = [
  {
    key: "modal-fresh",
    label: "Modal — fresh",
    description: "A new request: nothing prefilled.",
    response: buildRequestModal(config),
  },
  {
    key: "modal-prefill",
    label: "Modal — prefilled retry",
    description: "\"Fix and retry\": every field carries back exactly what the requester typed, unmodified.",
    response: buildRequestModal(config, PREFILL),
  },
];

// Every `SubmitRejection` variant, rendered with a representative echo of what
// the requester typed. `stashKey` is non-null everywhere except where the
// handler has nothing to stash a retry against.
const REJECTION_VALUES: SubmittedValues = {
  url: "https://github.com/paranext/paranext-core/pull/9999",
  team: "Power",
  urgency: "blocking",
  note: "needs a P10 build before Thursday's demo",
};

const REJECTIONS: { key: string; label: string; rejection: SubmitRejection; stashKey: string | null }[] = [
  { key: "reject-not-a-pr", label: "Rejection — not-a-pr", rejection: { reason: "not-a-pr", detail: "not-a-url" }, stashKey: "stash-1" },
  { key: "reject-url-too-long", label: "Rejection — url-too-long", rejection: { reason: "url-too-long" }, stashKey: "stash-1a" },
  { key: "reject-not-allowlisted", label: "Rejection — not-allowlisted", rejection: { reason: "not-allowlisted", slug: "paranext/some-other-repo" }, stashKey: "stash-2" },
  { key: "reject-invalid-team", label: "Rejection — invalid-team", rejection: { reason: "invalid-team" }, stashKey: "stash-2a" },
  { key: "reject-invalid-urgency", label: "Rejection — invalid-urgency", rejection: { reason: "invalid-urgency" }, stashKey: "stash-2b" },
  { key: "reject-note-required", label: "Rejection — note-required", rejection: { reason: "note-required" }, stashKey: "stash-3" },
  { key: "reject-merged", label: "Rejection — merged", rejection: { reason: "merged" }, stashKey: "stash-4" },
  { key: "reject-closed", label: "Rejection — closed", rejection: { reason: "closed" }, stashKey: "stash-5" },
  { key: "reject-not-found", label: "Rejection — not-found", rejection: { reason: "not-found", slug: "paranext/paranext-core/9999" }, stashKey: "stash-6" },
  { key: "reject-credential", label: "Rejection — credential", rejection: { reason: "credential", slug: "paranext/paranext-core" }, stashKey: null },
];

// Compile-time proof that the list above is what its comment claims. The prose
// said "every variant" while two were missing, and both were also the two the
// tests did not reach — so the claim is asserted by the typechecker now, and a
// new `SubmitRejection` variant fails the build until it is rendered here.
type UnrenderedRejection = Exclude<
  SubmitRejection["reason"],
  (typeof REJECTIONS)[number]["rejection"]["reason"]
>;
const everyRejectionRendered: [UnrenderedRejection] extends [never] ? true : false = true;
void everyRejectionRendered;

const rejections: RejectionSpecimen[] = REJECTIONS.map((r) => {
  const result = renderRejection({
    rejection: r.rejection,
    values: REJECTION_VALUES,
    stashKey: r.stashKey,
    config,
  });
  return { key: r.key, label: r.label, content: result.content, components: result.components };
});

await mkdir(OUT, { recursive: true });
await writeFile(new URL("index.html", OUT), buildHtml(rendered, FIXTURE_NOW, modals, rejections), "utf8");

// Tier 2: the raw payload, for pasting into a renderer that applies Discord's own
// rules. This is what catches wrapping and character budget errors a CSS mock hides.
await writeFile(
  new URL("embeds.json", OUT),
  JSON.stringify(
    Object.fromEntries(rendered.map((r) => [r.key, { embeds: r.embeds, components: r.components }])),
    null,
    2,
  ),
  "utf8",
);

for (const r of rendered) {
  const chars = r.embeds.reduce((sum, e) => sum + e.description.length, 0);
  console.log(`${r.key.padEnd(14)} ${String(r.openCount).padStart(3)} open  ${String(r.renderedCount).padStart(3)} rendered  ${String(chars).padStart(5)} chars`);
}
console.log(`\n${modals.length} modal state(s), ${rejections.length} rejection variant(s) rendered.`);
console.log("wrote preview/out/index.html and preview/out/embeds.json");
