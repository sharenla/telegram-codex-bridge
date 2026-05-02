const test = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../index.js");

test("extension mention parser extracts stable dollar slugs", () => {
  assert.deepEqual(
    _test.extractExtensionMentionSlugs("$google-drive summarize this, then $github:yeet"),
    ["google-drive", "github-yeet"],
  );
  assert.deepEqual(
    _test.extractExtensionMentionSlugs("Cost is $12, but use $browser-use please."),
    ["browser-use"],
  );
});

test("extension mention items resolve apps, skills, and plugins from inventories", () => {
  const items = _test.buildExtensionMentionInputItems(
    "$google-drive $skill-creator $review-tools please",
    {
      appsResult: {
        data: [
          { id: "google-drive", name: "Google Drive", isEnabled: true },
        ],
      },
      skillsResult: {
        data: [
          {
            cwd: "/repo",
            skills: [
              {
                name: "skill-creator",
                path: "/Users/wukong/.codex/skills/.system/skill-creator/SKILL.md",
                enabled: true,
              },
            ],
          },
        ],
      },
      pluginsResult: {
        data: [
          {
            name: "review-tools",
            marketplaceName: "local",
            enabled: true,
          },
        ],
      },
    },
  );

  assert.deepEqual(items, [
    { type: "mention", name: "Google Drive", path: "app://google-drive" },
    {
      type: "skill",
      name: "skill-creator",
      path: "/Users/wukong/.codex/skills/.system/skill-creator/SKILL.md",
    },
    { type: "mention", name: "review-tools", path: "plugin://review-tools@local" },
  ]);
});

test("extension inventory formatters degrade cleanly on unsupported app-server methods", () => {
  assert.match(
    _test.formatPluginsListText(null, { error: "Method not found" }),
    /Plugins unavailable: Method not found/,
  );
  assert.match(
    _test.formatMcpListText({ data: [{ name: "github", status: "ready", tools: [{ name: "search" }] }] }),
    /github \[ready\] - 1 tools/,
  );
});
