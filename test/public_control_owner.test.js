const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../index.js");

test("combined intelligence is the only public model/reasoning control owner", () => {
  assert.equal(__test.isPublicInteractiveControlID("codex.intelligence"), true);
  assert.equal(__test.isPublicInteractiveControlID("codex.permission"), true);
  assert.equal(__test.isPublicInteractiveControlID("codex.intelligence.effort"), false);
  assert.equal(__test.isPublicInteractiveControlID("reasoning.switch"), false);
  assert.equal(__test.isPublicInteractiveControlID(""), false);
});

test("effort route stays in the server menu session and out of the mobile response", () => {
  const session = __test.createPluginMenuSession(
    "11111111-1111-4111-8111-111111111111",
    { kind: "interactive_control", control_id: "codex.intelligence" },
    [],
    "",
    [{
      control_id: "codex.intelligence.effort",
      label: "Reasoning",
      rows: [{ optionId: "codex.intelligence.effort:2", label: "High" }],
    }],
  );

  assert.equal(session.groups.length, 1);
  assert.deepEqual(Object.keys(session.groups[0]).sort(), ["entries", "group_id", "label"]);
  assert.equal("control_id" in session.groups[0], false);
  assert.doesNotMatch(JSON.stringify(session), /codex\.intelligence\.effort/);
});
