"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { createHash } = require("node:crypto");

const MAX_HISTORY = 20;
const HISTORY_READY_ATTEMPTS = 16;
const HISTORY_RECHECK_MS = 15000;
// Cover the gap between a native receipt and the first typing indication.
const REPLY_START_GRACE_MS = 8000;
const HISTORY_FAILURE = "The native Dot history could not be read for the bound conversation.";
const DELIVERY_UNCONFIRMED = "Dot delivery is unconfirmed. Check the native conversation before sending again.";
const MAIN_SESSION_TITLE = "Dot 主会话";
const MAIN_SESSION_METADATA = Object.freeze({ session_kind: "dot_main", group_label: "主会话", can_send: "true", pinned: "true" });
const toText = (value) => typeof value === "string" ? value : "";
const normalize = (value) => toText(value).replace(/\r\n?/g, "\n").trim();
const historyReady = (state) => Boolean(state && (state.messages.length || state.history.loaded && !state.history.failed));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const scopeKey = ({ dotID, roomID, workspace }) => [dotID, roomID, workspace || ""].map(encodeURIComponent).join(":");
const millis = (value) => {
  const timestamp = Date.parse(toText(value));
  return Number.isFinite(timestamp) ? timestamp : undefined;
};
const wireDate = (value) => {
  const timestamp = millis(value);
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
};
function unavailableDetail() {
  return { desktop_foreground: false, detail_stale: true, run: { status: "unavailable", available: false, active: false, interruptible: false, approval_blocked: false,
    approval_request_id: "", task_id: "", phase: null }, approval: null };
}

function nativeSession(state) {
  const key = `dot:${scopeKey(state)}`;
  return {
    PluginID: "dot", NativeSessionID: key, NativeThreadID: key, Surface: "chatgpt-dot-desktop",
    Endpoint: "codex://dots", Cwd: "", Visible: true,
  };
}

function scopeFor(session, error) {
  const sessionKey = session?.NativeSessionID || session?.NativeThreadID;
  const threadKey = session?.NativeThreadID;
  if (sessionKey && (!threadKey || threadKey === sessionKey)) {
    const [prefix, ...parts] = sessionKey.split(":");
    if (prefix === "dot" && parts.length === 3) {
      try {
        const [dotID, roomID, workspace] = parts.map(decodeURIComponent);
        if (dotID && roomID) return { dotID, roomID, workspace };
      } catch {}
    }
  }
  throw error("dot_session_invalid", "The request does not identify a bound Dot conversation.");
}

function messageEntry(row) {
  return {
    ID: row.id, Role: row.dot ? "assistant" : row.role, Type: "text", Content: row.text,
    Status: "completed", CreatedAt: wireDate(row.createdAt), UpdatedAt: wireDate(row.updatedAt) || wireDate(row.createdAt),
  };
}

function historyTurns(rows, run, typing = false) {
  const turns = new Map();
  let current = null;
  for (const row of rows) {
    if (!row.confirmed || row.external || row.taskUpdate || row.replyRoot || row.role === "system") continue;
    if (row.role === "user" && !row.dot) {
      current = { turn_id: row.id, order_key: `${wireDate(row.createdAt) || ""}:${row.id}`, messages: [messageEntry(row)] };
      turns.set(row.id, current);
    } else if (row.dot && current) {
      const turn = row.replyTo ? turns.get(row.replyTo) : current;
      if (turn) turn.messages.push(messageEntry(row));
    }
  }
  if (run?.observedProgress && turns.has(run.runID) && !run.timedOut && (run.final || typing || awaitingReplyStart(run))) {
    const turn = turns.get(run.runID);
    const final = run.final;
    const status = final ? "completed" : "running";
    const progress = {
      ID: `${run.runID}:progress`, Role: "assistant", Type: "progress", Status: status,
      CreatedAt: wireDate(run.startedAt), UpdatedAt: wireDate(final?.createdAt) || wireDate(run.startedAt),
      Content: "", Progress: { Status: status, StartedAt: wireDate(run.startedAt),
        CompletedAt: wireDate(final?.createdAt), Steps: [] },
    };
    const [user, ...visible] = turn.messages;
    if (final && !visible.some((entry) => entry.ID === final.id)) visible.push(messageEntry(final));
    turn.messages = [user, progress, ...visible];
  }
  return [...turns.values()];
}

