const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// Keep history lookups and terminal evidence isolated from the user's store.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-foreground-snapshot-"));
const originalHomedir = os.homedir;
os.homedir = () => home;
const { __test } = require("../index.js");
os.homedir = originalHomedir;
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function desktop(initial = A) {
  const state = { thread: initial, draft: "draft-a", reads: [] };
  const runtime = () => ({
    current_thread_id: state.thread,
    client_thread_id: state.draft,
    composer_available: true,
    composer_text: `composer:${state.thread || state.draft}`,
    running: false,
  });
  const controller = {
    currentThreadRuntimeState: async () => runtime(),
    readForegroundThreadId: async () => state.thread,
    composerControlState: async () => { state.reads.push("composer"); return { model: `model:${state.thread}` }; },
    queuedMessageState: async () => { state.reads.push("queue"); return { items: [] }; },
    threadPinned: async () => false,
    conversationHeaderMenuAvailable: async () => false,
    closedComposerControls: async () => null,
    readInteractiveSurface: async () => ({
      surface_id: `question:${state.thread}`, capability: "user_question", kind: "questionnaire",
    }),
    selectThread: async () => ({ selected: false }),
  };
  return { state, controller, runtime };
}

test("foreground snapshot accepts a stable thread and rejects a switch during UI reads", async () => {
  const { state, controller } = desktop();
  const stable = await __test.currentDesktopConversationSnapshot({ controller });
  assert.equal(stable.runtime.current_thread_id, A);
  assert.equal(stable.composer.raw.model, `model:${A}`);
  controller.threadPinned = async () => { state.thread = B; return true; };
  await assert.rejects(__test.currentDesktopConversationSnapshot({ controller }), { code: "desktop_foreground_changed" });
});

test("anonymous drafts retain their own identity and reject another draft", async () => {
  const { state, controller, runtime } = desktop("");
  const stable = await __test.currentDesktopConversationSnapshot({ controller });
  assert.equal(stable.runtime.client_thread_id, "draft-a");
  assert.deepEqual(state.reads, [], "anonymous draft must not load thread controls");
  const sampled = runtime();
  state.draft = "draft-b";
  await assert.rejects(__test.currentDesktopConversationSnapshot({ controller, runtime: sampled }), { code: "desktop_foreground_changed" });
});

test("unknown foreground keeps the existing unavailable snapshot behavior", async () => {
  const { state, controller } = desktop("");
  state.draft = "";
  const snapshot = await __test.currentDesktopConversationSnapshot({ controller });
  assert.equal(snapshot.runtime.current_thread_id, "");
  assert.equal(snapshot.composer, null);
});

test("detail rejects a switch while reading its interactive surface", async () => {
  const { state, controller } = desktop();
  controller.readInteractiveSurface = async () => {
    state.thread = B;
    return { surface_id: "question:b", capability: "user_question", kind: "questionnaire" };
  };
  await assert.rejects(__test.conversationDetailSnapshotFromDesktop(A, { controller, selectThread: false }), {
    code: "desktop_foreground_changed",
  });
});

test("stale detail never exposes another thread's composer or running state", async () => {
  const { controller } = desktop(B);
  const detail = await __test.conversationDetailSnapshotFromDesktop(A, { controller, settleMs: 0 });
  assert.equal(detail.detail_stale, true);
  assert.equal(detail.desktop_foreground, false);
  assert.equal(detail.composer.content, "");
  assert.equal(detail.composer.editable, false);
  assert.equal(detail.interactive_surface, null);
  assert.equal(detail.queue, undefined);
});

async function watch(controller, options = {}) {
  const events = [];
  const subscriber = { pluginWide: false, threadID: B, push: (event) => events.push(event) };
  __test.desktopWatchSubscribers.set("snapshot-regression", subscriber);
  try {
    await __test.pollDesktopWatch({ controller, ...options });
    return events;
  } finally {
    __test.desktopWatchSubscribers.delete("snapshot-regression");
  }
}

test("watcher drops a surface captured across a switch and publishes the next stable frame", async () => {
  const { state, controller } = desktop();
  const readSurface = controller.readInteractiveSurface;
  controller.readInteractiveSurface = async () => {
    const surface = await readSurface();
    state.thread = B;
    return surface;
  };
  assert.deepEqual(await watch(controller), []);
  controller.readInteractiveSurface = readSurface;
  const events = await watch(controller);
  const detail = events.find((event) => event.Payload?.detail_snapshot)?.Payload.detail_snapshot;
  assert.equal(detail.native_conversation_id, B);
  assert.equal(detail.interactive_surface.surface_id, `question:${B}`);
});

test("watcher drops a late foreground change before publishing controls", async () => {
  const { state, controller } = desktop();
  controller.closedComposerControls = async () => {
    state.thread = B;
    return { intelligence: { controlId: "codex.intelligence", currentValue: "B-only" } };
  };
  assert.deepEqual(await watch(controller), []);
});

test("watcher stops sampling after its budget and publishes no expired frame", async (t) => {
  let clock = 1000;
  t.mock.method(Date, "now", () => clock);
  const { state, controller } = desktop(B);
  controller.composerControlState = async () => {
    state.reads.push("composer");
    clock += 6;
    return { model: "late-model" };
  };
  assert.deepEqual(await watch(controller, { sampleBudgetMs: 5 }), []);
  assert.deepEqual(state.reads, ["composer"], "later CDP reads must not start after expiry");
});

test("a dropped terminal frame does not consume its native completion identity", async () => {
  const thread = "33333333-3333-4333-8333-333333333333";
  const sessions = path.join(home, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `rollout-${thread}.jsonl`), [
    { type: "session_meta", payload: { id: thread } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "guarded-turn" } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "guarded-turn" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const events = [];
  __test.desktopWatchSubscribers.set("terminal-guard-regression", { threadID: thread, push: (event) => events.push(event) });
  try {
    await assert.rejects(__test.emitDesktopTerminalRunEvents(thread, "completed", {}, undefined, {
      beforePublish: async () => { throw new Error("foreground changed before terminal publication"); },
    }), /foreground changed/);
    assert.deepEqual(events, []);
    await __test.emitDesktopTerminalRunEvents(thread, "completed", {}, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].Type, "run.completed");
  } finally {
    __test.desktopWatchSubscribers.delete("terminal-guard-regression");
  }
});
