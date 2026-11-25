"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { createStdioServer } = require("@rokid-prism/pluginbridge-plugin-sdk");
const { createDotAdapter, nativeSession } = require("../adapter.cjs");
const { createDesktopBackend, targetSocket } = require("../desktop.cjs");
const { compatibleOutput, PluginAdapterError } = require("../stdio.cjs");

const row = (id, text, fields = {}) => ({ id, text, role: "user", self: true, confirmed: true, createdAt: "2026-11-22T12:00:00Z", ...fields });
const reply = (id, text, fields = {}) => row(id, text, { role: "assistant", dot: true, self: false, ...fields });
const state = (fields = {}) => ({
  dotID: "dot-1", roomID: "room-1", workspace: "account-1", targetID: "target-1",
  canSend: true, typing: false, messages: [row("baseline", "Earlier message")], approvalPending: false, history: { loaded: true }, ...fields,
});

function fixture(initial = state(), override = {}) {
  let current = initial;
  let clicks = 0;
  const backend = {
    async snapshot(expected = {}) {
      for (const key of ["dotID", "roomID", "workspace", "targetID"]) {
        if (expected[key] && expected[key] !== current[key]) throw new Error("Identity changed");
      }
      return current;
    },
    async send(expected, text, markSubmitted, assertReady) {
      const before = await backend.snapshot(expected);
      assertReady(before);
      if (before.typing) throw new PluginAdapterError("dot_send_unavailable", "Dot is still replying.");
      markSubmitted(before);
      clicks += 1;
      current = { ...current, messages: [...current.messages, row(`user-${clicks}`, text)] };
    },
    ...override,
  };
  const adapter = createDotAdapter({ backend, PluginAdapterError, settings: { pollMs: 2, deliveryMs: 15, waitMs: 22 } });
  return { adapter, backend, session: nativeSession(initial), set: (next) => { current = next; }, clicks: () => clicks, get: () => current };
}

async function yieldAll(iterable) {
  const output = [];
  for await (const event of iterable) output.push(event);
  return output;
}

test("an explicitly linked native Dot reply completes only its confirmed user run", async () => {
  const f = fixture();
  const receipt = await f.adapter.send(f.session, { PrismMessageID: "prism-1", Text: "hello" });
  assert.equal(receipt.NativeMessageID, "user-1");
  f.set(state({ messages: [...f.get().messages, reply("other", "Unrelated"), reply("answer", "hello back", { replyTo: "user-1" })] }));
  const completion = await f.adapter.waitForRun(f.session, receipt.NativeMessageID);
  assert.equal(completion.Type, "run.completed");
  assert.equal(completion.Payload.message_id, "answer");
  assert.equal(completion.Payload.native_run_id, receipt.NativeMessageID);
  const again = await f.adapter.send(f.session, { PrismMessageID: "prism-1", Text: "hello" });
  assert.deepEqual(again, receipt);
  assert.equal(f.clicks(), 1);
});

test("an idle Dot transcript permits a follow-up before an unlinked run times out", async () => {
  const f = fixture();
  const receipt = await f.adapter.send(f.session, { PrismMessageID: "p-1", Text: "hello" });
  const sendAgain = () => f.adapter.send(f.session, { PrismMessageID: "p-2", Text: "follow-up" });
  const messages = f.get().messages;
  const answer = reply("answer", "Visible reply");

  f.set(state({ messages: [...messages, answer], typing: true }));
  await assert.rejects(sendAgain(), { code: "dot_busy" });
  f.set(state({ messages: [...messages, { ...answer, confirmed: false }] }));
  await assert.rejects(sendAgain(), { code: "dot_busy" });
  f.set(state({ messages: [...messages, { ...answer, replyTo: "baseline" }] }));
  await assert.rejects(sendAgain(), { code: "dot_busy" });
  f.set(state({ messages: [...messages, row("other-user", "Intervening message"), answer] }));
  await assert.rejects(sendAgain(), { code: "dot_busy" });
  f.set(state({ targetID: "target-2", messages: [...messages, answer] }));
  await assert.rejects(sendAgain(), { code: "dot_busy" });
  f.set(state({ messages: [...messages, answer], approvalPending: true }));
  await assert.rejects(sendAgain(), { code: "dot_approval_pending" });
  assert.equal(f.clicks(), 1);

  f.set(state({ messages: [...messages, answer] }));
  const [record] = await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 1 }));
  assert.deepEqual(record.turn.messages.map(({ ID }) => ID), ["user-1", "answer"]);
  assert.equal((await f.adapter.readStatus(f.session, receipt.NativeMessageID)).status, "unknown");
  assert.equal((await sendAgain()).NativeMessageID, "user-2");
  assert.equal(f.clicks(), 2);
  const completion = await f.adapter.waitForRun(f.session, receipt.NativeMessageID);
  assert.equal(completion.Type, "run.wait_timeout");
  assert.equal(completion.Payload.timeout_fallback, true);
});

