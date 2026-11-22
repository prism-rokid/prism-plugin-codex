"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { expression } = require("../surface.cjs");

function fixture({
  useNativeComposer = false,
  hasTranscript = true,
  sidebarID = "dot-1",
  portraitID,
  siblingComposer = false,
  composerInOtherPane = false,
  textarea = false,
} = {}) {
  let clicked = 0;
  let selected = false;
  const insertions = [];
  const node = (props = {}) => ({
    checkVisibility: () => true,
    closest: () => null,
    getClientRects: () => [{ width: 10, height: 10 }],
    getBoundingClientRect: () => ({ top: 0, bottom: 10 }),
    getAttribute: () => null,
    hasAttribute: () => false,
    querySelectorAll: () => [],
    querySelector: () => null,
    ...props,
  });
  const button = node({ getAttribute: (name) => name === "aria-label" ? "Send" : null, click: () => { clicked += 1; } });
  const editor = node({ innerText: "", ...(textarea && { value: "" }), contains: () => false, select: () => { selected = true; }, focus: () => { document.activeElement = editor; } });
  const transcript = node({ children: [] });
  const owner = { memoizedProps: { roomId: "room-1", room: { id: "room-1", aeon_id: "dot-1" }, thread: { loaded: true, cursors: {} } } };
  const composer = node({
    closest(selector) {
      if (selector === ".messaging-root") return siblingComposer ? null : room;
      if (selector === "main.thread-pane") return composerInOtherPane ? otherPane : pane;
      return null;
    },
    querySelectorAll: (selector) => selector === "button" ? [button] :
      selector.includes("[contenteditable=") ? [editor] : [],
    ...(useNativeComposer && { __reactFiber$fixture: owner }),
  });
  const composerSelector = useNativeComposer ? '[data-role="composer"]' : "[data-codex-composer-root]";
  const otherPane = node();
  const pane = node({
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((part) => part.trim());
      return siblingComposer && selectors.includes(`.conversation-footer ${composerSelector}`) ? [composer] : [];
    },
  });
  const room = node({
    closest: (selector) => selector === "main.thread-pane" ? pane : null,
    querySelectorAll(selector) {
      if (selector === ".message-list") return hasTranscript ? [transcript] : [];
      return !siblingComposer && selector === composerSelector ? [composer] : [];
    },
  });
  const scroller = node({
    closest: (selector) => selector === ".messaging-root" ? room : null,
    querySelectorAll: () => hasTranscript ? [transcript] : [],
    __reactFiber$fixture: owner,
  });
  const side = node({ textContent: "Fixture Dot", getAttribute: () => `builtin:orbit:${sidebarID}` });
  const portrait = node({ getAttribute: () => portraitID });
  const document = {
    activeElement: null,
    getSelection: () => ({ removeAllRanges() {}, addRange() { selected = true; } }),
    createRange: () => ({ selectNodeContents(element) { assert.equal(element, editor); } }),
    createElement() {
      return { textContent: "", get innerHTML() { return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); } };
    },
    querySelectorAll(selector) {
      if (selector === '.messaging-root [data-role="messages-scroll"]') return !useNativeComposer || siblingComposer ? [scroller] : [];
      if (selector === `.messaging-root ${composerSelector}`) return siblingComposer ? [] : [composer];
      if (selector.startsWith("[data-sidebar-destination")) return sidebarID ? [side] : [];
      if (selector === "[data-dot-chat-portrait]") return portraitID ? [portrait] : [];
      return [];
    },
    execCommand(command, _showUI, text) {
      if (document.activeElement !== editor) return false;
      if ((textarea ? editor.value : editor.innerText) && !selected) return false;
      selected = false;
      insertions.push({ command, text });
      if (command === "delete") {
        if (textarea) editor.value = "";
        else editor.innerText = "";
      } else if (command === "insertHTML") {
        editor.innerText = text.replaceAll("<br>", "\n").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
      } else if (command === "insertText") {
        if (textarea) editor.value = text;
        else editor.innerText = text;
      } else return false;
      return true;
    },
  };
  const context = vm.createContext({ document });
  return { call: (command, expected, input) => vm.runInContext(expression(command, expected, input), context),
    clicked: () => clicked, editor, owner, button, insertions };
}