function newRows(state, previousIDs, anchorID) {
  const anchor = anchorID ? state.messages.findIndex((row) => row.id === anchorID) : -1;
  if (anchorID && anchor < 0) return [];
  return state.messages.slice(anchor + 1).filter((row) => !previousIDs.has(row.id));
}

function reverseSyncRows(state) {
  return state.messages.filter((row) => row.confirmed && !row.external && !row.taskUpdate && !row.replyRoot && (row.dot || row.self));
}

function acceptedRow(state, initial, text, submittedAt) {
  const previousIDs = new Set(initial.messages.map((row) => row.id));
  const anchorID = initial.messages.at(-1)?.id;
  // Virtualized history can replace the old tail after sending. In that case
  // require a newly observed, natively timestamped row from this send window.
  const rows = anchorID && !state.messages.some((row) => row.id === anchorID) ?
    state.messages.filter((row) => !previousIDs.has(row.id) && millis(row.createdAt) >= submittedAt - 1000) :
    newRows(state, previousIDs, anchorID);
  const newSelf = rows.filter((row) => row.self && row.confirmed && !row.external && !row.taskUpdate && !row.replyRoot);
  return newSelf.length === 1 && normalize(newSelf[0].text) === normalize(text) ? newSelf[0] : null;
}

function matchesHandoff(run, handoff) {
  return Boolean(handoff?.requestID && (handoff.requestID === run.runID || handoff.requestID === run.requestID));
}

function awaitingReplyStart(run) {
  return Boolean(run && !run.final && !run.timedOut && !run.followUpReady && Date.now() < run.replyStartDeadline);
}

function linkedReply(run, state) {
  if (state.handoff?.final && matchesHandoff(run, state.handoff) && state.handoff.messageID) {
    run.handoffID = state.handoff.messageID;
  }
  const rows = newRows(state, run.previousIDs, run.runID);
  const matches = rows.filter((row) => row.confirmed && row.dot && !row.external && !row.taskUpdate &&
    (row.replyTo === run.runID || row.id === run.handoffID));
  return matches.length === 1 ? matches[0] : null;
}

function canFollowUp(run, state) {
  if (state.typing || state.approvalPending) return false;
  const latestUserMessage = state.messages.findLast((row) => row.role === "user" && !row.dot && !row.external && !row.taskUpdate && !row.replyRoot);
  if (!latestUserMessage?.self || !latestUserMessage.confirmed || latestUserMessage.id !== run.runID) return false;
  return newRows(state, run.previousIDs, run.runID).some((row) => row.confirmed && row.dot && !row.external &&
    !row.taskUpdate && !row.replyRoot && (!row.replyTo || row.replyTo === run.runID) && normalize(row.text));
}

function event(type, status, id, summary, payload = {}) {
  return { ID: id, Type: type, Status: status, Summary: summary, Payload: payload, CreatedAt: new Date().toISOString() };
}

