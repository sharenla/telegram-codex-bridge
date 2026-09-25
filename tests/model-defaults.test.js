const assert = require("node:assert/strict");
const { test } = require("node:test");
const { _test } = require("../index");

test("session model migration updates every existing session once", () => {
  const store = {
    sessions: {
      one: { model: "gpt-6-astra", effort: "high" },
      two: { model: "gpt-5.6-sol", effort: "low" },
    },
  };

  assert.equal(_test.migrateSessionModelDefaults(store, {
    model: "gpt-6-sol",
    effort: "high",
  }), true);
  assert.deepEqual(store.sessions, {
    one: { model: "gpt-6-sol", effort: "high" },
    two: { model: "gpt-6-sol", effort: "high" },
  });
  assert.equal(store.sessionDefaultsMigrationVersion, "gpt-6-sol-high-2026-09-26");
  assert.equal(_test.migrateSessionModelDefaults(store, {
    model: "gpt-5.4",
    effort: "low",
  }), false);
  assert.equal(store.sessions.one.model, "gpt-6-sol");
});
