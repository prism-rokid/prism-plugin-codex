"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const { CodexDesktopController, diagnoseCodexMainPage } = require("../codex_cdp");

async function endpoint(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const page = { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1/page" };

for (const bodyOnly of [false, true]) {
  test(`端口发现硬超时覆盖${bodyOnly ? "已收到响应头但响应体挂起" : "完全没有响应"}`, async t => {
    const url = await endpoint(t, (_, response) => {
      if (bodyOnly) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write("[");
      }
    });
    const controller = new CodexDesktopController({ connectTimeoutMs: 80 });
    const started = Date.now();
    await assert.rejects(controller.fetchPageTarget(`${url}/json/list`), /超时/);
    assert.ok(Date.now() - started < 600, "发现请求必须在总预算内退出");
  });
}

test("诊断的列表、版本和多次重试不叠加超时预算", async t => {
  let requests = 0;
  const url = await endpoint(t, (request, response) => {
    requests += 1;
    if (request.url === "/json/list") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("[]");
    } else {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write("{");
    }
  });
  const started = Date.now();
  assert.deepEqual(await diagnoseCodexMainPage({ cdpUrl: url, timeoutMs: 80, attempts: 3 }), {
    page: false, reachable: false,
  });
  assert.equal(requests, 2);
  assert.ok(Date.now() - started < 600);
});

test("显式端口覆盖仍能选择真正的 Codex 工作区页面", async t => {
  const url = await endpoint(t, (_, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([
      { ...page, url: "app://-/index.html?initialRoute=avatar-overlay" }, page,
    ]));
  });
  const controller = new CodexDesktopController({ cdpUrl: url, connectTimeoutMs: 500 });
  assert.deepEqual(await controller.resolvePageTarget(), page);
  assert.deepEqual(await diagnoseCodexMainPage({ cdpUrl: url }), { page: true, reachable: true });
});

test("发现操作接受父级截止时间而不重新延长连接预算", async t => {
  const url = await endpoint(t, () => {});
  const controller = new CodexDesktopController({ cdpUrl: url, connectTimeoutMs: 15000 });
  const started = Date.now();
  await assert.rejects(controller.resolvePageTarget({ deadline: started + 80 }), /超时/);
  assert.ok(Date.now() - started < 600);
});

test("忽略取消信号的 fetch 也不会阻塞调用方或产生后续重试", async t => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requests = 0;
  let requestSignal;
  global.fetch = (_, options) => {
    requests += 1;
    requestSignal = options.signal;
    return new Promise(() => {});
  };
  const controller = new CodexDesktopController({ connectTimeoutMs: 15000 });
  const abort = new AbortController();
  const pending = controller.fetchPageTarget("http://127.0.0.1/json/list", { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error("测试取消"));
  await assert.rejects(pending, /测试取消/);
  assert.equal(requests, 1);
  assert.equal(requestSignal.aborted, true);
});

test("已经取消的发现不会启动托管 Desktop", async () => {
  const controller = new CodexDesktopController({ allowManagedLaunch: true });
  const abort = new AbortController();
  abort.abort(new Error("启动已取消"));
  await assert.rejects(controller.launchManagedTarget({ signal: abort.signal }), /启动已取消/);
  assert.equal(controller.managedProcess, null);
});

function controllerWithProcessInventory(urls, options) {
  // 只替代系统进程清单，HTTP 请求、响应体、重试和预算仍执行真实实现。
  const filename = require.resolve("../codex_cdp");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.discoveryURLs = urls;
  loaded._compile(fs.readFileSync(filename, "utf8") + `
    managedCdpListURLs = async () => module.discoveryURLs;
    isCodexRunning = async () => false;
  `, filename);
  return new loaded.exports.CodexDesktopController(options);
}

test("失效默认端口文件和首个慢监听端口不会饿死后续有效端口", async t => {
  const slowURL = await endpoint(t, () => {});
  const validURL = await endpoint(t, (_, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([page]));
  });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-cdp-budget-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  fs.writeFileSync(portFile, new URL(slowURL).port);
  const controller = controllerWithProcessInventory([`${slowURL}/json/list`, `${validURL}/json/list`], {
    userDataDir, connectTimeoutMs: 300,
  });
  assert.deepEqual(await controller.resolvePageTarget(), page);
  assert.equal(fs.readFileSync(portFile, "utf8"), new URL(slowURL).port, "慢响应不能证明 Electron 的端口文件失效");
});

test("失效缓存端口为显式托管启动保留同一截止时间内的剩余预算", async t => {
  const slowURL = await endpoint(t, () => {});
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-cdp-launch-budget-"));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), new URL(slowURL).port);
  const controller = controllerWithProcessInventory([`${slowURL}/json/list`], {
    userDataDir, connectTimeoutMs: 300, allowManagedLaunch: true,
  });
  const deadline = Date.now() + 300;
  let launches = 0;
  controller.launchManagedTarget = async budget => {
    launches += 1;
    assert.equal(budget.deadline, deadline);
    assert.ok(budget.deadline > Date.now(), "托管启动必须获得剩余预算");
    return page;
  };
  assert.deepEqual(await controller.resolvePageTarget({ deadline }), page);
  assert.equal(launches, 1);
});
