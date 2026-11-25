"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const desktopHostCoordination = "chatgpt-single-window-v2";

function desktopHostDirectory() {
  return path.join(os.homedir(), ".prism", "runtime", "desktop-host");
}

function windowLeasePath(pluginID) {
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(pluginID)) throw new Error("Invalid shared window plugin ID");
  return path.join(desktopHostDirectory(), pluginID + "-window.json");
}

function loopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port &&
        url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) {
      return url.origin;
    }
  } catch {}
  return "";
}

function readWindowLease(leasePath, { requireLive = true } = {}) {
  try {
    if (fs.statSync(leasePath).size > 16 * 1024) return null;
    const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    const origin = loopbackOrigin(lease.cdp_origin);
    if (!origin || typeof lease.target_id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(lease.target_id) ||
        !Number.isSafeInteger(lease.host_pid) || lease.host_pid <= 0) return null;
    if (requireLive) process.kill(lease.host_pid, 0);
    return { ...lease, cdp_origin: origin };
  } catch {
    return null;
  }
}

function readSharedWindowLease() {
  let names;
  try { names = fs.readdirSync(desktopHostDirectory()); } catch { return null; }
  const leases = names.filter((name) => name.endsWith("-window.json"))
    .map((name) => readWindowLease(path.join(desktopHostDirectory(), name)))
    .filter((lease) => lease?.phase === "ready");
  const shared = leases.filter((lease) => lease.shared_window);
  if (!shared.length) return leases.length === 1 ? leases[0] : null;
  if (!shared.every((lease) => lease.target_id === shared[0].target_id && lease.cdp_origin === shared[0].cdp_origin)) {
    throw new Error("Shared window leases refer to different renderers");
  }
  return shared[0];
}

function navigationExpression(identity, steps) {
  return `((identity) => {
    const visible = (el) => el?.getClientRects().length && !el.closest('[inert],[hidden],[aria-hidden="true"]');
    const nodes = (selector) => [...document.querySelectorAll(selector)].filter(visible);
    const busy = nodes('[data-codex-approval-surface="true"], [role="alertdialog"], [data-codex-stop-button], .typing-indicator[data-visible="true"]');
    if (busy.length) return 'desktop_busy';
    // A sidebar switch leaves text drafts to the native conversation.
    if (nodes('.composer-attachment-surface').length) return 'desktop_attachments';
    const openSidebar = () => {
      const triggers = nodes('[data-app-shell-sidebar-trigger][aria-expanded="false"]')
        .filter((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
      if (triggers.length !== 1) return false;
      triggers[0].click();
      return true;
    };
    ${steps}
  })(${JSON.stringify(identity)})`;
}

function codexNavigation(identity) {
  return navigationExpression(identity, `
    const previous = identity || window.__prismSharedCodexThread;
    if (!previous) return 'codex_previous_thread_unavailable';
    const rows = nodes('[data-app-action-sidebar-thread-row]');
    const threadID = (el) => el.getAttribute('data-app-action-sidebar-thread-id');
    const exact = rows.filter((el) => threadID(el) === previous);
    const matches = exact.length || previous.includes(':') ? exact :
      rows.filter((el) => threadID(el)?.endsWith(':' + previous));
    if (!matches.length && openSidebar()) return 'sidebar_opening';
    if (!matches.length) return 'codex_thread_not_visible';
    // A thread can appear in both pinned and recent groups. Only choose
    // among duplicate rows when every row has the same native identity.
    if (new Set(matches.map(threadID)).size !== 1) return 'codex_thread_ambiguous';
    const target = matches.find((el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true');
    if (!target) return 'codex_thread_disabled';
    const selectedID = threadID(target);
    target.click();
    return selectedID;
  `);
}

async function withDesktopHostLock(operation, options = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const { skipIfBusy = false, timeoutMs = 10000, lockPath = path.join(desktopHostDirectory(), "chatgpt.sqlite") } = options;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    fs.closeSync(fs.openSync(lockPath, "wx", 0o600));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const database = new DatabaseSync(lockPath);
  let locked = false;
  const deadline = Date.now() + timeoutMs;
  try {
    database.exec("PRAGMA busy_timeout = 0");
    while (!locked) {
      try {
        database.exec("BEGIN IMMEDIATE");
        locked = true;
      } catch (error) {
        // SQLite reports the primary result code in the low byte of the extended code.
        if ((error.errcode & 0xff) !== 5) throw error;
        if (skipIfBusy) return undefined;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const busy = new Error("The ChatGPT desktop window is busy");
          busy.code = "desktop_host_busy";
          throw busy;
        }
        await delay(Math.min(remaining, 50));
      }
    }
    return await operation();
  } finally {
    try {
      if (locked) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
}

module.exports = { desktopHostCoordination, windowLeasePath, readWindowLease, readSharedWindowLease,
  loopbackOrigin, navigationExpression, codexNavigation, withDesktopHostLock };
