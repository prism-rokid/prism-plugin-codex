"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CodexDesktopController } = require("../codex_cdp.js");

class Socket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    Socket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.(); }
  send(message) { this.sent.push(JSON.parse(message)); }
  reply() {
    const message = this.sent.at(-1);
    this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { ok: true } }) });
  }
  close() { this.readyState = 3; this.onclose?.(); }
}

function setup(t, options = {}) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  Socket.instances = [];
  const controller = new CodexDesktopController({ commandTimeoutMs: 100, ...options });
  controller.waitForReady = async () => {};
  controller.installInteractiveSurfaceCapabilityTracker = async () => {};
  t.after(async () => {
    await controller.close();
    globalThis.WebSocket = previous;
  });
  return controller;
}

async function open(controller, url) {
  const opening = controller.openWebSocket(url);
  const socket = Socket.instances.at(-1);
  socket.open();
  await opening;
  controller.connected = true;
  return socket;
}

test("并发 ensureReady 共用发现、建链和页面准备，失败后允许重试", async (t) => {
  const controller = setup(t);
  let discoveries = 0;
  let release;
  controller.resolvePageTarget = () => {
    discoveries += 1;
    return new Promise((resolve) => { release = resolve; });
  };
  let connections = 0;
  controller.connectToPage = async () => { connections += 1; controller.connected = true; };
  let readiness = 0;
  controller.waitForReady = async () => { readiness += 1; throw new Error("not ready"); };
  const first = controller.ensureReady();
  const second = controller.ensureReady();
  release({ webSocketDebuggerUrl: "ws://first" });
  await assert.rejects(first, /not ready/);
  await assert.rejects(second, /not ready/);
  assert.deepEqual([discoveries, connections, readiness], [1, 1, 1]);
  controller.waitForReady = async () => {};
  const retry = controller.ensureReady();
  release({ webSocketDebuggerUrl: "ws://retry" });
  await retry;
  assert.equal(discoveries, 2);
});

test("旧 socket 延迟 error、close 和响应不影响新连接命令", async (t) => {
  const controller = setup(t);
  const old = await open(controller, "ws://old");
  const current = await open(controller, "ws://current");
  const command = controller.send("Runtime.evaluate");
  old.onerror?.(new Error("late error"));
  old.onclose?.();
  old.onmessage?.({ data: JSON.stringify({ id: current.sent.at(-1).id, result: { stale: true } }) });
  assert.equal(controller.ws, current);
  assert.equal(controller.connected, true);
  current.reply();
  assert.deepEqual(await command, { ok: true });
});

test("替换尚未打开的 socket 后旧 open timeout 不关闭新连接", async (t) => {
  const controller = setup(t, { commandTimeoutMs: 15 });
  const oldOpening = controller.openWebSocket("ws://never-open");
  const oldFailure = assert.rejects(oldOpening, /timed out/);
  const current = await open(controller, "ws://current");
  await oldFailure;
  assert.equal(controller.ws, current);
  assert.equal(controller.connected, true);
  const command = controller.send("Runtime.evaluate");
  current.reply();
  assert.deepEqual(await command, { ok: true });
});

test("重连会清理旧命令且旧命令计时器不影响新连接", async (t) => {
  const controller = setup(t, { commandTimeoutMs: 15 });
  await open(controller, "ws://old");
  const oldFailure = assert.rejects(controller.send("Runtime.evaluate"), /connection closed/);
  const current = await open(controller, "ws://current");
  await oldFailure;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(controller.ws, current);
  const command = controller.send("Page.enable");
  current.reply();
  await command;
});

test("主动 close 使 pending 命令失败并允许新连接", async (t) => {
  const controller = setup(t);
  const old = await open(controller, "ws://old");
  const failure = assert.rejects(controller.send("Runtime.evaluate"), /connection closed/);
  await controller.close();
  await failure;
  assert.equal(controller.ws, null);
  assert.equal(controller.connected, false);
  const current = await open(controller, "ws://new");
  old.onerror?.(new Error("late error"));
  assert.equal(controller.ws, current);
});

test("主动 close 阻止尚在发现中的 ensureReady 建链且不清理后续准备", async (t) => {
  const controller = setup(t);
  let release;
  let discoverySignal;
  controller.resolvePageTarget = ({ signal }) => new Promise((resolve) => {
    release = resolve;
    discoverySignal = signal;
  });
  let connections = 0;
  controller.connectToPage = async () => { connections += 1; };
  const oldReady = controller.ensureReady();
  const oldFailure = assert.rejects(oldReady, /connection closed/);
  const oldRelease = release;
  const oldSignal = discoverySignal;
  await controller.close();
  assert.equal(oldSignal.aborted, true);
  const newReady = controller.ensureReady();
  assert.equal(discoverySignal.aborted, false);
  oldRelease({ webSocketDebuggerUrl: "ws://old" });
  await oldFailure;
  const duplicate = controller.ensureReady();
  release({ webSocketDebuggerUrl: "ws://new" });
  await Promise.all([newReady, duplicate]);
  assert.equal(connections, 1);
});

test("真实 SDK 建链仍启用默认 domains 并将 evaluate 发往当前 socket", async (t) => {
  const controller = setup(t);
  const connecting = controller.connectToPage("ws://page");
  const socket = Socket.instances.at(-1);
  const methods = [];
  socket.send = (payload) => {
    const message = JSON.parse(payload);
    methods.push(message.method);
    queueMicrotask(() => socket.onmessage?.({
      data: JSON.stringify({ id: message.id, result: message.method === "Runtime.evaluate"
        ? { result: { value: "page value" } } : {} }),
    }));
  };
  socket.open();
  assert.equal(await connecting, controller);
  assert.equal(controller.connected, true);
  assert.equal(await controller.evaluate("document.title"), "page value");
  assert.deepEqual(methods, ["Runtime.enable", "DOM.enable", "Page.enable", "Runtime.evaluate"]);
});

test("当前 SDK 命令超时仍使 controller 断开并清空当前 socket", async (t) => {
  const controller = setup(t, { commandTimeoutMs: 10 });
  await open(controller, "ws://page");
  await assert.rejects(controller.send("Runtime.evaluate"), /timed out/);
  assert.equal(controller.connected, false);
  assert.equal(controller.ws, null);
});
