const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const vm = require("node:vm");
const Database = require("better-sqlite3");

const ROOT = "11111111-1111-4111-8111-111111111111";
const SIDE = "22222222-2222-4222-8222-222222222222";
const INDEPENDENT = "33333333-3333-4333-8333-333333333333";
const FORK = "44444444-4444-4444-8444-444444444444";

function fixture(t, controller = null, hooks = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-side-chat-"));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  t.after(() => {
    if (db.open) db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    tokens_used INTEGER, model_provider TEXT, model TEXT, reasoning_effort TEXT,
    sandbox_policy TEXT, approval_mode TEXT, memory_mode TEXT, agent_nickname TEXT,
    thread_source TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT, preview TEXT, attached_thread_parent_id TEXT
  )`);
  const insert = db.prepare(`INSERT INTO threads
    (id, title, thread_source, updated_at_ms, created_at_ms, recency_at_ms, archived, attached_thread_parent_id)
    VALUES (?, 'Same title', 'user', ?, ?, ?, 0, ?)`);
  const indexPath = path.join(codexHome, "session_index.jsonl");
  function addThread(id, updatedAt, parent = null) {
    insert.run(id, updatedAt, updatedAt, updatedAt, parent);
    fs.appendFileSync(indexPath, `${JSON.stringify({ id, thread_name: "Same title" })}\n`);
  }
  function setParent(id, parent) {
    db.prepare("UPDATE threads SET attached_thread_parent_id = ? WHERE id = ?").run(parent, id);
  }
  function writeRollout(id, rows) {
    const file = path.join(codexHome, "sessions", `rollout-${id}.jsonl`);
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row) + "\n").join(""));
    db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(file, id);
  }
  const filename = require.resolve("../index.js");
  const load = createRequire(filename);
  let controllerRequests = 0;
  const scopedRequire = (name) => {
    if (name === "os") return { ...os, homedir: () => home };
    if (name === "./codex_cdp") return {
      createCodexDesktopController: () => {
        controllerRequests += 1;
        assert.ok(controller, "unexpected CDP connection");
        return controller;
      },
    };
    return load(name);
  };
  const source = fs.readFileSync(filename, "utf8");
  const mod = { exports: {} };
  const stateQueryResults = [];
  // 加载真实 adapter，替换进程数据目录和 CDP 工厂，并手动驱动 watcher，避免依赖计时和宿主。
  const fixtureExports = `
    const readStateRows = queryStateRows;
    queryStateRows = async (sql) => {
      const rows = await readStateRows(sql);
      stateQueryResults.push(rows);
      await hooks.afterStateQuery?.(sql);
      return rows;
    };
    if (hooks.beforeSummary) {
      const readSummary = latestAssistantSummary;
      latestAssistantSummary = async (threadID) => {
        await hooks.beforeSummary(threadID);
        return readSummary(threadID);
      };
    }
    if (hooks.manualSubscriptions) {
      ensureCodexAccountUsageClient = async () => {};
      startCodexAccountUsagePolling = () => {};
      ensureDesktopDirectoryWatchRunning = () => {};
      ensureDesktopWatchRunning = () => {};
    }
    Object.assign(module.exports, {
      adapter, readThreadsFromState, reconcileDesktopDirectoryFromStorage,
      desktopWatchSubscribers, pollDesktopWatch, desktopRunFileWatchPoll,
    });
  `;
  vm.compileFunction(source + fixtureExports, ["require", "module", "process", "stateQueryResults", "hooks"], { filename })(
    scopedRequire, mod, { platform: process.platform, env: { ...process.env, PRISM_CODEX_HOME: codexHome } }, stateQueryResults, hooks,
  );
  return { ...mod.exports, db, addThread, setParent, writeRollout, indexPath, stateQueryResults, controllerRequests: () => controllerRequests };
}

function desktopStub() {
  return {
    foreground: "",
    selections: [],
    ensureReady: async () => {},
    currentThreadRuntimeState: async function () { return { current_thread_id: this.foreground }; },
    isThreadSelected: async function (threadID) { return this.foreground === threadID; },
    selectThread: async function (threadID) {
      this.selections.push(threadID);
      this.foreground = threadID;
      return { selected: true };
    },
    readInteractiveSurface: async () => null,
    queuedMessageState: async () => null,
    threadPinned: async () => false,
    conversationHeaderMenuAvailable: async () => false,
    composerControlState: async () => null,
    closedComposerControls: async () => null,
  };
}

function observeWatch(directory, threadID = "") {
  const events = [];
  directory.desktopWatchSubscribers.set(threadID, { pluginWide: !threadID, threadID, push: (event) => events.push(event) });
  return events;
}

function sessionIDs(sessions) {
  return sessions.map((session) => session.NativeThreadID);
}

test("session directory hides attached side chats and keeps independent same-title threads and forks", async (t) => {
  const { adapter, addThread, writeRollout } = fixture(t);
  addThread(ROOT, 10);
  addThread(SIDE, 30, ROOT);
  addThread(INDEPENDENT, 20);
  addThread(FORK, 40);
  writeRollout(FORK, [{ type: "session_meta", payload: { id: FORK, forked_from_id: ROOT, thread_source: "user" } }]);

  const sessions = await adapter.listSessions();
  assert.deepEqual(sessionIDs(sessions), [FORK, INDEPENDENT, ROOT]);
  assert.deepEqual(sessions.map((session) => session.Title), ["Same title", "Same title", "Same title"]);
});

test("recent side chats cannot consume the main session page or expand the metadata query", async (t) => {
  const { addThread, db, readThreadsFromState, stateQueryResults } = fixture(t);
  addThread(ROOT, 1);
  const sideChatIDs = [];
  db.transaction(() => {
    for (let n = 1; n <= 1000; n += 1) {
      const id = `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
      addThread(id, n + 1, ROOT);
      sideChatIDs.push(id);
    }
  })();
  for (let n = 1; n <= 8; n += 1) {
    addThread(`88888888-8888-4888-8888-${String(n).padStart(12, "0")}`, 1 - n);
  }
  db.prepare("UPDATE threads SET archived = 1 WHERE id = ?").run(sideChatIDs.at(-1));

  const { threads, attachedThreadIDs } = await readThreadsFromState(1);
  assert.deepEqual(threads.map((thread) => thread.id), [ROOT]);
  assert.deepEqual(attachedThreadIDs, new Set(sideChatIDs));
  const metadataRows = stateQueryResults.flat().filter((row) => typeof row.title === "string");
  assert.equal(metadataRows.length, 4, "only the bounded root candidate page carries metadata");
  assert.ok(metadataRows.every(({ id }) => !attachedThreadIDs.has(id)));
});

