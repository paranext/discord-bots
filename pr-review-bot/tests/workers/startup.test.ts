import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRest, FLAG_MESSAGE_CONTENT, FLAG_MESSAGE_CONTENT_LIMITED } from "../../src/discord/rest.js";
import { assertMessageContentIntent } from "../../src/handlers/startup.js";

function stubApplication(body: unknown, status = 200) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.unstubAllGlobals());

describe("assertMessageContentIntent", () => {
  it("passes with the full intent flag", async () => {
    stubApplication({ id: "app", flags: FLAG_MESSAGE_CONTENT });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: false });
  });

  it("passes with the limited intent flag and says so", async () => {
    stubApplication({ id: "app", flags: FLAG_MESSAGE_CONTENT_LIMITED });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: true });
  });

  it("FAILS with INTENT_MISSING when neither flag is present", async () => {
    // The failure this exists to prevent: a full sprint of shadow mode on an
    // empty list, indistinguishable from "nobody posted any PRs".
    stubApplication({ id: "app", flags: 0 });
    const result = await assertMessageContentIntent(new DiscordRest("tok"));
    expect(result).toMatchObject({ ok: false, code: "INTENT_MISSING" });
    expect((result as { detail: string }).detail).toContain("Developer Portal");
  });

  it("ignores unrelated flags", async () => {
    stubApplication({ id: "app", flags: 1 << 12 });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toMatchObject({ code: "INTENT_MISSING" });
  });

  it("passes against the raw documented bit value, not just the constant ANDed with itself", async () => {
    // `{ flags: FLAG_MESSAGE_CONTENT }` above ANDs the constant against itself —
    // (x & x) !== 0 holds for ANY non-zero x, so that fixture passes even for the
    // wrong bit position (as shipped once in Task 13 — see rest.test.ts). A raw
    // literal is the only fixture that can catch the constant itself being wrong.
    stubApplication({ id: "app", flags: 262144 });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: false });
  });

  it("passes against the raw documented limited-flag bit value", async () => {
    stubApplication({ id: "app", flags: 524288 });
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toEqual({ ok: true, limited: true });
  });

  it("reports UNREACHABLE rather than INTENT_MISSING when the call fails", async () => {
    stubApplication({}, 500);
    expect(await assertMessageContentIntent(new DiscordRest("tok"))).toMatchObject({ ok: false, code: "UNREACHABLE" });
  });
});
