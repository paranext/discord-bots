import { mkdir, writeFile } from "node:fs/promises";
import { cwd } from "node:process";
import { pathToFileURL } from "node:url";
import { config } from "../config/config.js";
import { FIXTURE_NOW, SCENARIOS } from "../fixtures/records.js";
import { renderDigest } from "../src/core/render/digest.js";
import { buildHtml, type RenderedScenario } from "./template.js";

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

await mkdir(OUT, { recursive: true });
await writeFile(new URL("index.html", OUT), buildHtml(rendered, FIXTURE_NOW), "utf8");

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
console.log("\nwrote preview/out/index.html and preview/out/embeds.json");