test("a directory with only confirmed side chats is empty and can be reconciled", async (t) => {
  const directory = fixture(t);
  const events = observeWatch(directory);
  directory.addThread(ROOT, 10);
  directory.addThread(SIDE, 20, ROOT);
  directory.db.prepare("UPDATE threads SET archived = 1 WHERE id = ?").run(ROOT);
  assert.deepEqual(await directory.adapter.listSessions(), []);
  await directory.reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(events.map((event) => event.Type), ["desktop.session.directory.reconciled"]);
});

test("an unconfirmed native index entry still prevents publication of an empty snapshot", async (t) => {
  const { adapter, addThread, indexPath } = fixture(t);
  addThread(SIDE, 20, ROOT);
  fs.appendFileSync(indexPath, `\n${JSON.stringify({ id: ROOT })}\n`);
  await assert.rejects(adapter.listSessions(), /session list incomplete/);
});

test("an older database without attachment metadata preserves listing and control", async (t) => {
  const controller = desktopStub();
  const { adapter, db, addThread } = fixture(t, controller);
  addThread(ROOT, 10);
  db.exec("ALTER TABLE threads DROP COLUMN attached_thread_parent_id");
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [ROOT]);
  const result = await adapter.controlSession({ session: { NativeThreadID: ROOT }, action: "conversation.select" });
  assert.equal(result.ok, true);
  assert.deepEqual(controller.selections, [ROOT]);
});

