export interface RenderedScenario {
  key: string;
  label: string;
  tests: string;
  embeds: { color: number; description: string }[];
  components: unknown[];
  openCount: number;
  renderedCount: number;
  droppedCount: number;
}

/** Minimal Discord-dark markdown renderer: enough for links, bold, underline and
 *  italics, plus resolved relative timestamps so the page reads like the client. */
function discordMarkdown(text: string, now: number): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/&lt;t:(\d+):R&gt;/g, (_m, seconds: string) => {
      const deltaMs = Number(seconds) * 1000 - now;
      return `<span class="ts">${relativeWords(deltaMs)}</span>`;
    })
    .replace(/&lt;#([\w-]+)&gt;/g, '<span class="mention">#$1</span>')
    .replace(/&lt;@([\w-]+)&gt;/g, '<span class="mention">@$1</span>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a class="lnk" href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, '<span class="sec">$1</span>')
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function relativeWords(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return deltaMs < 0 ? `${n} ${name}${n === 1 ? "" : "s"} ago` : `in ${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return deltaMs < 0 ? "just now" : "in a moment";
}

function renderComponents(components: unknown[]): string {
  if (components.length === 0) {
    return '<p class="none">no components — deliberate: an empty String Select is a 400</p>';
  }
  const selects = components.flatMap((row) => {
    const inner = (row as { components?: { placeholder?: string; options?: unknown[] }[] }).components ?? [];
    return inner.map(
      (c) =>
        `<div class="select"><span>${c.placeholder ?? "Select"}</span><span class="caret">▾</span>` +
        `<span class="count">${(c.options ?? []).length} options</span></div>`,
    );
  });
  return `<div class="components">${selects.join("")}</div>`;
}

export function buildHtml(scenarios: RenderedScenario[], now: number): string {
  const cards = scenarios
    .map(
      (s) => `
<section class="specimen">
  <header>
    <h2>${s.label}</h2>
    <p class="tests">${s.tests}</p>
    <p class="counts">${s.openCount} open · ${s.renderedCount} rendered · ${s.droppedCount} dropped · ${s.embeds.length} embed(s)</p>
  </header>
  <div class="stage">
    <div class="dc">
      ${s.embeds
        .map(
          (e) =>
            `<div class="embed" style="border-left-color:#${e.color.toString(16).padStart(6, "0")}">` +
            `<div class="body">${discordMarkdown(e.description, now).replace(/\n/g, "<br>")}</div></div>`,
        )
        .join("")}
      ${renderComponents(s.components)}
    </div>
  </div>
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Needs Review — render proof</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0f0f13; color:#e6e6ec;
         font:15px/1.6 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:900px; margin:0 auto; padding:48px 24px 96px; }
  h1 { font-size:1.8rem; margin:0 0 6px; }
  .lede { color:#9a9aa8; margin:0 0 40px; }
  .specimen { margin-bottom:44px; }
  .specimen header { border-bottom:1px solid #2a2a34; padding-bottom:10px; margin-bottom:16px; }
  .specimen h2 { font-size:1.05rem; margin:0; }
  .tests { color:#8d8d9b; font-style:italic; margin:4px 0 0; font-size:0.9rem; }
  .counts { color:#6f6f7d; margin:4px 0 0; font-size:0.82rem;
            font-family:ui-monospace,Menlo,monospace; }
  .stage { background:#1a1a20; border:1px solid #24242c; border-radius:6px; padding:20px; overflow-x:auto; }
  .dc { background:#313338; border-radius:7px; padding:16px; font-size:15px;
        font-family:"Noto Sans",system-ui,sans-serif; color:#dbdee1; min-width:420px; }
  .embed { background:#2b2d31; border-left:4px solid #5865f2; border-radius:4px;
           padding:14px 16px; margin-bottom:10px; max-width:520px; }
  .sec { font-weight:600; text-decoration:underline; color:#f2f3f5; }
  .lnk { color:#00a8fc; text-decoration:none; }
  .mention { background:rgba(88,101,242,.24); color:#c9cdfb; border-radius:3px; padding:0 2px; }
  .ts { background:rgba(78,93,148,.36); border-radius:3px; padding:0 2px; }
  code { background:#1e1f22; border-radius:3px; padding:0 4px; font-size:0.86em; }
  .components { display:flex; flex-wrap:wrap; gap:8px; }
  .select { background:#1e1f22; border:1px solid #26272b; border-radius:4px;
            padding:8px 11px; color:#949ba4; display:flex; gap:10px; align-items:center; }
  .count { color:#5d5d6b; font-size:0.78rem; }
  .none { color:#7a7a88; font-style:italic; margin:0; font-size:0.9rem; }
  strong { color:#f2f3f5; }
</style></head>
<body><main>
<h1>Needs Review — render proof</h1>
<p class="lede">Rendered by <code>src/core/render/digest.ts</code> from
<code>fixtures/records.ts</code>. No credentials, no network. Timestamps are resolved
the way Discord would resolve them, from a fixed fixture clock.</p>
${cards}
</main></body></html>`;
}
