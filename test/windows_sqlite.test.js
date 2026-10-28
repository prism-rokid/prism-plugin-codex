"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Database = require("better-sqlite3");
const { readRows, execute } = require("../windows_sqlite");

test("SQLite 读取器与更新器可处理含中文路径的 WAL 会话数据库", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-sqlite-"));
  const file = path.join(directory, "中文 会话.db");
  const writer = new Database(file);
  try {
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE threads (id TEXT, title TEXT); INSERT INTO threads VALUES ('one', '原始');");
    assert.deepEqual(readRows(file, "SELECT title FROM threads"), [{ title: "原始" }]);
    execute(file, "UPDATE threads SET title = '更新' WHERE id = 'one'");
    assert.deepEqual(readRows(file, "SELECT title FROM threads"), [{ title: "更新" }]);
  } finally {
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows 自定义 Codex 目录同时用于读取配置", { skip: process.platform !== "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-home-"));
  try {
    fs.writeFileSync(path.join(directory, "config.toml"), 'approval_policy = "on-request"\n');
    const output = execFileSync(process.execPath, ["-e", "process.stdout.write(require('./index').__test.readCodexConfigText())"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, PRISM_CODEX_HOME: directory },
      encoding: "utf8",
    });
    assert.equal(output, 'approval_policy = "on-request"\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