test("directory errors other than a missing attachment column are surfaced", async (t) => {
  const { adapter, db, addThread, controllerRequests } = fixture(t);
  addThread(ROOT, 10);
  db.exec("ALTER TABLE threads DROP COLUMN recency_at_ms");
  await assert.rejects(adapter.listSessions(), /recency_at_ms|无法读取 Codex 会话数据库/);
  db.exec("DROP TABLE threads");
  await assert.rejects(adapter.interrupt({ NativeThreadID: ROOT }), /readable threads table/);
  assert.equal(controllerRequests(), 0);
});

test("attaching or detaching a thread rebuilds the remote directory without archiving it", async (t) => {
  const directory = fixture(t);
  const { adapter, db, addThread, setParent, reconcileDesktopDirectoryFromStorage } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  const events = observeWatch(directory);
  await reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [SIDE, ROOT]);
  events.length = 0;

  setParent(SIDE, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(events.splice(0).map((event) => event.Type), ["desktop.session.directory.reconciled"]);
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [ROOT]);

  setParent(SIDE, null);
  await reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(events.splice(0).map((event) => event.Type), ["desktop.session.directory.reconciled"]);
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [SIDE, ROOT]);
  assert.equal(db.prepare("SELECT archived FROM threads WHERE id = ?").get(SIDE).archived, 0);

  addThread(INDEPENDENT, 30);
  await reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(events.map((event) => [event.Type, event.Payload.session_hint.native_thread_id]), [
    ["desktop.session.index.changed", INDEPENDENT],
  ]);
});

test("foreground, stale and terminal side chat events cannot refill the remote index", async (t) => {
  const controller = desktopStub();
  const directory = fixture(t, controller);
  const { addThread, setParent, writeRollout, pollDesktopWatch, __test } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  writeRollout(SIDE, [{
    type: "event_msg",
    timestamp: new Date().toISOString(),
    payload: { type: "task_started", turn_id: "side-turn" },
  }]);
  const pluginEvents = observeWatch(directory);
  const threadEvents = observeWatch(directory, SIDE);
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal(pluginEvents.at(-1).Payload.session_hint.native_thread_id, SIDE);
  assert.equal(threadEvents.at(-1).Payload.session_hint.native_thread_id, SIDE);
  pluginEvents.length = 0;
  threadEvents.length = 0;

  setParent(SIDE, ROOT);
  await pollDesktopWatch();
  assert.deepEqual(pluginEvents, []);
  assert.equal(threadEvents.at(-1).Type, "desktop.state.changed");
  assert.equal(threadEvents.at(-1).Payload.session_hint, undefined);

  writeRollout(SIDE, [{
    type: "event_msg",
    timestamp: new Date().toISOString(),
    payload: { type: "task_complete", turn_id: "side-turn" },
  }]);
  await __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  assert.deepEqual(pluginEvents, []);
  assert.equal(threadEvents.at(-1).Type, "run.completed");
  assert.equal(threadEvents.at(-1).Payload.session_hint, undefined);

  controller.foreground = ROOT;
  await pollDesktopWatch();
  assert.deepEqual(pluginEvents.map((event) => event.Payload.session_hint.native_thread_id), [ROOT]);
  assert.equal(threadEvents.at(-1).Payload.detail_snapshot.detail_stale, true);
  assert.equal(threadEvents.at(-1).Payload.session_hint, undefined);
});

