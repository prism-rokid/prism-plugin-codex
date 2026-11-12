const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");
const vm = require("node:vm");
const Database = require("better-sqlite3");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-agent-thread-"));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
  const db = new Database(path.join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, cwd TEXT, rollout_path TEXT,
    tokens_used INTEGER, model_provider TEXT, model TEXT, reasoning_effort TEXT,
    sandbox_policy TEXT, approval_mode TEXT, memory_mode TEXT, agent_nickname TEXT,
    thread_source TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, recency_at_ms INTEGER,
    archived INTEGER, first_user_message TEXT, preview TEXT
  )`);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let sequence = 0;
  function addThread(source, { archived = false, rolloutSource } = {}) {
    const id = `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}`;
    const title = `Thread ${sequence}`;
    const cwd = path.join(home, "project");
    const rollout = rolloutSource === undefined ? null : path.join(codexHome, "sessions", `rollout-${id}.jsonl`);
    if (rollout) fs.writeFileSync(rollout, JSON.stringify({
      type: "session_meta", payload: { id, cwd, thread_source: rolloutSource },
    }) + "\n");
    db.prepare(`INSERT INTO threads
      (id, title, cwd, rollout_path, thread_source, archived, updated_at_ms, created_at_ms, recency_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, title, cwd, rollout, source, Number(archived), sequence, sequence, sequence);
    fs.appendFileSync(path.join(codexHome, "session_index.jsonl"), JSON.stringify({ id, thread_name: title }) + "\n");
    return { id, title, cwd };
  }
  const filename = require.resolve("../index.js");
  const load = createRequire(filename);
  const scopedRequire = (name) => {
    if (name === "os") return { ...os, homedir: () => home };
    if (name === "./codex_cdp") return {
      ...load(name),
      createCodexDesktopController() { throw new Error("unexpected live desktop access"); },
    };
    return load(name);
  };
  const mod = { exports: {} };
  vm.compileFunction(fs.readFileSync(filename, "utf8") + "\nmodule.exports = adapter;",
    ["require", "module", "process"], { filename })(scopedRequire, mod, {
    platform: process.platform, env: { ...process.env, PRISM_CODEX_HOME: codexHome },
  });
  return { adapter: mod.exports, addThread };
}

for (const metadataSource of ["SQLite", "rollout"]) {
  test(`agent-created user threads retain directory metadata and can attach (${metadataSource})`, async (t) => {
    const { adapter, addThread } = fixture(t);
    const expected = metadataSource === "SQLite"
      ? addThread("agent_created_thread")
      : addThread("user", { rolloutSource: "agent_created_thread" });
    addThread("user");
    const sessions = await adapter.listSessions();
    assert.equal(sessions.length, 2);
    const session = sessions.find(item => item.NativeThreadID === expected.id);
    assert.ok(session);
    assert.equal(session.NativeThreadID, expected.id);
    assert.equal(session.Title, expected.title);
    assert.equal(session.Cwd, expected.cwd);
    assert.equal(session.Metadata.thread_source, "agent_created_thread");
    const attached = await adapter.attachSession(session);
    assert.equal(attached.NativeThreadID, expected.id);
    assert.equal(attached.Cwd, expected.cwd);
  });
}

test("existing user sources remain visible while internal and archived threads stay excluded", async (t) => {
  const { adapter, addThread } = fixture(t);
  const user = addThread("user");
  const legacy = addThread("");
  const internal = addThread("subagent");
  const archived = addThread("agent_created_thread", { archived: true });
  assert.deepEqual((await adapter.listSessions()).map(s => s.NativeThreadID).sort(), [user.id, legacy.id].sort());
  for (const thread of [internal, archived]) {
    await assert.rejects(adapter.attachSession({ NativeThreadID: thread.id }), /target thread was not found/);
  }
});