test("an unlinked receipt cannot keep an idle native composer busy indefinitely", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = fixture();
  const first = await f.adapter.send(f.session, { PrismMessageID: "first", Text: "hello" });
  const followUp = () => f.adapter.send(f.session, { PrismMessageID: "second", Text: "follow-up" });
  await assert.rejects(followUp(), { code: "dot_busy" });
  t.mock.timers.tick(9000);
  // Virtualization may remove the user row needed to associate an unlinked reply.
  const visible = [reply("visible", "A reply with no native request ID")];
  f.set(state({ messages: visible, approvalPending: true }));
  assert.equal((await f.adapter.readStatus(f.session)).approval_blocked, true);
  await assert.rejects(followUp(), { code: "dot_approval_pending" });
  f.set(state({ messages: visible, typing: true }));
  await assert.rejects(followUp(), { code: "dot_busy" });
  f.set(state({ messages: visible }));
  assert.equal((await f.adapter.readStatus(f.session)).status, "idle");
  assert.equal((await f.adapter.readStatus(f.session, first.NativeMessageID)).status, "unknown");
  assert.equal((await followUp()).NativeMessageID, "user-2");
  assert.equal(f.clicks(), 2);
});

test("Dot links a handoff by native request ID while preserving the message receipt ID", async () => {
  const f = fixture(state(), { async send(expected, text, markSubmitted) {
    const before = await f.backend.snapshot(expected);
    markSubmitted(before);
    f.set(state({ messages: [...before.messages, row("native-row", text, { requestID: "native-request" })] }));
  } });
  const receipt = await f.adapter.send(f.session, { PrismMessageID: "prism-2", Text: "hello" });
  assert.equal(receipt.NativeMessageID, "native-row");
  f.set(state({ messages: [...f.get().messages, reply("native-answer", "linked")],
    handoff: { requestID: "native-request", messageID: "native-answer", final: true } }));
  const completion = await f.adapter.waitForRun(f.session, receipt.NativeMessageID);
  assert.equal(completion.Type, "run.completed");
  assert.equal(completion.Payload.message_id, "native-answer");
});