test("existing side chat history remains readable and fresh guards reject writes before CDP", async (t) => {
  const { adapter, addThread, setParent, writeRollout, controllerRequests, __test } = fixture(t);
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  const session = await adapter.attachSession({ NativeThreadID: SIDE }); // 预热原生线程缓存
  const menu = __test.createPluginMenuSession(SIDE, { kind: "conversation" }, [{ optionId: "archive", label: "Archive" }]);
  setParent(SIDE, ROOT);
  writeRollout(SIDE, [{
    type: "response_item",
    timestamp: new Date().toISOString(),
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Old side chat" }] },
  }]);
  const history = await adapter.readHistory(session, 10);
  assert.ok(history.some((message) => message.Content === "Old side chat"));
  assert.doesNotMatch(JSON.stringify(await adapter.attachSession(session)), /attached_thread_parent_id|11111111-1111-4111-8111-111111111111/);

  await assert.rejects(adapter.send(session, { Text: "Do not send" }), /side chats are read-only/);
  await assert.rejects(adapter.interrupt(session), /side chats are read-only/);
  await assert.rejects(adapter.resolveApproval({ Session: session, ActionID: "approve" }), /side chats are read-only/);
  for (const [action, target] of [
    ["conversation.select", null],
    ["controls.describe", null],
    ["menu_session.describe", { owner: { kind: "conversation" } }],
    ["menu_session.apply", { menu_session_id: menu.menu_session_id, entry_id: menu.entries[0].entry_id }],
    ["interactive.surface.apply", { surface_id: "surface", action_id: "action" }],
    ["plan.set", { enabled: true }],
    ["goal.clear", null],
    ["queue.send", { queue_item_id: "item" }],
  ]) {
    await assert.rejects(adapter.controlSession({ session, action, target }), /side chats are read-only/, action);
  }
  assert.equal(controllerRequests(), 0);
});

test("attaching a foreground thread beyond the SQLite page publishes one full directory refresh", async (t) => {
  const controller = desktopStub();
  const directory = fixture(t, controller);
  const { addThread, db, setParent, pollDesktopWatch, reconcileDesktopDirectoryFromStorage } = directory;
  addThread(SIDE, 1);
  addThread(ROOT, 2);
  db.transaction(() => {
    for (let n = 1; n < 500; n += 1) {
      addThread(`77777777-7777-4777-8777-${String(n).padStart(12, "0")}`, n + 2);
    }
  })();
  const events = observeWatch(directory);
  await reconcileDesktopDirectoryFromStorage();
  assert.ok(!sessionIDs(await directory.adapter.listSessions()).includes(SIDE));
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal(events.at(-1).Payload.session_hint.native_thread_id, SIDE);
  events.length = 0;

  setParent(SIDE, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  await reconcileDesktopDirectoryFromStorage();
  assert.deepEqual(events.map((event) => event.Type), ["desktop.session.directory.reconciled"]);
});

test("a terminal summary delayed past directory reconciliation cannot republish a side chat", async (t) => {
  const summaryStarted = Promise.withResolvers();
  const resumeSummary = Promise.withResolvers();
  const directory = fixture(t, null, {
    beforeSummary: async () => {
      summaryStarted.resolve();
      await resumeSummary.promise;
    },
  });
  const { addThread, setParent, writeRollout, reconcileDesktopDirectoryFromStorage, __test } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  writeRollout(SIDE, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "terminal-race" } }]);
  const pluginEvents = observeWatch(directory);
  const threadEvents = observeWatch(directory, SIDE);
  await reconcileDesktopDirectoryFromStorage();
  pluginEvents.length = 0;

  const terminal = __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  try {
    await summaryStarted.promise;
    setParent(SIDE, ROOT);
    await reconcileDesktopDirectoryFromStorage();
  } finally {
    resumeSummary.resolve();
    await terminal;
  }
  assert.deepEqual(pluginEvents.map((event) => event.Type), ["desktop.session.directory.reconciled"]);
  assert.equal(threadEvents.at(-1).Type, "run.completed");
  assert.equal(threadEvents.at(-1).Payload.session_hint, undefined);
});

