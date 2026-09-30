const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../codex_cdp.js");

const { reasoningEffortRowsFromFacts, EFFORT_CONTROL_ID } = __test;

test("effort rows enumerate every announced level and mark the current one", () => {
  const rows = reasoningEffortRowsFromFacts({ index: 1, total: 4, label: "标准" });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], {
    index: 1,
    optionId: `${EFFORT_CONTROL_ID}:1`,
    label: "标准",
    checked: true,
    disabled: false,
  });
  assert.deepEqual(rows[0], {
    index: 0,
    optionId: `${EFFORT_CONTROL_ID}:0`,
    label: "档位 1",
    checked: false,
    disabled: false,
  });
  assert.ok(rows.every((row) => row.optionId.startsWith(`${EFFORT_CONTROL_ID}:`)));
  assert.equal(rows.filter((row) => row.checked).length, 1);
});

test("effort rows fall back to an ordinal label when the current name is absent", () => {
  const rows = reasoningEffortRowsFromFacts({ index: 0, total: 2, label: "" });
  assert.deepEqual(rows.map((row) => row.label), ["档位 1", "档位 2"]);
});

test("effort rows reject unreadable slider facts", () => {
  assert.deepEqual(reasoningEffortRowsFromFacts(null), []);
  assert.deepEqual(reasoningEffortRowsFromFacts({ index: -1, total: 4, label: "标准" }), []);
  assert.deepEqual(reasoningEffortRowsFromFacts({ index: 4, total: 4, label: "标准" }), []);
  assert.deepEqual(reasoningEffortRowsFromFacts({ index: 0, total: 0, label: "标准" }), []);
});

test("slider facts expression reads the live-region announcement shape", () => {
  const source = __test.reasoningSliderFactsExpression();
  assert.match(source, /data-reasoning-slider/);
  assert.match(source, /role="status"/);
  assert.match(source, /data-selected-reasoning-effort/);
  assert.match(source, /第\\s\*\\d\+\\s\*项/);
});