test("a click with lost acknowledgement stays indeterminate and is never retried for the same ID", async () => {
  let clicks = 0;
  const f = fixture(state(), { async send(_scope, _text, markSubmitted) {
    markSubmitted(state());
    clicks += 1;
    throw new Error("connection closed after click");
  } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(f.adapter.send(f.session, { PrismMessageID: "p-1", Text: "hello" }), { code: "delivery_indeterminate" });
  }
  assert.equal(clicks, 1);
});

test("send confirmation survives a transient render gap and a replaced history tail", async () => {
  const initial = state();
  let submitted = false;
  let reads = 0;
  const f = fixture(initial, {
    async send(_scope, _text, markSubmitted) {
      markSubmitted(initial);
      submitted = true;
    },
    async snapshot() {
      if (!submitted) return initial;
      if (reads++ === 0) throw new Error("renderer is updating");
      return state({ messages: [
        row("old-duplicate", "hello"),
        row("fresh-confirmed", "hello", { createdAt: new Date().toISOString() }),
      ] });
    },
  });
  const receipt = await f.adapter.send(f.session, { PrismMessageID: "refresh-gap", Text: "hello" });
  assert.equal(receipt.NativeMessageID, "fresh-confirmed");
  assert.equal(reads, 2);
});

test("a persisted message in another room or target cannot satisfy the active send", async () => {
  const f = fixture(state(), { async send(_scope, text, markSubmitted) {
    markSubmitted(state());
    f.set(state({ targetID: "target-2", messages: [row("baseline", "Earlier message"), row("user-1", text)] }));
  } });
  await assert.rejects(f.adapter.send(f.session, { PrismMessageID: "p-1", Text: "hello" }), { code: "delivery_indeterminate" });
});

test("history is newest first, paginates only when necessary, and keeps linked replies together", async () => {
  const f = fixture(state({ history: { loaded: true, hasBefore: true } }), { async loadHistory(_scope, enough) {
    const page = state({ messages: [row("first", "question"), row("baseline", "Earlier message"), reply("answer", "answer", { replyTo: "first" })] });
    assert.equal(enough(page), true);
    return page;
  } });
  const records = await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 2 }));
  assert.deepEqual(records.map((record) => record.type), ["turn", "turn", "page_end", "end"]);
  assert.equal(records[0].turn.turn_id, "baseline");
  assert.deepEqual(records[1].turn.messages.map(({ ID }) => ID), ["first", "answer"]);
});

test("reopening Dot history keeps Codex foreground and only serves the verified binding's cached turns", async () => {
  const initial = state({ history: { loaded: true, hasBefore: true } });
  let dotForeground = true;
  let loading = false;
  let targetID = initial.targetID;
  let historyLoads = 0;
  const f = fixture(initial, {
    async sharedBinding() { return { ...initial, targetID }; },
    async snapshot(_expected, options = {}) {
      assert.notEqual(options.activate, true);
      if (!dotForeground) throw new Error("Codex foreground");
      if (loading) return state({ messages: [], history: { loaded: false } });
      return initial;
    },
    async loadHistory() {
      assert.equal(dotForeground, true);
      historyLoads += 1;
      return state({ messages: [row("older", "Older message"), ...initial.messages] });
    },
  });
  const initialPage = await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 2 }));
  dotForeground = false;
  const reopenedPage = await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 2 }));
  assert.deepEqual(reopenedPage, initialPage);
  assert.deepEqual(reopenedPage.filter(({ type }) => type === "turn").map(({ turn }) => turn.turn_id), ["baseline", "older"]);
  assert.equal(historyLoads, 1);
  assert.equal(dotForeground, false);

  dotForeground = true;
  loading = true;
  assert.deepEqual(await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 2 })), initialPage);
  dotForeground = false;
  targetID = "replaced-target";
  await assert.rejects(yieldAll(f.adapter.readHistoryStream(f.session, { limit: 2 })), { code: "dot_history_unavailable" });
  f.adapter.close();
});

test("a cold live history stream waits for selection on its original shared window", async (t) => {
  for (const outcome of ["selected", "cancelled", "adapter closed", "target replaced", "unbound"]) {
    await t.test(outcome, { timeout: 2000 }, async (t) => {
      const bound = state();
      const waiting = Promise.withResolvers();
      let targetID = bound.targetID;
      let bindingChecks = 0;
      let foreground = false;
      let passiveReads = 0;
      const f = fixture(bound, {
        async sharedBinding() {
          if (++bindingChecks === 2) waiting.resolve();
          return outcome === "unbound" ? null : { ...bound, targetID };
        },
        async snapshot(expected, { activate = false } = {}) {
          if (activate) foreground = true;
          else passiveReads++;
          if (!foreground || expected.targetID && expected.targetID !== targetID) throw Error("window unavailable");
          return { ...bound, targetID };
        },
      });
      t.after(() => f.adapter.close());
      const controller = new AbortController();
      const stream = f.adapter.readHistoryStream(f.session, { limit: 1, live: true }, controller.signal);
      const first = stream.next();
      if (outcome === "unbound") {
        await assert.rejects(first, { code: "dot_history_unavailable" });
        return;
      }
      await waiting.promise;
      const readsAtWait = passiveReads;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(passiveReads, readsAtWait);
      if (outcome === "cancelled") controller.abort();
      if (outcome === "adapter closed") f.adapter.close();
      if (outcome === "cancelled" || outcome === "adapter closed") {
        assert.equal((await first).done, true);
        return;
      }
      if (outcome === "target replaced") targetID = "replacement";
      await f.adapter.controlSession({ action: "conversation.select", session: f.session });
      if (outcome === "target replaced") {
        await assert.rejects(first, { code: "dot_history_unavailable" });
        return;
      }
      assert.equal((await first).value.turn.turn_id, "baseline");
      assert.equal((await stream.next()).value.type, "page_end");
      await stream.return();
    });
  }
});