test("a foreground classification superseded by directory reconciliation cannot publish a root hint", async (t) => {
  const controller = desktopStub();
  const attachmentRead = Promise.withResolvers();
  const resumeRead = Promise.withResolvers();
  const directory = fixture(t, controller, {
    afterStateQuery: async (sql) => {
      if (!sql.includes(`WHERE id = '${SIDE}'`) || !/\bAS attached\b/.test(sql)) return;
      attachmentRead.resolve();
      await resumeRead.promise;
    },
  });
  const { addThread, setParent, pollDesktopWatch, reconcileDesktopDirectoryFromStorage } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  const pluginEvents = observeWatch(directory);
  const threadEvents = observeWatch(directory, SIDE);
  await reconcileDesktopDirectoryFromStorage();
  pluginEvents.length = 0;

  controller.foreground = SIDE;
  const foreground = pollDesktopWatch();
  try {
    await attachmentRead.promise;
    setParent(SIDE, ROOT);
    await reconcileDesktopDirectoryFromStorage();
  } finally {
    resumeRead.resolve();
    await foreground;
  }
  assert.deepEqual(pluginEvents.map((event) => event.Type), ["desktop.session.directory.reconciled"]);
  assert.equal(threadEvents.at(-1).Type, "desktop.state.changed");
  assert.equal(threadEvents.at(-1).Payload.session_hint, undefined);
});

test("a missing state database allows an empty directory but rejects an existing-thread interrupt", async (t) => {
  const directory = fixture(t, { ...desktopStub(), interrupt: async () => {} });
  directory.db.close();
  fs.rmSync(directory.db.name);
  assert.deepEqual(await directory.adapter.listSessions(), []);
  await assert.rejects(directory.adapter.interrupt({ NativeThreadID: ROOT }), /control_target_stale/);
  assert.equal(directory.controllerRequests(), 0);
});

test("an older schema still requires a matching thread row before remote control", async (t) => {
  const directory = fixture(t, { ...desktopStub(), interrupt: async () => {} });
  directory.addThread(ROOT, 10);
  directory.db.exec("ALTER TABLE threads DROP COLUMN attached_thread_parent_id");
  await assert.rejects(directory.adapter.interrupt({ NativeThreadID: SIDE }), /control_target_stale/);
  assert.equal(directory.controllerRequests(), 0);
});

