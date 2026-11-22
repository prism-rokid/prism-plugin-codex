"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createDeliveryLedger } = require("../delivery-ledger.cjs");

test("a pre-submit reservation survives a restart and cannot move to another conversation", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-dot-ledger-"));
  const file = path.join(directory, "deliveries.sqlite");
  const first = createDeliveryLedger(file);
  const restarted = createDeliveryLedger(file);
  t.after(() => {
    first.close();
    restarted.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(first.lookup("room", "request"), null);
  assert.equal(first.reserve("room", "request"), true);
  first.close();
  assert.deepEqual(restarted.lookup("room", "request"), { reserved: true, runID: "" });
  assert.equal(restarted.reserve("another-room", "request"), false);
  assert.equal(restarted.confirm("another-room", "request", "native"), false);
  assert.equal(restarted.confirm("room", "request", "native"), true);
  assert.equal(restarted.confirm("room", "request", "wrong"), false);
  assert.deepEqual(restarted.lookup("room", "request"), { reserved: true, runID: "native" });
  assert.deepEqual(restarted.lookup("another-room", "request"), { reserved: true, runID: "" });
});
