"use strict";

const { setTimeout: delay } = require("node:timers/promises");
const { expression } = require("./surface.cjs");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SEND_ACTIONS = new Set(["fill", "preflight", "send"]);
const SEND_FAILURE_STAGES = new Set(["editor_unavailable", "reply_in_progress", "draft_attachments", "editor_not_focused",
  "insertion_rejected", "draft_mismatch", "send_button_unavailable"]);

function targetSocket(lease, targets) {
  const origin = new URL(lease.cdp_origin);
  if (origin.protocol !== "http:" || !LOOPBACK.has(origin.hostname)) return "";
  const matches = targets.filter((target) => target.id === lease.target_id && target.type === "page" &&
    /^app:\/\/-\/index\.html(?:\?|$)/u.test(target.url || ""));
  if (matches.length !== 1 || !matches[0].webSocketDebuggerUrl) return "";
  const socket = new URL(matches[0].webSocketDebuggerUrl);
  if (socket.protocol !== "ws:" || !LOOPBACK.has(socket.hostname) || socket.port !== origin.port ||
      socket.pathname !== `/devtools/page/${lease.target_id}` || socket.username || socket.password) return "";
  return socket.href;
}

function createDesktopBackend({ CdpPageClient, PluginAdapterError, readDotWindowLease, navigateToDot, withDesktopHostLock }) {
  const fail = (code, message) => new PluginAdapterError(code, message);

  function boundIdentity(binding) {
    if (typeof binding !== "string") return {};
    const [prefix, ...parts] = binding.split(":");
    if (prefix !== "dot" || parts.length !== 3) throw fail("dot_session_invalid", "Invalid saved Dot binding.");
    const [dot_id, room_id, workspace] = parts.map(decodeURIComponent);
    if (!dot_id || !room_id) throw fail("dot_session_invalid", "Incomplete saved Dot binding.");
    return { dot_id, room_id, workspace };
  }

  async function currentLease() {
    const saved = await readDotWindowLease();
    const lease = saved?.binding ? { ...saved, ...boundIdentity(saved.binding) } : saved;
    if (lease?.phase !== "ready" || !lease.dot_id) throw fail("dot_window_unavailable", "The managed Dot window is unavailable.");
    return lease;
  }

  async function rendererSocket(lease) {
    const origin = new URL(lease.cdp_origin);
    if (origin.protocol !== "http:" || !LOOPBACK.has(origin.hostname) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw fail("dot_window_unavailable", "The managed Dot endpoint is invalid.");
    const response = await fetch(new URL("/json/list", origin), { signal: AbortSignal.timeout(1500), redirect: "error" });
    const targets = response.ok ? await response.json() : [];
    const webSocket = Array.isArray(targets) && targetSocket(lease, targets);
    if (!webSocket) throw fail("dot_window_unavailable", "The managed Dot renderer is unavailable.");
    return webSocket;
  }

  async function rendererCommand(stage, operation) {
    try {
      return await operation();
    } catch (error) {
      if (!/^CDP .* (?:timed out|closed)|^CDP socket is not open/u.test(error?.message || "")) throw error;
      throw fail("dot_renderer_unresponsive", `The managed Dot renderer did not respond (${stage}).`);
    }
  }

  async function withPage(operation, expected = {}, { activate = false, statusOnly = false, lease: pinnedLease, binding = false } = {}) {
    const lease = pinnedLease || await currentLease();
    const assertCurrentLease = async () => {
      if (binding) return; // Hub holds the host lock and revalidates the target before persisting.
      const current = await currentLease();
      if (current.target_id !== lease.target_id || current.cdp_origin !== lease.cdp_origin || current.host_pid !== lease.host_pid ||
          current.dot_id !== lease.dot_id || current.room_id !== lease.room_id || current.workspace !== lease.workspace ||
          current.shared_window !== lease.shared_window) {
        throw fail("dot_window_changed", "The managed Dot window changed during the operation.");
      }
    };
    if (pinnedLease) await assertCurrentLease();
    if (expected.targetID && expected.targetID !== lease.target_id) {
      throw fail("dot_window_changed", "The managed Dot window changed. Reopen the conversation.");
    }
    if (expected.dotID && expected.dotID !== lease.dot_id) {
      throw fail("dot_window_changed", "The managed window belongs to a different Dot.");
    }
    if (expected.roomID && lease.room_id && expected.roomID !== lease.room_id) {
      throw fail("dot_window_changed", "The managed window belongs to a different Dot conversation.");
    }
    if (expected.workspace !== undefined && lease.workspace !== undefined && expected.workspace !== lease.workspace) {
      throw fail("dot_window_changed", "The managed window belongs to a different workspace.");
    }
    const webSocket = await rendererSocket(lease);
    const page = new CdpPageClient({ actionTimeoutMs: 4000, commandTimeoutMs: 3500 });
    try {
      await rendererCommand("connect", () => page.connectToPage(webSocket, []));
      const scope = {
        dotID: lease.dot_id,
        roomID: expected.roomID || lease.room_id || "",
        workspace: lease.workspace ?? expected.workspace,
      };
      const evaluate = (stage, script) => rendererCommand(stage, () => page.evaluate(script, { awaitPromise: false }));
      const pageCall = (command, fields, input = {}) => evaluate(command, expression(command, fields, input));
      const inspect = binding ? "bind_status" : activate || statusOnly ? "inspect_status" : "inspect";
      let state = await pageCall(inspect, scope);
      let activation = "";
      if (!state?.dotID && activate && lease.shared_window && navigateToDot) {
        const navigate = async () => {
          await assertCurrentLease();
          return evaluate("activate", navigateToDot(lease.dot_id || ""));
        };
        activation = await navigate();
        if (activation === "sidebar_opening") {
          await delay(200);
          state = await pageCall(inspect, scope);
          if (!state?.dotID) activation = await navigate();
        }
        if (activation === "dot_entry_clicked") {
          for (let attempt = 0; attempt < 18 && !state?.dotID; attempt++) {
            await delay(150);
            state = await pageCall(inspect, scope);
          }
        }
      }
      if (!state?.roomID || !state?.dotID || (lease.workspace !== undefined && state.workspace !== lease.workspace)) {
        if (activation === "desktop_busy") throw fail("dot_window_busy", "The shared ChatGPT window is handling a desktop action.");
        if (activation === "desktop_attachments") throw fail("dot_window_busy", "The shared ChatGPT window has a pending attachment.");
        const proof = activate ? await pageCall("bind_status", {}).catch(() => null) : null;
        const identityStage = proof?.stage || (proof?.dotID && (proof.dotID !== scope.dotID
          ? "different_dot" : proof.roomID !== scope.roomID ? "different_room" :
            proof.workspace !== scope.workspace ? "different_workspace" : "native_scope_verified"));
        const stage = [activation, identityStage].filter(Boolean).join(", ");
        throw fail("dot_window_unavailable", `The managed window does not show the bound Dot conversation.${stage ? " (" + stage + ")" : ""}`);
      }
      if (activate && !statusOnly) {
        state = await pageCall("inspect", { ...scope, roomID: state.roomID, workspace: state.workspace });
        if (!state) throw fail("dot_window_unavailable", "The managed window changed before the Dot transcript was read.");
      }
      state.targetID = lease.target_id;
      const strictScope = { ...scope, dotID: state.dotID, roomID: state.roomID, workspace: state.workspace };
      const call = async (command, input) => {
        if (command !== "inspect") await assertCurrentLease();
        const result = await pageCall(command, strictScope, input);
        const succeeded = command === "fill" ?
          typeof result?.previousDraft === "string" && typeof result?.writtenDraft === "string" : result === true;
        if (SEND_ACTIONS.has(command) && !succeeded) {
          const stage = SEND_FAILURE_STAGES.has(result?.stage) ? result.stage : "surface_unavailable";
          const error = fail("dot_surface_changed", `The Dot ${command} action could not be verified (${stage}).`);
          error.stage = stage;
          throw error;
        }
        if (result == null) throw fail("dot_surface_changed", "The Dot surface could not prove the requested action.");
        if (command === "inspect") result.targetID = lease.target_id;
        return result;
      };
      return await operation({ state, call });
    } finally {
      await page.close();
    }
  }

  return {
    async bindWindow(target) {
      const saved = await readDotWindowLease({ requireLive: false });
      // The previous release stored its Dot identity as three top-level fields.
      const identity = target.binding ? boundIdentity(target.binding) :
        { dot_id: saved?.dot_id, room_id: saved?.room_id, workspace: saved?.workspace };
      return withPage(({ state }) => state, {}, { binding: true, activate: true, statusOnly: true,
        lease: { ...target, ...identity } });
    },

    async sharedBinding() {
      try {
        const lease = await currentLease();
        if (!lease.shared_window || !lease.room_id) return null;
        await rendererSocket(lease);
        return { dotID: lease.dot_id, roomID: lease.room_id, workspace: lease.workspace, targetID: lease.target_id };
      } catch {
        return null;
      }
    },

    async snapshot(expected = {}, { activate = false, statusOnly = false } = {}) {
      const read = (lease) => withPage(({ state }) => state, expected, { activate, statusOnly, lease });
      if (activate) {
        return withDesktopHostLock(async () => {
          const lease = await currentLease();
          try {
            return await read(lease);
          } catch (error) {
            if (error.code !== "dot_renderer_unresponsive") throw error;
            // Selection can be retried after rechecking the same lease and foreground.
            await delay(150);
            return await read(lease);
          }
        });
      }
      const state = await withDesktopHostLock(() => read(), { skipIfBusy: true });
      if (!state) throw fail("desktop_host_busy", "The shared ChatGPT window is busy.");
      return state;
    },

    send(expected, text, markSubmitted, assertReady) {
      return withDesktopHostLock(() => withPage(async ({ state, call }) => {
        assertReady(state);
        if (state.typing) throw fail("dot_send_unavailable", "Dot is still replying.");
        if (!state.canSend) throw fail("dot_send_unavailable", "The Dot editor could not be identified.");
        const draft = await call("fill", { text });
        let submitted = false;
        try {
          for (let attempt = 0; ; attempt++) {
            try {
              await call("preflight", { text });
              break;
            } catch (error) {
              if (error.stage !== "send_button_unavailable" || attempt >= 4) throw error;
              await delay(100);
            }
          }
          markSubmitted(state);
          submitted = true;
          await call("send", { text });
        } finally {
          if (!submitted || draft.previousDraft.trim()) {
            for (let attempt = 0; attempt < 8; attempt++) {
              if (attempt) await delay(100);
              const result = await call("restore_draft", { ...draft, submitted }).catch(() => "unavailable");
              if (result !== "pending") break;
            }
          }
        }
      }, expected, { activate: true }));
    },

    loadHistory(expected, enough, signal) {
      return withDesktopHostLock(() => withPage(async ({ state, call }) => {
        let current = state;
        let moved = false;
        try {
          for (let page = 0; page < 5 && !enough(current) && current.history.hasBefore; page += 1) {
            if (signal?.aborted) break;
            moved = await call("older") || moved;
            const oldest = current.messages[0]?.id;
            for (let check = 0; check < 12; check += 1) {
              if (signal?.aborted) break;
              await delay(150, undefined, { signal });
              current = await call("inspect");
              if (current.history.failed || !current.history.hasBefore || (!current.history.loading && current.messages[0]?.id !== oldest)) break;
            }
            if (current.history.failed || current.messages[0]?.id === oldest) break;
          }
          return current;
        } finally {
          if (moved) await call("restore", state.history).catch(() => {});
        }
      }, expected));
    },
  };
}

module.exports = { createDesktopBackend, targetSocket };
