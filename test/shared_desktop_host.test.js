const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { withDesktopHostLock, readWindowLease, codexNavigation, navigationExpression } = require("../shared/desktop-host.cjs");

const { dotNavigation } = require("../dot/navigation.cjs");

function runSharedWindowSwitch(agent, draftElements = {}, { previousThread, codexRowIDs = ["codex-thread"] } = {}) {
  const clicked = [];
  const element = (options = {}) => ({
    getClientRects: () => [1],
    closest: (selector) => selector === 'button,a,[role="button"],[role="link"]' ? entry : null,
    getAttribute: (name) => ({
      "data-sidebar-destination": "builtin:orbit:dot-room",
    })[name],
    click: () => clicked.push(agent),
    ...options,
  });
  const entry = element();
  const elements = {
    '[data-sidebar-destination^="builtin:orbit:"]': entry,
    "[data-app-action-sidebar-thread-row]": codexRowIDs.map((id) => element({
      getAttribute: (name) => name === "data-app-action-sidebar-thread-id" ? id : null,
    })),
  };
  for (const [selector, options] of Object.entries(draftElements)) elements[selector] = element(options);
  const document = {
    querySelectorAll: (query) => query.split(",").flatMap((selector) => elements[selector.trim()] || []),
  };
  const identity = agent === "dot" ? "dot-room" : previousThread ? "" : "codex-thread";
  const result = vm.runInNewContext(agent === "dot" ? dotNavigation(identity, navigationExpression) : codexNavigation(identity), {
    document,
    window: { __prismSharedCodexThread: previousThread },
  });
  return { result, clicked };
}

test("shared navigation resolves Codex rows by native identity", () => {
  assert.deepEqual(runSharedWindowSwitch("codex", {}, { previousThread: "codex-thread",
    codexRowIDs: ["workspace:codex-thread", "workspace:codex-thread"] }),
    { result: "workspace:codex-thread", clicked: ["codex"] });
  assert.deepEqual(runSharedWindowSwitch("codex", {}, { codexRowIDs: ["workspace:codex-thread", "codex-thread"] }),
    { result: "codex-thread", clicked: ["codex"] });
  assert.deepEqual(runSharedWindowSwitch("codex", {}, { codexRowIDs: ["primary:codex-thread", "other:codex-thread"] }),
    { result: "codex_thread_ambiguous", clicked: [] });
});

test("text drafts allow sidebar navigation while attachments and active actions block switching", () => {
  const drafts = {
    '[contenteditable="plaintext-only"]': { innerText: "Unsent Dot message" },
    '[contenteditable="true"]': { innerText: "Unsent Codex message" },
    textarea: { value: "Unrelated text" },
    ".composer-attachment-surface": { getClientRects: () => [] },
  };
  assert.deepEqual(runSharedWindowSwitch("codex", drafts), { result: "codex-thread", clicked: ["codex"] });
  assert.deepEqual(runSharedWindowSwitch("dot", drafts), { result: "dot_entry_clicked", clicked: ["dot"] });
  for (const agent of ["codex", "dot"]) {
    assert.deepEqual(runSharedWindowSwitch(agent, { ...drafts, ".composer-attachment-surface": {} }),
      { result: "desktop_attachments", clicked: [] });
    assert.deepEqual(runSharedWindowSwitch(agent, { ...drafts, "[data-codex-stop-button]": {} }),
      { result: "desktop_busy", clicked: [] });
  }
});

test("desktop host lock is shared across plugin processes and releases on exit", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-desktop-host-"));
  const lockPath = path.join(directory, "database.sqlite");
  const worker = spawn(process.execPath, ["-e", `
    const { withDesktopHostLock } = require(process.argv[1]);
    withDesktopHostLock(async () => {
      process.send('locked');
      await new Promise(() => setInterval(() => {}, 1000));
    }, { lockPath: process.argv[2] }).catch((error) => { console.error(error); process.exitCode = 1; });
  `, require.resolve("../shared/desktop-host.cjs"), lockPath], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exit = once(worker, "exit");
      worker.kill("SIGKILL");
      await exit;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const status = await Promise.race([
    once(worker, "message").then(([value]) => value),
    once(worker, "exit").then(([value]) => `exited:${value}`),
  ]);
  assert.equal(status, "locked");
  assert.equal(await withDesktopHostLock(() => assert.fail("busy watcher must skip"), { lockPath, skipIfBusy: true }), undefined);
  await assert.rejects(withDesktopHostLock(() => assert.fail("two owners acquired the lock"), { lockPath, timeoutMs: 50 }), { code: "desktop_host_busy" });
  const exit = once(worker, "exit");
  worker.kill("SIGKILL");
  await exit;
  await assert.rejects(withDesktopHostLock(() => { throw new Error("operation failed"); }, { lockPath }), /operation failed/);
  assert.equal(await withDesktopHostLock(() => "acquired", { lockPath }), "acquired");
});

test("Dot window lease requires a local DevTools origin and target identity", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-dot-window-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "dot-window.json");
  const lease = { host_pid: process.pid, target_id: "DOT-123", cdp_origin: "http://127.0.0.1:9222" };
  fs.writeFileSync(file, JSON.stringify(lease));
  assert.deepEqual(readWindowLease(file), lease);
  fs.writeFileSync(file, JSON.stringify({ ...lease, cdp_origin: "http://192.0.2.1:9222" }));
  assert.equal(readWindowLease(file), null);
});