test("Dot replaces a draft only in the bound room and restores it without overwriting newer edits", () => {
  const f = fixture();
  const expected = { dotID: "dot-1", roomID: "room-1" };
  const input = { text: "hello" };
  f.editor.innerText = "existing native draft";
  assert.equal(f.call("fill", { dotID: "dot-2" }, input), null);
  assert.equal(f.call("fill", { roomID: "other" }, input), null);
  assert.equal(f.editor.innerText, "existing native draft");
  const draft = f.call("fill", expected, input);
  assert.equal(draft.previousDraft, "existing native draft");
  assert.equal(f.editor.innerText, "hello");

  assert.equal(f.call("send", { roomID: "other" }, input), null);
  assert.equal(f.call("send", expected, { text: "wrong" }).stage, "draft_mismatch");
  assert.equal(f.clicked(), 0);
  assert.equal(f.call("restore_draft", expected, { ...draft, submitted: false }), "restored");
  assert.equal(f.editor.innerText, "existing native draft");

  const sendDraft = f.call("fill", expected, input);
  assert.equal(f.call("send", expected, input), true);
  assert.equal(f.clicked(), 1);
  const restore = { ...sendDraft, submitted: true };
  assert.equal(f.call("restore_draft", expected, restore), "pending");
  f.editor.innerText = "newer local edit";
  assert.equal(f.call("restore_draft", expected, restore), "changed");
  assert.equal(f.editor.innerText, "newer local edit");
  f.editor.innerText = "";
  assert.equal(f.call("restore_draft", expected, restore), "restored");
  assert.equal(f.editor.innerText, "existing native draft");
});

test("a multiline Dot draft is inserted once with literal text and exact soft breaks", () => {
  const expected = { dotID: "dot-1", roomID: "room-1" };
  for (const text of ["第一行\n第二行", "第一行 <br> &\n第二行\n\n  末尾👋"]) {
    const f = fixture({ useNativeComposer: true, siblingComposer: true });
    assert.equal(f.call("fill", expected, { text }).previousDraft, "");
    assert.equal(f.editor.innerText, text);
    assert.deepEqual(f.insertions, [{ command: "insertHTML", text: text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll("\n", "<br>") }]);
    f.button.disabled = true;
    assert.equal(f.call("preflight", expected, { text }).stage, "send_button_unavailable");
    f.button.disabled = false;
    assert.equal(f.call("preflight", expected, { text }), true);
    assert.equal(f.call("send", expected, { text }), true);
    assert.equal(f.clicked(), 1);

    const textarea = fixture({ textarea: true });
    assert.equal(textarea.call("fill", expected, { text }).previousDraft, "");
    assert.deepEqual(textarea.insertions, [{ command: "insertText", text }]);
    assert.equal(textarea.editor.value, text);
    assert.equal(textarea.call("preflight", expected, { text }), true);
  }
});

test("foreground verification stays scoped and does not read the native transcript store", () => {
  const f = fixture();
  const { memoizedProps } = f.owner;
  delete memoizedProps.thread;
  memoizedProps.viewportState = { getSnapshot() { throw new Error("transcript store is blocked"); } };
  const status = f.call("inspect_status", { dotID: "dot-1", roomID: "room-1", workspace: "" });
  assert.equal(status.roomID, "room-1");
  assert.equal(status.canSend, true);
  assert.equal(Object.hasOwn(status, "messages"), false);
  assert.equal(f.call("inspect_status", { roomID: "room-2" }), null);
  assert.equal(f.call("inspect_status", { workspace: "another-workspace" }), null);
});

test("scoped native Dot props identify the room without an inner room record", () => {
  const f = fixture();
  const props = f.owner.memoizedProps;
  delete props.room;
  Object.assign(props, { orbitId: "dot-1", conversationId: "dot-conversation" });
  assert.equal(f.call("inspect", { dotID: "dot-1" }).roomID, "room-1");
  assert.equal(f.call("inspect", { dotID: "other-dot" }), null);
});

