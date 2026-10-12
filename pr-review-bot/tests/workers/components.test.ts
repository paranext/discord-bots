import { describe, expect, it } from "vitest";
import { EPHEMERAL_FLAG, ephemeral, ephemeralEmbeds, SUPPRESS_EMBEDS_FLAG } from "../../src/discord/components.js";

describe("message flags", () => {
  // Pinned to Discord's documented value the same way `rest.test.ts` pins the
  // application flags, and for the same reason: every assertion that a message
  // suppresses its unfurl is written against this constant, so a wrong bit here
  // would make all of them agree with each other and with nothing else.
  it("pins SUPPRESS_EMBEDS to its documented bit", () => {
    expect(SUPPRESS_EMBEDS_FLAG).toBe(4);
  });

  // No `ephemeral()` string builds a URL of its own, but several interpolate a
  // PR title straight from GitHub — and a title like "Revert
  // https://github.com/o/r/pull/9" unfurls in the reply.
  it("suppresses unfurls on a plain-content ephemeral — titles come from GitHub verbatim", () => {
    const response = ephemeral("Cleared **Revert https://github.com/o/r/pull/9** from the list.");
    expect(response.data?.flags).toBe(EPHEMERAL_FLAG | SUPPRESS_EMBEDS_FLAG);
  });

  // The mirror of the digest guard: this reply IS embeds, so the same flag that
  // fixes the one above would blank this one.
  it("never suppresses embeds on an ephemeral that carries embeds", () => {
    const response = ephemeralEmbeds([{ color: 1, description: "x" }]);
    expect(response.data?.flags).toBe(EPHEMERAL_FLAG);
  });
});
