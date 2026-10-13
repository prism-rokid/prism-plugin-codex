const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const { __test } = require("../codex_cdp.js");

test("conversation header menu entry IDs distinguish rows sharing one React handler", () => {
  const handler = "function onSelect(){ dispatch(action) }";
  const first = __test.conversationHeaderEntryOptionID(handler, { reactKey: "archive" });
  const second = __test.conversationHeaderEntryOptionID(handler, { reactKey: "delete" });

  assert.notEqual(first, second);
  assert.equal(first, __test.conversationHeaderEntryOptionID(handler, { reactKey: "archive" }));
  assert.notEqual(
    first,
    __test.conversationHeaderEntryOptionID(handler, { testID: "different-action" }),
  );
  assert.notEqual(
    __test.conversationHeaderEntryOptionID(handler, { reactKey: "rename-thread" }),
    __test.conversationHeaderEntryOptionID(handler, { reactKey: "pin-thread" }),
  );
});

test("conversation header menu sessions reject changed stable identities before applying an entry", () => {
  const expected = [{ optionId: "conversation.header:1", label: "Archive", disabled: false }];

  assert.equal(__test.sameConversationHeaderMenuRows(expected, expected), true);
  assert.equal(
    __test.sameConversationHeaderMenuRows(
      [{ ...expected[0], optionId: "conversation.header:2" }],
      expected,
    ),
    false,
  );
});

test("conversation header describe and apply share the snapshot-bound entry identity", () => {
  const source = __test.conversationHeaderMenuRowsExpression();
  const implementation = fs.readFileSync(require.resolve("../codex_cdp.js"), "utf8");

  assert.match(source, /prismHeaderEntryOptionID\(source, stableTarget\)/);
  assert.match(source, /prismHeaderStableTarget/);
  assert.match(source, /depth < 32/);
  assert.match(source, /aria-keyshortcuts/);
  assert.match(source, /rename-thread.*pin-thread.*archive-thread/);
  assert.match(source, /prismHeaderRemoteSafe\(stableTarget\)/);
  assert.match(source, /aria-haspopup/);
  assert.match(implementation, /prismHeaderEntryOptionID\(source, stableTarget\) ===/);
  assert.doesNotMatch(source, /row\.label|saved\.label|index/);
});