test("native Dot composer identifies the room when its transcript has no scroller marker", () => {
  const f = fixture({ useNativeComposer: true });
  const expected = { dotID: "dot-1", roomID: "room-1" };
  const state = f.call("inspect", expected);
  assert.equal(state.roomID, "room-1");
  assert.equal(state.history.loaded, true);
  assert.equal(f.call("fill", expected, { text: "hello" }).previousDraft, "");
  assert.equal(f.call("send", expected, { text: "hello" }), true);
  assert.equal(f.clicked(), 1);

  f.owner.memoizedProps.room.aeon_id = "different-dot";
  assert.equal(f.call("inspect", expected), null);
  assert.equal(f.call("send", expected, { text: "hello" }), null);
  assert.equal(f.clicked(), 1);
  assert.equal(fixture({ useNativeComposer: true, hasTranscript: false }).call("inspect", expected), null);
});

test("Dot sends through the adjacent footer only in the bound transcript's pane", () => {
  const expected = { dotID: "dot-1", roomID: "room-1" };
  const input = { text: "test message" };
  const samePane = fixture({ useNativeComposer: true, siblingComposer: true });
  assert.equal(samePane.call("inspect", expected).canSend, true);
  assert.equal(samePane.call("fill", expected, input).previousDraft, "");
  assert.equal(samePane.call("preflight", expected, input), true);
  assert.equal(samePane.call("send", expected, input), true);
  assert.equal(samePane.clicked(), 1);

  const otherPane = fixture({ useNativeComposer: true, siblingComposer: true, composerInOtherPane: true });
  assert.equal(otherPane.call("inspect", expected).roomID, "room-1");
  assert.equal(otherPane.call("inspect", expected).canSend, false);
  assert.equal(otherPane.call("fill", expected, input).stage, "editor_unavailable");
  assert.equal(otherPane.call("send", expected, input).stage, "editor_unavailable");
  assert.equal(otherPane.clicked(), 0);
});

test("bind identifies a visible markerless Dot from its committed conversation owner", () => {
  const f = fixture({ sidebarID: null, useNativeComposer: true });
  const props = f.owner.memoizedProps;
  delete props.room;
  Object.assign(props, { isOrbit: true, orbitId: "dot-1", conversationId: "dot-conversation" });
  const expected = { dotID: "dot-1", roomID: "room-1" };
  const inspected = f.call("inspect", expected);
  assert.equal(inspected.roomID, "room-1");
  props.viewportState = { getSnapshot() { throw new Error("bind must skip runtime stores"); } };
  delete props.thread;
  const binding = f.call("bind_status", expected);
  assert.equal(binding.dotID, "dot-1");
  assert.equal(binding.roomID, "room-1");
  assert.equal(binding.workspace, inspected.workspace);
  assert.deepEqual(Object.keys(binding), ["dotID", "roomID", "workspace"]);
  assert.equal(f.call("bind_status", { roomID: "different-room" }).stage, "different_room");
  assert.equal(f.call("send", { roomID: "different-room" }, { text: "hello" }), null);
  assert.equal(f.clicked(), 0);
});

test("bind rejects conflicting or ambiguous Dot ownership and markers", () => {
  const f = fixture({ sidebarID: null });
  const props = f.owner.memoizedProps;
  Object.assign(props, { isOrbit: true, orbitId: "dot-1", conversationId: "dot-conversation" });
  f.owner.return = { memoizedProps: { isOrbit: true, dotId: "dot-2", roomId: "room-2", conversationId: "other" } };
  assert.ok(f.call("bind_status").stage);

  f.owner.return = { memoizedProps: { isOrbit: true, dotId: "dot-1", roomId: "room-1", conversationId: "other" } };
  assert.ok(f.call("bind_status").stage);
  f.owner.return = { memoizedProps: { room: { id: "room-1", aeon_id: "dot-2" } } };
  assert.ok(f.call("bind_status").stage);
  delete f.owner.return;
  props.isOrbit = false;
  assert.ok(f.call("bind_status").stage);

  const staleMarker = fixture({ sidebarID: "dot-2" });
  Object.assign(staleMarker.owner.memoizedProps, props, { isOrbit: true });
  assert.ok(staleMarker.call("bind_status").stage);
  assert.ok(fixture({ portraitID: "dot-2" }).call("bind_status").stage);
});