test("an offscreen root run's terminal event survives a transient attachment read failure", async (t) => {
  let failRead = false;
  const directory = fixture(t, null, {
    afterStateQuery: async (sql) => {
      if (failRead && /\bAS attached\b/.test(sql)) throw new Error("SQLITE_BUSY");
    },
  });
  const { addThread, writeRollout, db, desktopRunFileWatchPoll, __test } = directory;
  addThread(ROOT, 10);
  writeRollout(ROOT, [{ type: "event_msg", payload: { type: "task_started", turn_id: "offscreen-run" } }]);
  const { rollout_path: rollout } = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(ROOT);
  __test.desktopRunFileWatchStart(ROOT, rollout);
  t.after(() => __test.desktopRunFileWatchStop(ROOT));
  const events = observeWatch(directory);
  fs.appendFileSync(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "offscreen-run" } })}\n`);
  failRead = true;
  await assert.rejects(desktopRunFileWatchPoll(ROOT), /SQLITE_BUSY/);
  assert.deepEqual(events, []);

  failRead = false;
  await desktopRunFileWatchPoll(ROOT);
  await desktopRunFileWatchPoll(ROOT);
  assert.deepEqual(events.map((event) => [event.Type, event.Payload.session_hint.native_thread_id]), [["run.completed", ROOT]]);
});

test("queued side-chat events cannot restore an index hint after a coalesced full refresh", { timeout: 5000 }, async (t) => {
  const controller = desktopStub();
  const directory = fixture(t, controller, { manualSubscriptions: true });
  const { adapter, addThread, setParent, writeRollout, reconcileDesktopDirectoryFromStorage, pollDesktopWatch, __test } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  addThread(INDEPENDENT, 30);
  const abort = new AbortController();
  const plugin = adapter.subscribePlugin(abort.signal);
  const scoped = adapter.subscribe({ NativeThreadID: SIDE }, abort.signal);
  t.after(async () => {
    abort.abort();
    await Promise.all([plugin.return(), scoped.return()]);
  });
  const initial = plugin.next();
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await initial).value.Type, "desktop.session.directory.reconciled");

  setParent(INDEPENDENT, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  const firstDetail = scoped.next();
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal((await firstDetail).value.Payload.session_hint.native_thread_id, SIDE);
  writeRollout(SIDE, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "queued-side" } }]);
  await __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  writeRollout(ROOT, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "queued-root" } }]);
  await __test.emitDesktopTerminalRunEvents(ROOT, "completed", null, null);

  setParent(SIDE, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await plugin.next()).value.Type, "desktop.session.directory.reconciled");
  assert.equal((await plugin.next()).value.Payload.session_hint.native_thread_id, ROOT);
  const scopedTerminal = (await scoped.next()).value;
  assert.equal(scopedTerminal.Type, "run.completed");
  assert.equal(scopedTerminal.Payload.session_hint, undefined);
});


test("a transient previous-thread attachment failure still publishes one scoped stale detail", async (t) => {
  let failPrevious = false;
  const controller = desktopStub();
  const directory = fixture(t, controller, {
    afterStateQuery: async (sql) => {
      if (!failPrevious || !sql.includes(`WHERE id = '${SIDE}'`) || !/\bAS attached\b/.test(sql)) return;
      failPrevious = false;
      throw new Error("SQLITE_BUSY during previous-thread attachment read");
    },
  });
  const { addThread, setParent, pollDesktopWatch } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  const pluginEvents = observeWatch(directory);
  const scopedEvents = observeWatch(directory, SIDE);
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.desktop_foreground, true);
  pluginEvents.length = 0;
  scopedEvents.length = 0;

  setParent(SIDE, ROOT);
  controller.foreground = ROOT;
  failPrevious = true;
  await pollDesktopWatch();
  await pollDesktopWatch();
  await pollDesktopWatch();
  assert.equal(failPrevious, false, "the one-shot relationship failure was exercised");
  assert.equal(scopedEvents.length, 1);
  assert.equal(scopedEvents[0].Payload.detail_snapshot.desktop_foreground, false);
  assert.equal(scopedEvents[0].Payload.detail_snapshot.detail_stale, true);
  assert.equal(scopedEvents[0].Payload.session_hint, undefined);
  assert.deepEqual(pluginEvents.map((event) => event.Payload.session_hint?.native_thread_id), [ROOT]);

  setParent(SIDE, null);
  controller.foreground = SIDE;
  await pollDesktopWatch();
  await pollDesktopWatch();
  assert.equal(scopedEvents.length, 2, "returning to the detached root publishes one fresh detail");
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.desktop_foreground, true);
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.detail_stale, false);
  assert.equal(scopedEvents.at(-1).Payload.session_hint.native_thread_id, SIDE);

  controller.foreground = ROOT;
  await pollDesktopWatch();
  await pollDesktopWatch();
  assert.equal(scopedEvents.length, 3, "a healthy switch publishes stale only once");
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.detail_stale, true);
  assert.equal(scopedEvents.at(-1).Payload.session_hint.native_thread_id, SIDE);
});

test("foreground unavailable notifications preserve routing without attachment reads", async (t) => {
  let blockAttachmentReads = false;
  let blockedAttachmentReads = 0;
  const controller = desktopStub();
  const directory = fixture(t, controller, {
    afterStateQuery: async (sql) => {
      if (!blockAttachmentReads || !/\bAS attached\b/.test(sql)) return;
      blockedAttachmentReads += 1;
      throw new Error("SQLITE_BUSY at foreground unavailability");
    },
  });
  directory.addThread(ROOT, 10);
  const pluginEvents = observeWatch(directory);
  const scopedEvents = observeWatch(directory, ROOT);
  controller.foreground = ROOT;
  await directory.pollDesktopWatch();
  pluginEvents.length = 0;
  scopedEvents.length = 0;

  controller.foreground = "";
  await directory.pollDesktopWatch();
  await directory.pollDesktopWatch();
  assert.deepEqual(pluginEvents, []);
  blockAttachmentReads = true;
  await directory.pollDesktopWatch();
  await directory.pollDesktopWatch();
  await directory.pollDesktopWatch();
  assert.deepEqual(pluginEvents.map((event) => event.Type), ["watcher.foreground.unavailable"]);
  assert.deepEqual(scopedEvents.map((event) => event.Type), ["watcher.foreground.unavailable"]);
  assert.equal(pluginEvents[0].Payload.native_session?.native_thread_id, ROOT);
  assert.equal(pluginEvents[0].Payload.session_hint, undefined);
  assert.equal(scopedEvents[0].Payload.session_hint, undefined);
  assert.equal(blockedAttachmentReads, 0, "watcher status does not depend on attachment reads");

  blockAttachmentReads = false;
  controller.foreground = ROOT;
  await directory.pollDesktopWatch();
  await directory.pollDesktopWatch();
  assert.deepEqual(pluginEvents.map((event) => event.Type), ["watcher.foreground.unavailable", "desktop.state.changed"]);
  assert.deepEqual(scopedEvents.map((event) => event.Type), ["watcher.foreground.unavailable", "desktop.state.changed"]);
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.desktop_foreground, true);
  assert.equal(scopedEvents.at(-1).Payload.detail_snapshot.detail_stale, false);

  controller.foreground = "";
  for (let n = 0; n < 4; n += 1) await directory.pollDesktopWatch();
  assert.equal(pluginEvents.length, 3, "a healthy outage also publishes once");
  assert.equal(pluginEvents.at(-1).Type, "watcher.foreground.unavailable");
  assert.equal(pluginEvents.at(-1).Payload.native_session.native_thread_id, ROOT);
  controller.foreground = ROOT;
  await directory.pollDesktopWatch();
  await directory.pollDesktopWatch();
  assert.equal(pluginEvents.length, 4, "a healthy recovery publishes once");
  assert.equal(scopedEvents.length, 4);
  assert.equal(pluginEvents.at(-1).Type, "desktop.state.changed");
});

test("queued foreground unavailable notifications retain routing after side-chat reconciliation", { timeout: 5000 }, async (t) => {
  const controller = desktopStub();
  const directory = fixture(t, controller, { manualSubscriptions: true });
  const { adapter, addThread, setParent, writeRollout, reconcileDesktopDirectoryFromStorage, pollDesktopWatch, __test } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  const abort = new AbortController();
  const plugin = adapter.subscribePlugin(abort.signal);
  const scoped = adapter.subscribe({ NativeThreadID: SIDE }, abort.signal);
  t.after(async () => {
    abort.abort();
    await Promise.all([plugin.return(), scoped.return()]);
  });
  const initial = plugin.next();
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await initial).value.Type, "desktop.session.directory.reconciled");
  const firstDetail = scoped.next();
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal((await firstDetail).value.Payload.session_hint.native_thread_id, SIDE);
  assert.equal((await plugin.next()).value.Payload.session_hint.native_thread_id, SIDE);

  controller.foreground = "";
  for (let n = 0; n < 5; n += 1) await pollDesktopWatch();
  setParent(SIDE, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  writeRollout(ROOT, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "root-after-unavailable" } }]);
  await __test.emitDesktopTerminalRunEvents(ROOT, "completed", null, null);
  await __test.emitDesktopTerminalRunEvents(ROOT, "completed", null, null);

  // 关闭后排空真实订阅队列，连同重复通知和目录刷新一起检查。
  abort.abort();
  const pluginEvents = [];
  const scopedEvents = [];
  for await (const event of plugin) pluginEvents.push(event);
  for await (const event of scoped) scopedEvents.push(event);
  assert.deepEqual(pluginEvents.map((event) => event.Type), [
    "watcher.foreground.unavailable", "desktop.session.directory.reconciled", "run.completed",
  ]);
  assert.equal(pluginEvents[0].Payload.native_session.native_thread_id, SIDE);
  assert.equal(pluginEvents[0].Payload.native_session.native_session_id, SIDE);
  assert.equal(pluginEvents[0].Payload.session_hint, undefined);
  assert.equal(pluginEvents[2].Payload.session_hint.native_thread_id, ROOT);
  assert.deepEqual(scopedEvents.map((event) => event.Type), ["watcher.foreground.unavailable"]);
  assert.equal(scopedEvents[0].Payload.session_hint, undefined);
});

test("closing the last plugin subscription preserves attachment evidence for live scoped queues", { timeout: 5000 }, async (t) => {
  const controller = desktopStub();
  const directory = fixture(t, controller, { manualSubscriptions: true });
  const { adapter, addThread, setParent, writeRollout, reconcileDesktopDirectoryFromStorage, pollDesktopWatch, __test } = directory;
  addThread(ROOT, 10);
  addThread(SIDE, 20);
  // 已打开会话在读取详情前就有 rollout，后续终态写入同一文件。
  writeRollout(ROOT, []);
  writeRollout(SIDE, []);
  const subscriptions = [];
  function subscribe(session) {
    const abort = new AbortController();
    const stream = session ? adapter.subscribe(session, abort.signal) : adapter.subscribePlugin(abort.signal);
    const close = async () => { abort.abort(); await stream.return(); };
    subscriptions.push(close);
    return { stream, close };
  }
  t.after(async () => { for (const close of subscriptions) await close(); });
  const plugin = subscribe();
  const scoped = subscribe({ NativeThreadID: SIDE });
  const rootScoped = subscribe({ NativeThreadID: ROOT });
  const initial = plugin.stream.next();
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await initial).value.Type, "desktop.session.directory.reconciled");
  const firstSide = scoped.stream.next();
  controller.foreground = SIDE;
  await pollDesktopWatch();
  assert.equal((await firstSide).value.Payload.session_hint.native_thread_id, SIDE);
  const firstRoot = rootScoped.stream.next();
  controller.foreground = ROOT;
  await pollDesktopWatch();
  assert.equal((await firstRoot).value.Payload.session_hint.native_thread_id, ROOT);
  assert.equal((await scoped.stream.next()).value.Payload.detail_snapshot.detail_stale, true);
  writeRollout(SIDE, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "queued-side-before-close" } }]);
  await __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  writeRollout(ROOT, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "queued-root-before-close" } }]);
  await __test.emitDesktopTerminalRunEvents(ROOT, "completed", null, null);
  setParent(SIDE, ROOT);
  await reconcileDesktopDirectoryFromStorage();
  await plugin.close();

  const sideTerminal = (await scoped.stream.next()).value;
  assert.equal(sideTerminal.Type, "run.completed");
  assert.equal(sideTerminal.Payload.native_session.native_thread_id, SIDE);
  assert.equal(sideTerminal.Payload.session_hint, undefined);
  const rootTerminal = (await rootScoped.stream.next()).value;
  assert.equal(rootTerminal.Type, "run.completed");
  assert.equal(rootTerminal.Payload.session_hint.native_thread_id, ROOT);

  const reopened = subscribe();
  const reopenedInitial = reopened.stream.next();
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await reopenedInitial).value.Type, "desktop.session.directory.reconciled");
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [ROOT]);
  setParent(SIDE, null);
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await reopened.stream.next()).value.Type, "desktop.session.directory.reconciled");
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [SIDE, ROOT]);
  writeRollout(SIDE, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "detached-after-reopen" } }]);
  await __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  assert.equal((await reopened.stream.next()).value.Payload.session_hint.native_thread_id, SIDE);
  assert.equal((await scoped.stream.next()).value.Payload.session_hint.native_thread_id, SIDE);

  await reopened.close();
  await scoped.close();
  await rootScoped.close();
  assert.equal(directory.desktopWatchSubscribers.size, 0);
  const freshPlugin = subscribe();
  const freshInitial = freshPlugin.stream.next();
  await reconcileDesktopDirectoryFromStorage();
  assert.equal((await freshInitial).value.Type, "desktop.session.directory.reconciled");
  assert.deepEqual(sessionIDs(await adapter.listSessions()), [SIDE, ROOT]);
  writeRollout(SIDE, [{ type: "event_msg", payload: { type: "task_complete", turn_id: "fresh-root-after-all-close" } }]);
  await __test.emitDesktopTerminalRunEvents(SIDE, "completed", null, null);
  assert.equal((await freshPlugin.stream.next()).value.Payload.session_hint.native_thread_id, SIDE);
});
