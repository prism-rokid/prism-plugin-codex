const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const Database = require("better-sqlite3");

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

function loadPermissionFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-permission-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome);

  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT, preview TEXT,
      cwd TEXT, rollout_path TEXT, tokens_used INTEGER, model_provider TEXT,
      model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT,
      memory_mode TEXT, agent_nickname TEXT, thread_source TEXT,
      updated_at_ms INTEGER, created_at_ms INTEGER, recency_at_ms INTEGER,
      archived INTEGER, attached_thread_parent_id TEXT
    )`);
    db.prepare("INSERT INTO threads (id, title, thread_source, archived) VALUES (?, ?, 'user', 0)")
      .run(THREAD_ID, "Permission fixture");
  } finally {
    db.close();
  }

  const filename = require.resolve("../index.js");
  const load = createRequire(filename);
  const scopedRequire = (name) => {
    if (name === "os") return { ...os, homedir: () => home };
    if (name === "./codex_cdp") {
      return {
        createCodexDesktopController: () => assert.fail("unexpected CDP connection"),
      };
    }
    return load(name);
  };
  const mod = { exports: {} };
  vm.compileFunction(fs.readFileSync(filename, "utf8"), ["require", "module", "process"], { filename })(
    scopedRequire, mod, { platform: process.platform, env: { PRISM_CODEX_HOME: codexHome } },
  );
  return mod.exports.__test;
}

function permissionController(surface, overrides = {}) {
  const calls = [];
  return {
    calls,
    selectThread: async () => ({ selected: true }),
    isThreadSelected: async () => true,
    withTransparentNativeMenus: async (operation) => operation(),
    applyInteractiveComposerMenuSession: async () => ({ surface }),
    applyInteractiveSurface: async (...args) => { calls.push(args); },
    closedComposerControls: async () => null,
    ...overrides,
  };
}

test("permission menu apply confirms only one explicit, available consent action", async (t) => {
  const __test = loadPermissionFixture(t);
  const surface = {
    surface_id: "desktop-surface:permission-confirmation",
    capability: "permission_confirmation",
    actions: [
      { action_id: "learn-more", label: "Learn more", available: true },
      { action_id: "cancel", label: "Cancel", available: true },
      { action_id: "confirm", label: "Confirm", available: true },
    ],
  };
  const controller = permissionController(surface);
  const menu = __test.createPluginMenuSession(
    THREAD_ID,
    { kind: "interactive_control", control_id: "codex.permission" },
    [{ optionId: "permission-full", label: "Full access", current: false }],
  );

  const result = await __test.applyCodexMenuSession(THREAD_ID, {
    menu_session_id: menu.menu_session_id,
    entry_id: menu.entries[0].entry_id,
  }, { controller });

  assert.deepEqual(controller.calls, [[surface.surface_id, "confirm", ""]]);
  assert.equal(result.details.permission_auto_confirmed, true);
  assert.equal(result.details.interactive_surface, undefined);
});

test("permission menu apply leaves non-consent and ambiguous dialogs untouched", async (t) => {
  const __test = loadPermissionFixture(t);
  for (const actions of [
    [{ action_id: "settings", label: "Open Settings", available: true }],
    [
      { action_id: "allow", label: "Allow", available: true },
      { action_id: "continue", label: "Continue", available: true },
    ],
  ]) {
    const surface = {
      surface_id: "desktop-surface:permission-confirmation",
      capability: "permission_confirmation",
      actions,
    };
    const controller = permissionController(surface);
    const menu = __test.createPluginMenuSession(
      THREAD_ID,
      { kind: "interactive_control", control_id: "codex.permission" },
      [{ optionId: "permission-full", label: "Full access", current: false }],
    );

    const result = await __test.applyCodexMenuSession(THREAD_ID, {
      menu_session_id: menu.menu_session_id,
      entry_id: menu.entries[0].entry_id,
    }, { controller });

    assert.deepEqual(controller.calls, []);
    assert.equal(result.details.permission_auto_confirmed, undefined);
    assert.equal(result.details.interactive_surface.capability, "permission_confirmation");
  }
});

test("non-permission surfaces are never auto-confirmed by menu apply", async (t) => {
  const __test = loadPermissionFixture(t);
  const surface = {
    surface_id: "desktop-surface:unrelated",
    capability: "permission_confirmation",
    actions: [{ action_id: "confirm", label: "Confirm", available: true }],
  };
  const controller = permissionController(surface);
  const menu = __test.createPluginMenuSession(
    THREAD_ID,
    { kind: "interactive_control", control_id: "codex.intelligence" },
    [{ optionId: "reasoning-high", label: "High", current: false }],
  );

  const result = await __test.applyCodexMenuSession(THREAD_ID, {
    menu_session_id: menu.menu_session_id,
    entry_id: menu.entries[0].entry_id,
  }, { controller });

  assert.deepEqual(controller.calls, []);
  assert.equal(result.details.interactive_surface, undefined);
});
