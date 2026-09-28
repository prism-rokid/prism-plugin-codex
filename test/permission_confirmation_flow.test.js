const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

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

test("permission menu apply confirms only one explicit, available consent action", async () => {
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

test("permission menu apply leaves non-consent and ambiguous dialogs untouched", async () => {
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

test("non-permission surfaces are never auto-confirmed by menu apply", async () => {
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
