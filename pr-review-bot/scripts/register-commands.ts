/**
 * Registers guild-scoped commands, so they exist only in this server and updates
 * take effect immediately. Run with the app id, guild id and bot token in env.
 *
 * The npm script compiles with the repo's own `tsc` and runs the emitted JS,
 * the same way `npm run preview` does. Earlier revisions of this comment said
 * `npx tsx`, which the repo has no dependency on — and adding one for a script
 * this small is not worth a dependency the lockfile has to carry.
 */
const REVIEW_LIST = {
  name: "review-list",
  description: "Show what is waiting for review, privately",
  type: 1,
};

const REVIEW_STATS = {
  name: "review-stats",
  description: "Show anonymous team review stats, privately",
  type: 1,
};

const REVIEW_REQUEST = {
  name: "review-request",
  description: "Ask for a review on a pull request",
  type: 1,
};

const appId = process.env["DISCORD_APP_ID"];
const guildId = process.env["DISCORD_GUILD_ID"];
const token = process.env["DISCORD_BOT_TOKEN"];
if (appId === undefined || guildId === undefined || token === undefined) {
  console.error("Set DISCORD_APP_ID, DISCORD_GUILD_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}

const commands = [REVIEW_LIST, REVIEW_STATS, REVIEW_REQUEST];

const response = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

if (!response.ok) {
  console.error(`Registration failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered: ${commands.map((c) => `/${c.name}`).join(", ")}`);

export {};
