"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function key(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Dot delivery requires a bound session and message ID.");
  }
  return createHash("sha256").update(value).digest("hex");
}

function createDeliveryLedger(filePath) {
  let database;
  let lookup;
  let reserve;
  let confirm;

  function initialize() {
    if (database) return;
    const { DatabaseSync } = require("node:sqlite");
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      fs.closeSync(fs.openSync(filePath, "wx", 0o600));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const opened = new DatabaseSync(filePath);
    try {
      opened.exec(`
        PRAGMA busy_timeout = 1000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS dot_deliveries (
          request_key TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          native_run_id TEXT
        );
      `);
      lookup = opened.prepare("SELECT scope_key, native_run_id FROM dot_deliveries WHERE request_key = ?");
      reserve = opened.prepare(`
        INSERT INTO dot_deliveries (request_key, scope_key) VALUES (?, ?)
        ON CONFLICT (request_key) DO NOTHING
      `);
      confirm = opened.prepare(`
        UPDATE dot_deliveries SET native_run_id = ?
        WHERE request_key = ? AND scope_key = ? AND native_run_id IS NULL
      `);
      database = opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  }

  return {
    lookup(scope, requestID) {
      initialize();
      const scopeKey = key(scope);
      const entry = lookup.get(key(requestID));
      if (!entry) return null;
      return { reserved: true, runID: entry.scope_key === scopeKey ? entry.native_run_id || "" : "" };
    },
    reserve(scope, requestID) {
      initialize();
      return reserve.run(key(requestID), key(scope)).changes === 1;
    },
    confirm(scope, requestID, runID) {
      initialize();
      const requestKey = key(requestID);
      const scopeKey = key(scope);
      if (typeof runID !== "string" || !runID) throw new Error("Dot delivery confirmation requires a native run ID.");
      if (confirm.run(runID, requestKey, scopeKey).changes === 1) return true;
      const entry = lookup.get(requestKey);
      return entry?.scope_key === scopeKey && entry?.native_run_id === runID;
    },
    close() {
      database?.close();
      database = undefined;
    },
  };
}

module.exports = { createDeliveryLedger };
