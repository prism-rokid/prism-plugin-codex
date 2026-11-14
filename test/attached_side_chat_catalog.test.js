"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { __test } = require("../index.js");

const INDEX_PATH = path.join(__dirname, "..", "index.js");
const THREAD_MAIN = "11111111-1111-4111-8111-111111111111";
const THREAD_ATTACHED = "22222222-2222-4222-8222-222222222222";
const THREAD_INDEPENDENT = "33333333-3333-4333-8333-333333333333";
const THREAD_FORK = "44444444-4444-4444-8444-444444444444";
const SHARED_TITLE = "同名会话";

// 用真实 sqlite3 CLI 读取会依赖各平台的系统包；这里用已锁定的 better-sqlite3
// 生成一个只读 JSON 查询器，保证测试在 macOS/Linux/Windows 走同一数据路径。
function writeSqliteJsonWrapper(directory) {
  const script = path.join(directory, "sqlite-json.js");
  const wrapper = path.join(directory, "sqlite-json");
  fs.writeFileSync(script, `"use strict";
const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
const args = process.argv.slice(2);
const file = args[args.length - 2];
const sql = args[args.length - 1];
const database = new Database(file, { readonly: true, fileMustExist: true });
try {
  process.stdout.write(JSON.stringify(database.prepare(sql).all()));
} finally {
  database.close();
}
`, "utf8");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, "utf8");
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function createThreadsTable(database, withAttachedParent) {
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      model_provider TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      sandbox_policy TEXT NOT NULL DEFAULT '',
      approval_mode TEXT NOT NULL DEFAULT '',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      thread_source TEXT,
      preview TEXT NOT NULL DEFAULT '',
      recency_at INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0${withAttachedParent ? ",\n      attached_thread_parent_id TEXT" : ""}
    );
  `);
}

function insertThread(database, { id, title, parentID = null, minutesAgo = 0, withAttachedParent = true }) {
  const updatedAtMs = Date.now() - minutesAgo * 60 * 1000;
  const columns = [
    "id", "rollout_path", "created_at", "updated_at", "source", "model_provider", "cwd",
    "title", "sandbox_policy", "approval_mode", "tokens_used", "has_user_event", "archived",
    "cli_version", "first_user_message", "memory_mode", "created_at_ms", "updated_at_ms",
    "thread_source", "preview", "recency_at", "recency_at_ms",
  ];
  const values = [
    id, "", updatedAtMs, updatedAtMs, "desktop", "openai", "/tmp/project",
    title, "{}", "on-request", 0, 0, 0,
    "0.1.0", "用户消息", "enabled", updatedAtMs, updatedAtMs,
    "user", "预览", updatedAtMs, updatedAtMs,
  ];
  if (withAttachedParent) {
    columns.push("attached_thread_parent_id");
    values.push(parentID);
  }
  database.prepare(`INSERT INTO threads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