test("wire dates are safe for Hub and detail timestamps use milliseconds", async () => {
  const f = fixture(state({ messages: [row("baseline", "Earlier message", { createdAt: "", updatedAt: "unknown" })] }));
  const [hint] = JSON.parse(JSON.stringify(await f.adapter.listSessions()));
  assert.equal(Object.hasOwn(hint, "LastActivityAt"), false);
  const [history] = JSON.parse(JSON.stringify(await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 1 }))));
  assert.equal(Object.hasOwn(history.turn.messages[0], "CreatedAt"), false);
  assert.equal(Object.hasOwn(history.turn.messages[0], "UpdatedAt"), false);
  const receipt = await f.adapter.send(f.session, { PrismMessageID: "p-date", Text: "hello" });
  const status = await f.adapter.readStatus(f.session, receipt.NativeMessageID);
  const detail = await f.adapter.readDetail(f.session);
  assert.equal(status.available, true);
  assert.equal(status.active, false);
  assert.equal(status.started_at, "2026-11-22T12:00:00.000Z");
  assert.equal(detail.run.started_at, Date.parse(status.started_at));
  assert.equal(detail.run.task_id, receipt.NativeMessageID);
  assert.equal(detail.approval, null);
});

test("watcher clears the old Dot detail and reconciles the directory when bound identity changes", async () => {
  const f = fixture();
  const watcher = f.adapter.subscribePlugin();
  const first = (await watcher.next()).value;
  assert.equal(first.Payload.detail_snapshot.desktop_foreground, true);
  const liveDetail = (await watcher.next()).value;
  assert.equal(liveDetail.Type, "desktop.state.changed");
  assert.equal(liveDetail.Payload.detail_snapshot.detail_stale, false);
  f.set(state({ dotID: "dot-2", roomID: "room-2", targetID: "target-2" }));
  const invalidation = (await watcher.next()).value;
  assert.equal(invalidation.Payload.native_session.native_session_id, first.Payload.native_session.native_session_id);
  assert.equal(invalidation.Payload.detail_snapshot.desktop_foreground, false);
  assert.equal(invalidation.Payload.detail_snapshot.approval, null);
  assert.equal(invalidation.Payload.detail_snapshot.run.task_id, "");
  assert.equal(invalidation.Payload.detail_snapshot.run.phase, null);
  assert.equal((await watcher.next()).value.Type, "desktop.session.directory.reconciled");
  const rebound = (await watcher.next()).value;
  assert.notEqual(rebound.Payload.native_session.native_session_id, first.Payload.native_session.native_session_id);
  assert.equal(rebound.Payload.detail_snapshot.desktop_foreground, true);
  await watcher.return();
});