function createDotAdapter({ backend, PluginAdapterError, ledger, settings = {} }) {
  const failure = (code, detail) => new PluginAdapterError(code, detail);
  const pollMs = settings.pollMs ?? 850;
  const deliveryMs = settings.deliveryMs ?? 8000;
  const waitMs = settings.waitMs ?? 14 * 60 * 1000;
  const closed = new AbortController();
  const sending = new Set();
  const requests = new Map();
  const runs = new Map();
  let lastDirectory;
  let lastHistory;
  let waitingForHistory;

  function remember(table, key, value) {
    table.delete(key);
    table.set(key, value);
    while (table.size > 160) table.delete(table.keys().next().value);
  }

  function observe(state) {
    const key = scopeKey(state);
    for (const run of runs.values()) {
      if (run.scopeKey !== key || run.targetID !== state.targetID || run.final || run.timedOut) continue;
      if (matchesHandoff(run, state.handoff) || state.typing && state.messages.findLast((row) => row.self)?.id === run.runID) {
        run.observedProgress = true;
      }
      const final = linkedReply(run, state);
      if (final) run.final = final;
      // The native transcript can show a reply without a request ID. A newer
      // idle transcript can unblock sending while completion still needs a link.
      if (!run.followUpReady && canFollowUp(run, state)) run.followUpReady = true;
    }
    return state;
  }

  function snapshot(scope = {}, options) {
    return backend.snapshot(scope, options).then((state) => {
      if (options?.statusOnly) return state;
      observe(state);
      if (historyReady(state)) {
        lastHistory = state;
        waitingForHistory?.abort();
        waitingForHistory = undefined;
      }
      lastDirectory = { scope: scopeKey(state), targetID: state.targetID, session: mainSessionHint(state) };
      return state;
    });
  }

  async function runtimeAvailable() {
    // The lease establishes readiness even when Codex is foreground. Commands
    // still prove the exact Dot surface under the shared lock.
    if (await backend.sharedBinding?.()) return true;
    return Boolean(await snapshot().catch(() => null));
  }

  function mainSessionHint(state) {
    return { ...nativeSession(state), Title: MAIN_SESSION_TITLE, Active: Boolean(state.messages),
      LastActivityAt: wireDate(state.messages?.at(-1)?.createdAt), PrismConversationID: "", Metadata: MAIN_SESSION_METADATA };
  }

  function enrichRun(run) {
    if (!run?.final) return null;
    return event("run.completed", "completed", `${run.runID}:completed`, "Dot replied in its native conversation.", {
      native_run_id: run.runID, run_id: run.runID, message_id: run.final.id, text: run.final.text, role: "assistant",
    });
  }

  function timedOut(runID, reason) {
    return event("run.wait_timeout", "running", `${runID}:unconfirmed`, reason, { native_run_id: runID, run_id: runID, timeout_fallback: true });
  }

  function lastRun(state) {
    return [...runs.values()].reverse().find((run) => run.scopeKey === scopeKey(state) && run.targetID === state.targetID);
  }

  function runStatus(state, run = lastRun(state), requestedRun = false) {
    const active = Boolean(state.typing && (!requestedRun || run && !run.final && run === lastRun(state)));
    const status = active ? "running" : run?.final ? "completed" :
      run && (requestedRun || awaitingReplyStart(run)) ? "unknown" : "idle";
    return { status, available: true, active,
      phase: status === "unknown" ? { id: "completion_unconfirmed" } : undefined,
      interruptible: false, approval_blocked: Boolean(state.approvalPending), turn_id: run?.runID,
      started_at: wireDate(run?.startedAt), completed_at: wireDate(run?.final?.createdAt) };
  }

  function detailFor(state) {
    const run = runStatus(state);
    return { desktop_foreground: true, detail_stale: false,
      run: { ...run, task_id: run.turn_id || "", approval_request_id: "", phase: run.phase || null,
        started_at: millis(run.started_at), completed_at: millis(run.completed_at) }, approval: null };
  }

  async function* watch(scope, signal, wholePlugin) {
    const stop = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
    let previousScope = "";
    let previousTarget = "";
    let wasUnavailable = false;
    let directoryEpoch = 0;
    let messageFrontier = null;
    let sessionSignature;
    let publishedSession;
    function invalidate() {
      const native = publishedSession;
      publishedSession = undefined;
      sessionSignature = undefined;
      if (!native) return null;
      return event("session.info", "unavailable", `dot-session-unavailable:${digest([native.native_session_id, directoryEpoch])}`,
        "The managed Dot conversation is unavailable.", { native_session: native, detail_snapshot: unavailableDetail() });
    }
    while (!stop.aborted) {
      let state;
      let recovered = false;
      try {
        state = await snapshot(scope);
        recovered = wasUnavailable;
        wasUnavailable = false;
      } catch (error) {
        if (error?.code === "desktop_host_busy") {
          await delay(pollMs, undefined, { signal: stop }).catch(() => {});
          continue;
        }
        if (!wasUnavailable) {
          if (wholePlugin && publishedSession) {
            directoryEpoch += 1;
            yield invalidate();
          } else if (!wholePlugin) {
            yield event("subscription.error", "unavailable", "dot-window-unavailable", "The managed Dot window is unavailable.", { code: "dot_window_unavailable" });
          }
        }
        wasUnavailable = true;
      }
      if (state) {
        const key = scopeKey(state);
        const changed = Boolean(previousScope && (key !== previousScope || state.targetID !== previousTarget));
        if (wholePlugin && (changed || recovered)) {
          directoryEpoch += 1;
          const unavailable = invalidate();
          if (unavailable) yield unavailable;
          yield event("desktop.session.directory.reconciled", "ready", `dot-directory:${digest([key, directoryEpoch])}`,
            "The native Dot conversation directory changed.");
        }
        if (key !== previousScope || state.targetID !== previousTarget) {
          messageFrontier = null;
          previousScope = key;
          previousTarget = state.targetID;
        }
        const native = nativeSession(state);
        const nativePayload = { plugin_id: "dot", native_session_id: native.NativeSessionID, native_thread_id: native.NativeThreadID,
          surface: native.Surface, endpoint: native.Endpoint, title: MAIN_SESSION_TITLE, active: true, visible: true,
          metadata: MAIN_SESSION_METADATA };
        if (wholePlugin) {
          const hint = mainSessionHint(state);
          const detail = detailFor(state);
          const sessionHint = { ...nativePayload, active: hint.Active, last_activity_at: hint.LastActivityAt };
          const signature = `dot-session:${digest([sessionHint, detail])}`;
          if (signature !== sessionSignature) {
            sessionSignature = signature;
            publishedSession = nativePayload;
            yield event("session.info", "ready", signature, "Dot conversation is available.", {
              native_session: nativePayload, session_hint: sessionHint, detail_snapshot: detail,
            });
            yield event("desktop.state.changed", detail.run.status, `dot-detail:${signature}`,
              "Dot desktop state changed.", { native_session: nativePayload, detail_snapshot: detail });
          }
        }
        if (wholePlugin && !sending.has(key)) {
          const rows = reverseSyncRows(state);
          const baseline = messageFrontier === null;
          if (baseline && (state.history.loaded || rows.length)) {
            messageFrontier = { since: Date.now(), id: "", time: undefined, seen: new Set() };
          }
          if (messageFrontier) {
            const anchor = rows.findIndex((row) => row.id === messageFrontier.id);
            // Pagination and virtualization reveal unseen old DOM rows. Only
            // publish after our last row or past its native creation watermark.
            const candidates = baseline ? rows : anchor >= 0 ? rows.slice(anchor + 1) :
              rows.filter((row) => millis(row.createdAt) > (messageFrontier.time ?? messageFrontier.since));
            for (const row of candidates) {
              if (messageFrontier.seen.has(row.id)) continue;
              messageFrontier.seen.add(row.id);
              if (messageFrontier.seen.size > 1000) messageFrontier.seen.delete(messageFrontier.seen.values().next().value);
              messageFrontier.id = row.id;
              const time = millis(row.createdAt);
              if (time !== undefined && (messageFrontier.time === undefined || time > messageFrontier.time)) messageFrontier.time = time;
              if (baseline) continue;
              const run = [...runs.values()].find((candidate) => candidate.scopeKey === key &&
                (candidate.runID === row.id || candidate.final?.id === row.id));
              if (!run) yield event(row.dot ? "message.assistant.completed" : "message.user.accepted", "completed", `dot-message:${digest([row.id, row.updatedAt, row.text])}`,
                "Dot conversation changed.", { native_session: nativePayload, message_id: row.id, role: row.dot ? "assistant" : "user", text: row.text });
            }
          }
        }
      }
      await delay(pollMs, undefined, { signal: stop }).catch(() => {});
    }
  }

  const adapter = {
    id: () => "dot",

    async probe() {
      const available = await runtimeAvailable();
      const bound = available || Boolean(await backend.savedSession?.());
      return {
        PluginID: "dot", Available: available, IntegrationMode: "desktop-automation", VisibilitySurface: "chatgpt-dot-desktop",
        NativeVisibleInput: available, NativeVisibleOutput: available,
        CanAttachSession: bound, CanStartSessionWithMessage: false, CanOpenDraft: false,
        CanListSessions: bound, CanReadHistory: bound, CanForwardSync: bound,
        CanReverseSync: bound, CanPluginWideWatch: true, CanWaitRun: bound, CanReadStatus: bound,
        CanInterrupt: false, CanApproval: false, CanControlSession: bound,
        UnavailableReason: available ? "" : "The managed Dot window is unavailable.",
      };
    },

    async discover() {
      const available = await runtimeAvailable();
      return { PluginID: "dot", Surface: "chatgpt-dot-desktop", Endpoint: "codex://dots", ProcessID: 0,
        Verified: available, Detail: available ? "Verified the managed Dot binding." : "Managed Dot window unavailable.", SessionHints: {} };
    },

    async listSessions() {
      try {
        return [mainSessionHint(await snapshot())];
      } catch (error) {
        const binding = await backend.sharedBinding?.();
        if (binding?.dotID && binding.roomID && typeof binding.workspace === "string") {
          if (lastDirectory?.scope === scopeKey(binding) && lastDirectory.targetID === binding.targetID) return [lastDirectory.session];
          return [mainSessionHint(binding)];
        }
        const saved = await backend.savedSession?.();
        if (!saved) throw error;
        return [{ ...mainSessionHint(saved), Metadata: { ...MAIN_SESSION_METADATA, can_send: "false" } }];
      }
    },

    async attachSession(request) {
      const scope = scopeFor(request, failure);
      return nativeSession(await snapshot(scope, { activate: true, statusOnly: true }));
    },

    async controlSession(request) {
      if (request.action === "desktop.bind" && request.session?.PluginID === "dot" &&
          !request.session.NativeSessionID && !request.session.NativeThreadID && request.target?.shared_window === true) {
        const state = await backend.bindWindow(request.target);
        return { ok: true, action: request.action, thread_id: nativeSession(state).NativeSessionID };
      }
      if (request.action !== "conversation.select") throw failure("dot_control_unavailable", "Dot only supports conversation selection.");
      const scope = scopeFor(request.session, failure);
      // Capture the first verified transcript while selection owns the window.
      // A later passive history request may arrive after another agent takes focus.
      const binding = lastHistory && await backend.sharedBinding?.();
      const cached = Boolean(binding && lastHistory.targetID === binding.targetID && scopeKey(lastHistory) === scopeKey(scope));
      const state = await snapshot(scope, { activate: true, statusOnly: cached });
      return { ok: true, action: request.action, details_confirmed: true, details: detailFor(state) };
    },

    async send(session, message) {
      const scope = scopeFor(session, failure);
      if (message.Attachments?.length) throw failure("dot_attachments_unavailable", "Dot attachment sending is unavailable.");
      const requestID = toText(message.PrismMessageID);
      const text = normalize(message.Text);
      if (!requestID || !text || text.length > 32000) throw failure("dot_message_invalid", "The Dot message is empty or exceeds the supported size.");
      const key = scopeKey(scope);
      const requestKey = `${key}:${requestID}`;
      const saved = ledger?.lookup(key, requestID);
      if (saved?.runID) return { NativeMessageID: saved.runID, Accepted: true, Visible: true, Detail: "Previously confirmed the native Dot message." };
      if (saved?.reserved) throw failure("delivery_indeterminate", DELIVERY_UNCONFIRMED);
      const existing = requests.get(requestKey);
      if (existing?.receipt) return existing.receipt;
      if (existing) throw failure("delivery_indeterminate", DELIVERY_UNCONFIRMED);
      if (sending.has(key)) throw failure("dot_busy", "Dot is still accepting another Prism message.");
      sending.add(key);
      let initial;
      let submittedAt;
      let unconfirmedReason = "no matching native message";
      try {
        try {
          await backend.send(scope, text, (state) => {
            if (closed.signal.aborted) throw failure("dot_send_unavailable", "The Dot adapter is closing.");
            if (ledger && !ledger.reserve(key, requestID)) throw failure("delivery_indeterminate", DELIVERY_UNCONFIRMED);
            initial = state;
            submittedAt = Date.now();
            remember(requests, requestKey, { submitted: true });
          }, (state) => {
            observe(state);
            if (state.approvalPending) throw failure("dot_approval_pending", "An approval is pending in the native Dot conversation.");
            if (state.typing) throw failure("dot_busy", "Dot is still replying in the native conversation.");
            if ([...runs.values()].some((run) => run.scopeKey === key && awaitingReplyStart(run))) {
              throw failure("dot_busy", "Dot just accepted the previous message. Please retry in a moment.");
            }
          });
        } catch (error) {
          if (!initial) throw error;
          unconfirmedReason = "submit acknowledgement unavailable";
        }
        if (!initial) throw failure("dot_send_unavailable", "The native Dot action could not be verified.");
        const deadline = Date.now() + deliveryMs;
        while (Date.now() < deadline && !closed.signal.aborted) {
          const state = await snapshot({ ...scope, targetID: initial.targetID }).catch(() => null);
          const row = state && acceptedRow(state, initial, text, submittedAt);
          if (row) {
            unconfirmedReason = "native receipt could not be recorded";
            if (ledger && !ledger.confirm(key, requestID, row.id)) break;
            const receipt = { NativeMessageID: row.id, Accepted: true, Visible: true, Detail: "Confirmed the native Dot message." };
            const run = { runID: row.id, requestID: row.requestID, scopeKey: key, targetID: state.targetID, startedAt: wireDate(row.createdAt) || new Date().toISOString(),
              previousIDs: new Set(initial.messages.map((item) => item.id)), replyStartDeadline: submittedAt + REPLY_START_GRACE_MS, observedProgress: false };
            remember(runs, `${key}:${run.runID}`, run);
            observe(state);
            remember(requests, requestKey, { receipt });
            return receipt;
          }
          await delay(Math.min(pollMs, 200));
        }
      } catch (error) {
        if (!initial) throw error;
      } finally {
        sending.delete(key);
      }
      process.stderr.write(`[dot] Unconfirmed delivery: ${unconfirmedReason}\n`);
      throw failure("delivery_indeterminate", DELIVERY_UNCONFIRMED);
    },

    subscribe(session, signal) { return watch(scopeFor(session, failure), signal, false); },
    subscribePlugin(signal) { return watch({}, signal, true); },

    async waitForRun(session, runID) {
      const scope = scopeFor(session, failure);
      const run = runs.get(`${scopeKey(scope)}:${runID}`);
      if (!run) return timedOut(runID, "The Dot request could not be matched to a native run.");
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && !closed.signal.aborted) {
        const completion = enrichRun(run);
        if (completion) return completion;
        await snapshot({ ...scope, targetID: run.targetID }).catch(() => {});
        if (!run.final) await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), undefined, { signal: closed.signal }).catch(() => {});
      }
      if (run.final) return enrichRun(run);
      run.timedOut = true;
      return timedOut(runID, "The native Dot reply could not be confirmed for this request.");
    },

    async readStatus(session, runID) {
      const scope = scopeFor(session, failure);
      const state = await snapshot(scope).catch(() => null);
      if (!state) return { status: "unavailable", available: false, active: false, interruptible: false, approval_blocked: false };
      return runID ? runStatus(state, runs.get(`${scopeKey(scope)}:${runID}`) || null, true) : runStatus(state);
    },

    async *readHistoryStream(session, request, signal) {
      const scope = scopeFor(session, failure);
      const stop = signal ? AbortSignal.any([signal, closed.signal]) : closed.signal;
      const limit = Math.max(1, Math.min(MAX_HISTORY, Math.floor(Number(request.limit) || 5)));
      let state;
      let target = scope;
      let fromCache = false;
      const key = scopeKey(scope);
      // Panel may subscribe or reconnect while Codex owns the common window.
      // Let explicit selection change the surface and keep history reads passive.
      for (let attempt = 1; !stop.aborted; attempt++) {
        state = await snapshot(target).catch(() => null);
        if (state) target = { ...scope, targetID: state.targetID };
        if (historyReady(state)) break;
        const waiting = attempt >= HISTORY_READY_ATTEMPTS;
        if (lastHistory || request.live && (attempt === 1 || waiting)) {
          const binding = await backend.sharedBinding?.();
          if (binding?.targetID && scopeKey(binding) === key && (!target.targetID || binding.targetID === target.targetID)) {
            target = { ...scope, targetID: binding.targetID };
            const cached = lastHistory;
            if (cached?.targetID === target.targetID && scopeKey(cached) === key) {
              state = cached;
              fromCache = true;
              break;
            }
            if (request.live && waiting && !state?.history.failed) {
              // Selection or a watcher can supply the first transcript. If neither
              // runs, periodically check that the same binding still exists.
              waitingForHistory ??= new AbortController();
              const wake = AbortSignal.any([stop, waitingForHistory.signal]);
              await delay(HISTORY_RECHECK_MS, undefined, { signal: wake }).catch(() => {});
              continue;
            }
          }
        }
        if (waiting) break;
        await delay(Math.min(pollMs, 250), undefined, { signal: stop }).catch(() => {});
      }
      if (stop.aborted) return;
      if (!historyReady(state)) throw failure("dot_history_unavailable", HISTORY_FAILURE);
      if (!fromCache && state.history.hasBefore && historyTurns(state.messages).length < limit) {
        const older = await backend.loadHistory(target, (page) => historyTurns(page.messages).length >= limit, stop).catch(() => null);
        if (historyReady(older)) state = observe(older);
      }
      if (stop.aborted) return;
      if (!fromCache) lastHistory = state;
      const revisions = new Map();
      function changes(current, source) {
        const visible = historyTurns(current.messages, lastRun(current), current.typing).slice(-limit);
        if (source === "initial") visible.reverse();
        return visible.flatMap((turn) => {
          const previous = revisions.get(turn.turn_id);
          const signature = digest(turn.messages);
          if (signature === previous?.signature) return [];
          const revision = (previous?.revision || 0) + 1;
          remember(revisions, turn.turn_id, { signature, revision });
          return [{ type: "turn", source, operation: previous ? "replace" : "append", turn: { ...turn, revision } }];
        });
      }
      yield* changes(state, "initial");
      yield { type: "page_end" };
      if (request.live) {
        while (!stop.aborted) {
          await delay(pollMs, undefined, { signal: stop }).catch(() => {});
          if (stop.aborted) break;
          const next = await snapshot(target).catch(() => null);
          if (historyReady(next)) {
            const updates = changes(next, "live");
            if (updates.length) lastHistory = next;
            yield* updates;
          }
        }
      }
      yield { type: "end" };
    },

    async readDetail(session) {
      const scope = scopeFor(session, failure);
      const state = await snapshot(scope).catch(() => null);
      return state ? detailFor(state) : unavailableDetail();
    },

    async interrupt() {
      throw failure("dot_interrupt_unavailable", "Dot does not support remote interruption.");
    },

    async verifyVisibility(session, marker) {
      const scope = scopeFor(session, failure);
      const state = await snapshot(scope).catch(() => null);
      const token = toText(marker);
      const visible = Boolean(token && state?.messages.some((row) => row.confirmed && (row.id === token || row.text.includes(token))));
      return { Visible: visible, Marker: token, Evidence: visible ? "native-dot-conversation" : "", CheckedAt: new Date().toISOString(),
        FailureReason: visible ? "" : "The message could not be confirmed in the native Dot conversation." };
    },

    close() { closed.abort(); ledger?.close(); },
  };
  return adapter;
}

module.exports = { createDotAdapter, nativeSession };