function writeSessionIndex(codexRoot, titles) {
  const lines = Object.entries(titles).map(([id, title]) => JSON.stringify({
    id,
    thread_name: title,
    updated_at: new Date().toISOString(),
  }));
  fs.writeFileSync(path.join(codexRoot, "session_index.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

function createFixture({ withAttachedParent }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-attached-"));
  const codexRoot = path.join(home, ".codex");
  fs.mkdirSync(codexRoot, { recursive: true });
  const database = new Database(path.join(codexRoot, "state_5.sqlite"));
  try {
    createThreadsTable(database, withAttachedParent);
    insertThread(database, { id: THREAD_MAIN, title: SHARED_TITLE, minutesAgo: 4, withAttachedParent });
    insertThread(database, {
      id: THREAD_ATTACHED,
      title: SHARED_TITLE,
      parentID: THREAD_MAIN,
      minutesAgo: 1,
      withAttachedParent,
    });
    insertThread(database, { id: THREAD_INDEPENDENT, title: SHARED_TITLE, minutesAgo: 2, withAttachedParent });
    insertThread(database, { id: THREAD_FORK, title: SHARED_TITLE, minutesAgo: 3, withAttachedParent });
  } finally {
    database.close();
  }
  writeSessionIndex(codexRoot, {
    [THREAD_MAIN]: SHARED_TITLE,
    [THREAD_ATTACHED]: SHARED_TITLE,
    [THREAD_INDEPENDENT]: SHARED_TITLE,
    [THREAD_FORK]: SHARED_TITLE,
  });
  return { home, codexRoot };
}

function runAdapter(fixture) {
  const env = {
    ...process.env,
    HOME: fixture.home,
    USERPROFILE: fixture.home,
    PRISM_CODEX_HOME: fixture.codexRoot,
  };
  if (process.platform !== "win32") {
    env.PRISM_SQLITE3_BIN = writeSqliteJsonWrapper(fixture.home);
  }
  const script = `
const { __test } = require(${JSON.stringify(INDEX_PATH)});
(async () => {
  const sessions = await __test.listSessions();
  const side = await __test.findThreadByID(${JSON.stringify(THREAD_ATTACHED)});
  const main = await __test.findThreadByID(${JSON.stringify(THREAD_MAIN)});
  const attached = await __test.attachSession({ NativeThreadID: ${JSON.stringify(THREAD_ATTACHED)} });
  const sideHint = await __test.desktopWatchSessionHint(${JSON.stringify(THREAD_ATTACHED)}, {}, "idle");
  const mainHint = await __test.desktopWatchSessionHint(${JSON.stringify(THREAD_MAIN)}, {}, "idle");
  const sideTerminal = __test.desktopTerminalRunEvent(
    ${JSON.stringify(THREAD_ATTACHED)}, "completed", "done",
    { plugin_id: "codex", native_thread_id: ${JSON.stringify(THREAD_ATTACHED)} },
    null, "turn-side",
  );
  const mainTerminal = __test.desktopTerminalRunEvent(
    ${JSON.stringify(THREAD_MAIN)}, "completed", "done",
    { plugin_id: "codex", native_thread_id: ${JSON.stringify(THREAD_MAIN)} },
    null, "turn-main",
  );
  console.log(JSON.stringify({
    ids: sessions.map((item) => item.NativeSessionID),
    sideFound: Boolean(side),
    mainFound: Boolean(main),
    sideAttachID: attached && (attached.NativeSessionID || attached.NativeThreadID),
    sideHint,
    mainHint,
    sideTerminalHasHint: Object.prototype.hasOwnProperty.call(sideTerminal.Payload, "session_hint"),
    mainTerminalHasHint: Object.prototype.hasOwnProperty.call(mainTerminal.Payload, "session_hint"),
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
  const stdout = execFileSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

test("附属侧聊不进入目录，但历史、绑定与同名独立会话、fork 均保留", () => {
  const fixture = createFixture({ withAttachedParent: true });
  try {
    const result = runAdapter(fixture);
    assert.deepEqual(
      [...result.ids].sort(),
      [THREAD_MAIN, THREAD_INDEPENDENT, THREAD_FORK].sort(),
      "附属侧聊不得作为独立目录项返回",
    );
    assert.equal(result.sideFound, true, "附属侧聊仍可按原生 ID 读取");
    assert.equal(result.mainFound, true);
    assert.equal(result.sideAttachID, THREAD_ATTACHED, "已有绑定仍可 attach 到附属侧聊");
    assert.equal(result.sideHint, null, "附属侧聊的前台 session_hint 不得重新加入目录");
    assert.equal(result.mainHint.native_thread_id, THREAD_MAIN);
    assert.equal(result.sideTerminalHasHint, false, "附属侧聊的终态事件不得携带目录提示");
    assert.equal(result.mainTerminalHasHint, true);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("大量附属侧聊不会挤占独立会话的目录分页", () => {
  const fixture = createFixture({ withAttachedParent: true });
  try {
    const database = new Database(path.join(fixture.codexRoot, "state_5.sqlite"));
    try {
      database.transaction(() => {
        for (let index = 0; index < 600; index += 1) {
          insertThread(database, {
            id: `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`,
            title: SHARED_TITLE,
            parentID: THREAD_MAIN,
            minutesAgo: 0,
            withAttachedParent: true,
          });
        }
      })();
    } finally {
      database.close();
    }
    const result = runAdapter(fixture);
    assert.deepEqual(
      [...result.ids].sort(),
      [THREAD_MAIN, THREAD_INDEPENDENT, THREAD_FORK].sort(),
      "分页必须先过滤附属侧聊，独立会话不能被挤出目录",
    );
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("旧版状态库没有附属列时目录行为保持不变", () => {  const fixture = createFixture({ withAttachedParent: false });
  try {
    const result = runAdapter(fixture);
    assert.deepEqual(
      [...result.ids].sort(),
      [THREAD_MAIN, THREAD_ATTACHED, THREAD_INDEPENDENT, THREAD_FORK].sort(),
      "无法判断附属关系时不得隐藏任何会话",
    );
    assert.equal(result.sideFound, true);
    assert.equal(result.sideHint.native_thread_id, THREAD_ATTACHED);
    assert.equal(result.sideTerminalHasHint, true);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("排队事件在附属关系确认后投递前撤销过期的 session_hint", async () => {
  __test.updateDesktopDirectoryAttachments([]);
  const queue = __test.createDesktopWatchEventQueue(null);
  try {
    queue.push({
      Type: "desktop.state.changed",
      Payload: {
        native_session: { native_thread_id: THREAD_ATTACHED },
        session_hint: { plugin_id: "codex", native_thread_id: THREAD_ATTACHED },
      },
    });
    // 事件入队后、投递前，目录刷新确认同一线程属于附属侧聊。
    __test.updateDesktopDirectoryAttachments([THREAD_ATTACHED]);
    const entry = await queue.next();
    assert.equal(__test.desktopWatchEventForSubscription(entry, true), null, "目录订阅不得再收到侧聊提示");
    const scoped = __test.desktopWatchEventForSubscription(entry);
    assert.equal(scoped.Payload.native_session.native_thread_id, THREAD_ATTACHED);
    assert.equal(scoped.Payload.session_hint, undefined, "单会话订阅保留详情但不携带目录提示");
  } finally {
    queue.close();
  }
});
