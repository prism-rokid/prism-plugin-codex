const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { CodexDesktopController } = require("../codex_cdp");
const { __test } = require("../index");

const threadA = "11111111-1111-4111-8111-111111111111";
const threadB = "22222222-2222-4222-8222-222222222222";

function sendFixture(activeThreadID) {
  const controller = new CodexDesktopController();
  const state = { activeThreadID, resets: 0, inserts: 0, clicks: 0 };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, "[data-above-composer-conversation-id]");
      return [{
        parentElement: { getBoundingClientRect: () => ({ width: 10, height: 10 }) },
        getAttribute: () => state.activeThreadID,
      }];
    },
  };
  controller.evaluate = async (expression) => {
    if (expression.includes("data-above-composer-conversation-id")) {
      return vm.runInNewContext(expression, { document });
    }
    return { usable: true, enabled: true, mode: "submit", has_message_content: true };
  };
  controller.resetComposer = async () => { state.resets += 1; };
  controller.insertText = async () => { state.inserts += 1; };
  controller.clickElement = async () => { state.clicks += 1; };
  controller.waitForComposerSendReady = async () => ({ submission_kind: "send" });
  return { controller, state };
}

test("an outdated send target leaves the new foreground composer untouched", async () => {
  const { controller, state } = sendFixture(threadB);
  await assert.rejects(controller.sendMessage({ threadID: threadA, text: "hello" }), /control_target_stale/);
  assert.deepEqual([state.resets, state.inserts, state.clicks], [0, 0, 0]);
});

test("a foreground switch after composer preparation prevents the native click", async () => {
  const { controller, state } = sendFixture(threadA);
  controller.waitForComposerSendReady = async () => {
    state.activeThreadID = threadB;
    return { submission_kind: "send" };
  };
  await assert.rejects(controller.sendMessage({ threadID: threadA, text: "hello" }), /control_target_stale/);
  assert.deepEqual([state.resets, state.inserts, state.clicks], [1, 1, 0]);
});

test("attachment removal evaluates the thread guard before accessing the composer", async () => {
  const { controller } = sendFixture(threadB);
  await assert.rejects(controller.clearComposerAttachments(threadA), /control_target_stale/);
});

test("switching threads during file transport prevents native attachment injection", async () => {
  const { controller, state } = sendFixture(threadA);
  controller.focusComposer = async () => {};
  controller.send = async (method) => {
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") return { nodeId: 2 };
    assert.equal(method, "DOM.setFileInputFiles");
    state.activeThreadID = threadB;
  };
  await assert.rejects(controller.attachLocalFile(__filename, "fixture.txt", "text/plain", threadA), /control_target_stale/);
});

test("a post-click confirmation failure is indeterminate and does not click twice", async () => {
  const { controller, state } = sendFixture(threadA);
  controller.clickComposerPrimaryButton = async () => {
    state.clicks += 1;
    return { submission_kind: "send" };
  };
  controller.waitForComposerSubmission = async () => {
    state.activeThreadID = threadB;
    return { outcome: "message_visible" };
  };
  await assert.rejects(controller.sendMessage({ threadID: threadA, text: "hello" }), /delivery_indeterminate/);
  assert.equal(state.clicks, 1);
});

test("an interrupt lookup never uses the Stop control of another foreground thread", async () => {
  const { controller } = sendFixture(threadB);
  controller.ensureReady = async () => controller;
  controller.clickElement = async (expression) => {
    assert.equal(await controller.evaluate(expression), null);
    throw new Error("target unavailable");
  };
  controller.waitFor = async () => assert.fail("an unissued interrupt cannot be confirmed");
  await assert.rejects(controller.interrupt(threadA), /interrupt_control_unavailable/);
});

test("a stalled watcher bounds control waiting and can still finish normally", { timeout: 1000 }, async () => {
  const watcher = Promise.withResolvers();
  await assert.rejects(__test.waitForDesktopWatch(watcher.promise, 20), /desktop_watch_busy/);
  const waiting = __test.waitForDesktopWatch(watcher.promise, 100);
  watcher.resolve();
  await waiting;
});