test("watcher reverse-syncs new Dot rows without forwarding paginated or restored history", async () => {
  const old = row("older-message", "Historical user message", { createdAt: "2026-11-22T11:30:00Z" });
  const oldReply = reply("older-reply", "Historical Dot reply", { createdAt: "2026-11-22T11:30:10Z" });
  const anchor = row("anchor", "Already visible");
  const local = row("new-local", "Sent from the desktop", { createdAt: "2026-11-22T12:00:10Z" });
  const answer = reply("new-answer", "New Dot reply", { createdAt: "2026-11-22T12:00:10Z" });
  const latest = reply("newest", "New Dot reply after virtualized tail shifted", { createdAt: "2026-11-22T12:01:00Z" });
  const other = row("other-room-history", "Existing history from a rebound room", { createdAt: "2026-11-22T12:02:00Z" });
  const steps = [
    state({ messages: [], history: { loaded: false } }),
    state({ messages: [anchor] }),
    state({ messages: [old, oldReply, anchor] }),
    state({ messages: [old, oldReply] }), // Older page has lost the previous tail.
    new Error("Codex foreground"),
    state({ messages: [oldReply, anchor, local, answer] }),
    state({ messages: [oldReply, latest] }), // A fresh row arrives without the anchor.
    state({ messages: [old, oldReply, anchor, local, answer, latest] }),
    state({ roomID: "new-room", targetID: "new-target", messages: [other] }),
  ];
  let read = 0;
  const f = fixture(state(), { async snapshot() {
    const next = steps[read++];
    if (next instanceof Error) throw next;
    if (next) return next;
    f.adapter.close();
    return steps.at(-1);
  } });
  const events = await yieldAll(f.adapter.subscribePlugin());
  assert.deepEqual(events.filter(({ Type }) => Type.startsWith("message.")).map(({ Type, Payload }) => [Type, Payload.message_id]), [
    ["message.user.accepted", "new-local"],
    ["message.assistant.completed", "new-answer"],
    ["message.assistant.completed", "newest"],
  ]);
});

