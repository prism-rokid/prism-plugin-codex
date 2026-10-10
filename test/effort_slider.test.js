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

function nativeSliderFacts({ selectedID, announcement = '' }) {
  const vm = require('node:vm');
  const selections = [
    { id: 'model:low', model: 'model', modelLabel: 'Model', reasoningEffort: 'low' },
    { id: 'model:high', model: 'model', modelLabel: 'Model', reasoningEffort: 'high' },
    { id: 'model:ultra', model: 'model', modelLabel: 'Model', reasoningEffort: 'ultra', isLocked: true },
  ];
  const row = {
    getBoundingClientRect: () => ({ width: 200, height: 40 }),
    focus() {},
    __reactFiber$test: { memoizedProps: {
      powerSelections: selections,
      selectedPowerSelection: { id: selectedID },
    } },
  };
  return vm.runInNewContext(__test.reasoningSliderFactsExpression(), {
    document: { querySelectorAll(selector) {
      if (selector === '[data-reasoning-slider="true"]') return [row];
      if (selector === '[role="status"]') return [{ textContent: announcement }];
      return [];
    } },
  });
}

test('native effort selection works without localized announcements', () => {
  const facts = nativeSliderFacts({ selectedID: 'model:high' });
  assert.equal(facts.index, 1);
  assert.equal(facts.total, 3);
  const rows = reasoningEffortRowsFromFacts(facts);
  assert.equal(rows[1].checked, true);
  assert.equal(rows[2].label, 'ultra');
  assert.equal(rows[2].disabled, true);
});

test('native effort identity overrides stale or differently localized live regions', () => {
  for (const announcement of ['Model Low, item 1 of 3', 'Model 轻度，第 1 项，共 3 项']) {
    const facts = nativeSliderFacts({ selectedID: 'model:high', announcement });
    assert.equal(facts.index, 1);
    assert.equal(facts.total, 3);
  }
});

test('unknown native effort identity does not invent a current selection', () => {
  const facts = nativeSliderFacts({ selectedID: 'removed:high', announcement: 'Model 轻度，第 1 项，共 3 项' });
  assert.equal(facts.index, -1);
  assert.deepEqual(reasoningEffortRowsFromFacts(facts), []);
});
