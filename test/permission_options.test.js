const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("permission option preserves the exact menu fingerprint internally", () => {
  const option = __test.liveApprovalOptionFromRow({
    optionId: "codex.permission:4ef1a32b",
    label: "Approve for me",
    index: 1,
    checked: true,
    disabled: false,
  });

  assert.deepEqual(option, {
    id: "codex.permission:4ef1a32b",
    key: "Approve for me",
    value: "Approve for me",
    label: "Approve for me",
    displayName: "Approve for me",
    available: true,
    current: true,
    menuIndex: 1,
    menuVerified: true,
  });
});

test("permission current state only accepts an exact cached row label", () => {
  const rows = [
    __test.liveApprovalOptionFromRow({ optionId: "codex.permission:ask", label: "Ask for approval", index: 0, checked: true }),
    __test.liveApprovalOptionFromRow({ optionId: "codex.permission:full", label: "Full access", index: 1, checked: false }),
  ];

  const selected = __test.withPermissionOptionCurrent(rows, { label: "Full access" });
  assert.deepEqual(selected.map((row) => row.current), [false, true]);

  const unknown = __test.withPermissionOptionCurrent(rows, { label: "Changed elsewhere" });
  assert.deepEqual(unknown.map((row) => row.current), [false, false]);
});

test("menu session rows retain native selected state without inferring it from labels", () => {
  const rows = __test.menuSessionRows([
    { optionId: "native-radio-a", label: "First native option", current: false },
    { optionId: "native-radio-b", label: "Second native option", current: true },
  ]);

  assert.deepEqual(rows.map((row) => row.current), [false, true]);
});

test("permission confirmation picks the single non-dismissive dialog action", () => {
  const surface = {
    surface_id: "desktop-surface:test",
    capability: "permission_confirmation",
    actions: [
      { action_id: "a-cancel", label: "取消", available: true },
      { action_id: "a-confirm", label: "确认", available: true },
    ],
  };

  const action = __test.confirmablePermissionAction(surface);
  assert.equal(action.action_id, "a-confirm");
});

test("permission confirmation accepts an English dialog", () => {
  const action = __test.confirmablePermissionAction({
    surface_id: "desktop-surface:test",
    actions: [
      { action_id: "a-cancel", label: "Cancel", available: true },
      { action_id: "a-confirm", label: "Confirm", available: true },
    ],
  });

  assert.equal(action.action_id, "a-confirm");
});

test("permission confirmation never guesses with ambiguous or missing actions", () => {
  assert.equal(__test.confirmablePermissionAction(null), null);
  assert.equal(__test.confirmablePermissionAction({ actions: [] }), null);
  assert.equal(__test.confirmablePermissionAction({
    actions: [{ action_id: "a-cancel", label: "取消", available: true }],
  }), null);
  assert.equal(__test.confirmablePermissionAction({
    actions: [
      { action_id: "a-cancel", label: "取消", available: true },
      { action_id: "a-disabled", label: "确认", available: false },
    ],
  }), null);
  assert.equal(__test.confirmablePermissionAction({
    actions: [
      { action_id: "a-cancel", label: "取消", available: true },
      { action_id: "a-one", label: "仅此文件夹", available: true },
      { action_id: "a-two", label: "始终允许", available: true },
    ],
  }), null);
});