test("shared CDP endpoints use the managed Dot ID, not the first workspace URL", () => {
  const lease = { target_id: "dot", cdp_origin: "http://127.0.0.1:9999" };
  const codex = { id: "codex", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/codex" };
  const dot = { ...codex, id: "dot", webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/dot" };
  assert.equal(targetSocket(lease, [codex, dot]), dot.webSocketDebuggerUrl);
  assert.equal(targetSocket(lease, [codex]), "");
  assert.equal(targetSocket(lease, [codex, { ...dot, webSocketDebuggerUrl: "ws://example.com:9999/devtools/page/dot" }]), "");
});

test("desktop send waits for its submit button without refilling or reserving early", async (t) => {
  const calls = [];
  let preflights = 0;
  let fillResult = { previousDraft: "local draft", writtenDraft: "test\nmessage" };
  let failPreflight = false;
  let restoreCalls = 0;
  const lease = { phase: "ready", target_id: "target-1", dot_id: "dot-1", room_id: "room-1", cdp_origin: "http://127.0.0.1:9999" };
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => [{ id: "target-1", type: "page", url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/target-1" }] }));
  const backend = createDesktopBackend({
    CdpPageClient: class {
      async connectToPage() {}
      async evaluate(expression) {
        const [, phase] = expression.match(/\)\("([a-z_]+)"/u);
        calls.push(phase);
        if (phase === "inspect" || phase === "inspect_status") return state();
        if (phase === "fill") return fillResult;
        if (phase === "restore_draft") return restoreCalls++ === 0 ? "pending" : "restored";
        if (phase === "preflight" && failPreflight) return { stage: "draft_mismatch" };
        if (phase === "preflight" && preflights++ === 0) return { stage: "send_button_unavailable" };
        return true;
      }
      async close() {}
    },
    PluginAdapterError, readDotWindowLease: () => lease, withDesktopHostLock: (operation) => operation(),
  });
  const send = () => backend.send({ dotID: "dot-1", roomID: "room-1" }, "test\nmessage", () => calls.push("reserve"), () => calls.push("ready"));
  await send();
  assert.deepEqual(calls, ["inspect_status", "inspect", "ready", "fill", "preflight", "preflight", "reserve", "send", "restore_draft", "restore_draft"]);

  calls.length = 0;
  failPreflight = true;
  await assert.rejects(send(), { code: "dot_surface_changed", message: /preflight.+draft_mismatch/u });
  assert.deepEqual(calls, ["inspect_status", "inspect", "ready", "fill", "preflight", "restore_draft"]);

  calls.length = 0;
  fillResult = { stage: "draft_attachments" };
  await assert.rejects(send(), { code: "dot_surface_changed", message: /fill.+draft_attachments/u });
  assert.deepEqual(calls, ["inspect_status", "inspect", "ready", "fill"]);
});

test("desktop reads defer during a shared action and explicit selection retries with a fresh foreground check", async (t) => {
  let busy = true;
  let firstInspection = true;
  const phases = [];
  const lease = { phase: "ready", target_id: "target-1", dot_id: "dot-1", room_id: "room-1",
    workspace: "account-1", cdp_origin: "http://127.0.0.1:9999" };
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => [{ id: "target-1", type: "page", url: "app://-/index.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/target-1" }] }));
  const backend = createDesktopBackend({
    CdpPageClient: class {
      async connectToPage() {}
      async evaluate(script) {
        const [, phase] = script.match(/\)\("([a-z_]+)"/u);
        phases.push(phase);
        if (firstInspection) {
          firstInspection = false;
          throw new Error("CDP Runtime.evaluate timed out after 3500ms");
        }
        return { dotID: "dot-1", roomID: "room-1", workspace: "account-1", canSend: true, typing: false };
      }
      async close() {}
    },
    PluginAdapterError, readDotWindowLease: () => lease,
    withDesktopHostLock: (operation, { skipIfBusy } = {}) => busy && skipIfBusy ? undefined : operation(),
  });
  await assert.rejects(backend.snapshot(), { code: "desktop_host_busy" });
  assert.deepEqual(phases, []);
  busy = false;
  const foreground = await backend.snapshot({}, { activate: true, statusOnly: true });
  assert.equal(foreground.targetID, lease.target_id);
  assert.deepEqual(phases, ["inspect_status", "inspect_status"]);
});

test("a verified shared binding stays available while Codex is foreground", async () => {
  let dotForeground = true;
  let activations = 0;
  let binding = { dotID: "dot-1", roomID: "room-1", workspace: "account-1", targetID: "target-1" };
  const f = fixture(state(), {
    async sharedBinding() { return binding; },
    async snapshot(_expected, { activate = false } = {}) {
      if (activate) {
        activations++;
        dotForeground = true;
      }
      if (!dotForeground) throw new Error("Codex foreground");
      return state();
    },
  });
  const sessions = await f.adapter.listSessions();
  dotForeground = false;
  assert.equal((await f.adapter.probe()).Available, true);
  assert.equal((await f.adapter.discover()).Verified, true);
  assert.deepEqual(await f.adapter.listSessions(), sessions);
  assert.equal(activations, 0);
  assert.equal((await f.adapter.attachSession(f.session)).NativeSessionID, f.session.NativeSessionID);
  assert.equal(activations, 1);

  dotForeground = false;
  binding = { dotID: "dot-2", roomID: "room-2", targetID: "target-2" };
  await assert.rejects(f.adapter.listSessions(), /Codex foreground/);
  binding = null;
  assert.equal((await f.adapter.probe()).Available, false);
});

test("first selection preserves history if the shared window changes before subscription", async () => {
  const bound = state();
  let foreground = false;
  const f = fixture(bound, {
    async sharedBinding() { return bound; },
    async snapshot(_scope, { activate, statusOnly } = {}) {
      if (activate) foreground = true;
      if (!foreground) throw Error("other agent foreground");
      return statusOnly ? { ...bound, messages: undefined } : bound;
    },
  });
  await f.adapter.controlSession({ action: "conversation.select", session: f.session });
  foreground = false;
  const page = await yieldAll(f.adapter.readHistoryStream(f.session, { limit: 1 }));
  assert.equal(page[0].turn.turn_id, "baseline");
});

test("a restarted adapter lists one pinned main session from the verified binding", async () => {
  const bound = state();
  const { dotID, roomID, workspace, targetID } = bound;
  const f = fixture(bound, {
    async sharedBinding() { return { dotID, roomID, workspace, targetID }; },
    async snapshot() { throw new Error("Codex foreground"); },
  });
  const sessions = await f.adapter.listSessions();
  assert.equal(sessions.length, 1);
  const [main] = sessions;
  assert.equal(main.NativeSessionID, f.session.NativeSessionID);
  assert.equal(main.NativeThreadID, f.session.NativeThreadID);
  assert.equal(main.Title, "Dot 主会话");
  assert.deepEqual(main.Metadata, { session_kind: "dot_main", group_label: "主会话", can_send: "true", pinned: "true" });
  assert.equal(main.Active, false);
});

test("a stale ready lease preserves only the pinned directory and remote contract after restart", async () => {
  const id = nativeSession(state({ roomID: "room:1" })).NativeSessionID;
  const ready = { phase: "ready", shared_window: true, binding: id };
  let saved = ready;
  const backend = createDesktopBackend({ PluginAdapterError, withDesktopHostLock: (operation) => operation(),
    readDotWindowLease: ({ requireLive = true } = {}) => requireLive ? null : saved });
  const adapter = createDotAdapter({ backend, PluginAdapterError, settings: { pollMs: 1 } });
  const capabilities = await adapter.probe();
  assert.equal(capabilities.Available, false);
  assert.equal(capabilities.NativeVisibleInput, false);
  assert.equal(capabilities.NativeVisibleOutput, false);
  assert.equal((await adapter.discover()).Verified, false);
  for (const name of ["CanAttachSession", "CanListSessions", "CanReadHistory", "CanForwardSync", "CanWaitRun"]) {
    assert.equal(capabilities[name], true, name);
  }
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  const [main] = sessions;
  assert.equal(main.NativeSessionID, id);
  assert.equal(main.NativeThreadID, id);
  assert.equal(main.Active, false);
  assert.equal(main.Metadata.pinned, "true");
  assert.equal(main.Metadata.can_send, "false");
  assert.equal((await adapter.readStatus(main)).available, false);
  await assert.rejects(yieldAll(adapter.readHistoryStream(main, { limit: 1 })), { code: "dot_history_unavailable" });
  await assert.rejects(adapter.attachSession(main), { code: "dot_window_unavailable" });
  await assert.rejects(adapter.send(main, { Text: "unavailable", PrismMessageID: "new" }), { code: "dot_window_unavailable" });

  for (saved of [null, { ...ready, phase: "opening" }, { ...ready, shared_window: false }, { ...ready, binding: "dot:x::" }]) {
    const unbound = await adapter.probe();
    assert.equal(unbound.CanListSessions, false);
    assert.equal(unbound.CanForwardSync, false);
    await assert.rejects(adapter.listSessions(), { code: "dot_window_unavailable" });
  }
});

test("published SDK transport sends typed indeterminate errors and compatible v4 fields", async () => {
  const input = new PassThrough();
  const destination = new PassThrough();
  const packets = [];
  destination.on("data", (chunk) => packets.push(JSON.parse(chunk.toString())));
  const f = fixture(state(), { async send(_scope, _text, markSubmitted) {
    markSubmitted(state());
    throw new Error("connection closed");
  } });
  const server = createStdioServer(f.adapter, input, compatibleOutput(destination));
  const running = server.run();
  input.end(`${JSON.stringify({ id: "status", method: "adapter.readStatus", params: { session: { native_session_id: f.session.NativeSessionID } } })}\n` +
    `${JSON.stringify({ id: "send", method: "adapter.send", params: { session: { native_session_id: f.session.NativeSessionID }, message: { prism_message_id: "pm-1", text: "hello" } } })}\n`);
  await running;
  assert.equal(packets.find((packet) => packet.id === "status").payload.interruptible, false);
  assert.equal(packets.find((packet) => packet.id === "send").error.code, "delivery_indeterminate");
});
