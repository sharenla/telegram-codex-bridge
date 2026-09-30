const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _test } = require("../index.js");

test("desktop feature subtables cannot invalidate the bridge provider after repeated sync", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-config-compat-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, "desktop");
  const bridge = path.join(root, "bridge");
  fs.mkdirSync(desktop);
  fs.mkdirSync(bridge);
  const config = 'model = "gpt-6.1-sol"\n[features]\nmemories = true\n'
    + '[features.context_management]\nexperimental_mode = true\n'
    + '[desktop]\nselected-avatar-id = "app-default"\n';
  fs.writeFileSync(path.join(desktop, "config.toml"), config);
  fs.writeFileSync(path.join(bridge, "auth.json"), '{"fixture":true}\n');
  for (const rewritten of [config, config.replace("experimental_mode = true", "experimental_mode = false")]) {
    fs.writeFileSync(path.join(desktop, "config.toml"), rewritten);
    _test.syncDesktopCodexContext({ codexHome: bridge, desktopCodexHome: desktop });
    _test.configureCodexLbProvider({ codexHome: bridge, enabled: true, envKey: "CODEX_LB_API_KEY" });
    const synced = fs.readFileSync(path.join(bridge, "config.toml"), "utf8");
    assert.doesNotMatch(synced, /context_management|experimental_mode/);
    assert.match(synced, /memories = true/);
    assert.match(synced, /model_provider = "codex-lb"/);
    assert.match(synced, /env_key = "CODEX_LB_API_KEY"/);
    assert.match(synced, /supports_websockets = false/);
    assert.match(synced, /\[desktop\]\nselected-avatar-id/);
    assert.equal(fs.readFileSync(path.join(desktop, "config.toml"), "utf8"), rewritten);
    assert.equal(fs.readFileSync(path.join(bridge, "auth.json"), "utf8"), '{"fixture":true}\n');
  }
});

test("quoted feature subtables and arrays are dropped through the next unrelated table", () => {
  const result = _test.filterDesktopCodexConfigToml([
    '["features".context_management] # desktop-only',
    'experimental_mode = true',
    "[[features.context_management.rules]]",
    'mode = "experimental"',
    '[features]',
    'memories = false # CLI boolean',
    '[model_providers.custom]',
    'supports_websockets = true',
  ].join("\n"));
  assert.doesNotMatch(result, /context_management|experimental_mode|mode =/);
  assert.match(result, /memories = false # CLI boolean/);
  assert.match(result, /\[model_providers.custom\]\nsupports_websockets = true/);
});

test("nonboolean and dotted desktop features are removed without losing CLI booleans", () => {
  const result = _test.filterDesktopCodexConfigToml([
    'features.context_management.experimental_mode = true',
    'features.memories = true',
    '[features]',
    'context_management = { experimental_mode = true }',
    'context_management.experimental_mode = false',
    'desktop_modes = [',
    '  "experimental",',
    ']',
    'memories = false',
    '[desktop]',
    'enabled = true',
  ].join("\n"));
  assert.doesNotMatch(result, /context_management|desktop_modes|experimental/);
  assert.doesNotMatch(result, /features\.memories = true/);
  assert.match(result, /memories = false/);
  assert.match(result, /\[desktop\]\nenabled = true/);
});
