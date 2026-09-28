// Live diagnostic probe: reproduce the plugin's permission-switch flow against
// the running Codex Desktop and inspect the confirmation dialog.
// Usage: node scripts/probe-permission-dialog.mjs <inspect|confirm|state> [cdpPort]
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cdpPort = process.argv[3] || "62475";
const mode = process.argv[2] || "state";
const { CdpPageClient } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
const { CodexDesktopController } = require("../codex_cdp.js");

const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const target = list.find((t) => t.type === "page" && (t.url || "").startsWith("app://-/index.html") && !(t.url || "").includes("initialRoute"));
if (!target) throw new Error("main page target not found: " + JSON.stringify(list.map((t) => ({ id: t.id, url: t.url }))));

const client = new CdpPageClient({});
await client.connectToPage(target.webSocketDebuggerUrl);

const fake = Object.create(CodexDesktopController.prototype);
fake.options = client.options;
// The client is already connected; skip the controller's own discovery.
fake.ensureReady = async () => fake;
fake.evaluate = (expr, opts) => client.evaluate(expr, opts);
fake.waitFor = (expr, t, i) => client.waitFor(expr, t, i);
fake.clickElement = (expr) => client.clickElement(expr);
fake.keyPress = (k, m) => client.keyPress(k, m);

const proto = CodexDesktopController.prototype;

const fullAccessRow = (rows) => rows.find((row) => {
  const text = String(row.label || "").toLowerCase();
  return /完全访问|full\s*access/.test(text);
});

if (mode === "state") {
  const composer = await proto.composerControlState.call(fake);
  const rows = await proto.listPermissionOptions.call(fake).catch((e) => ({ error: String(e) }));
  console.log(JSON.stringify({ composer, rows }, null, 2));
  process.exit(0);
}

await proto.installInteractiveSurfaceCapabilityTracker.call(fake);
await proto.openPermissionMenu.call(fake);
const rows = await proto.listPermissionOptions.call(fake, true);
console.log("menu rows:", JSON.stringify(rows, null, 2));
const row = fullAccessRow(rows);
if (!row) throw new Error("full access row not found");
console.log("clicking row:", row.label);

await proto.selectPermissionOption.call(fake, row.optionId);

let surface = null;
const deadline = Date.now() + 4000;
while (Date.now() < deadline) {
  surface = await proto.readInteractiveSurfaceRaw.call(fake).catch((e) => ({ evalError: String(e) }));
  const dialogCount = await client.evaluate(`(() => {
    const visible = (el) => { const r = el && el.getBoundingClientRect(); return Boolean(r && r.width > 0 && r.height > 0); };
    return [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], form[aria-modal="true"]')].filter(visible).length;
  })()`);
  if (dialogCount > 0 && surface && !surface.evalError) break;
  if (dialogCount > 0 && (!surface || surface.evalError)) {
    console.log("dialog visible but raw read failed/empty; dialogCount=", dialogCount, "raw=", JSON.stringify(surface));
  }
  await sleep(120);
}

const publicSurface = surface && !surface.evalError ? proto.publicInteractiveSurface.call(fake, surface) : null;
console.log("RAW SURFACE:", JSON.stringify(surface, null, 2));
console.log("PUBLIC SURFACE:", JSON.stringify(publicSurface, null, 2));

const diagnostics = await client.evaluate(`(() => {
  const visible = (el) => { const r = el && el.getBoundingClientRect(); return Boolean(r && r.width > 0 && r.height > 0); };
  const text = (el) => String(el && (el.innerText || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  const handlerSource = (element) => {
    const fiberKey = element && Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? element[fiberKey] : null;
    const sources = [];
    for (let depth = 0; fiber && depth < 4; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (!props || typeof props !== 'object') continue;
      for (const key of ['onClick', 'onSelect', 'onPress']) {
        if (typeof props[key] === 'function') sources.push(String(props[key]));
      }
    }
    return sources.join('\\n');
  };
  const desktopOnlyAction = (source) => /(?:open_in_browser_bridge|openExternal|window\\.open|location\\.(?:assign|replace|href)|clipboard|showOpenDialog|showSaveDialog|dispatchHostMessage)/i.test(source);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], form[aria-modal="true"]')].filter(visible);
  return {
    dialogCount: dialogs.length,
    dialogs: dialogs.map((d) => ({
      tag: d.tagName, role: d.getAttribute('role'), id: d.id || '',
      ariaModal: d.getAttribute('aria-modal'),
      title: text(d.querySelector('[data-radix-dialog-title], [role="heading"], h1, h2, h3')),
      buttons: [...d.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')].filter(visible).map((b, i) => {
        const source = handlerSource(b);
        return {
          i,
          label: text(b) || b.getAttribute('aria-label') || '',
          disabled: b.disabled || b.getAttribute('aria-disabled') === 'true',
          hasHandler: Boolean(source),
          desktopOnly: source ? desktopOnlyAction(source) : false,
          handlerHead: source ? source.slice(0, 120) : '',
        };
      }),
    })),
  };
})()`);
console.log("DIAGNOSTICS:", JSON.stringify(diagnostics, null, 2));

if (mode === "confirm" && publicSurface) {
  const cancelLike = (label) => /^(取消|cancel|关闭|close|dismiss|稍后|later|not\s*now|保持|keep)/i.test(String(label || "").trim());
  const candidates = (publicSurface.actions || []).filter((a) => a.available !== false && !cancelLike(a.label));
  console.log("confirm candidates:", JSON.stringify(candidates));
  if (candidates.length === 1) {
    await proto.applyInteractiveSurface.call(fake, publicSurface.surface_id, candidates[0].action_id, "");
    console.log("clicked confirm; surface after:", JSON.stringify(await proto.readInteractiveSurface.call(fake).catch((e) => String(e))));
    const composer = await proto.composerControlState.call(fake).catch((e) => String(e));
    console.log("composer after:", JSON.stringify(composer));
  } else {
    console.log("ambiguous confirm candidates; not clicking");
  }
} else if (mode === "inspect") {
  await proto.closeVisibleMenus.call(fake).catch(() => {});
  await client.keyPress("Escape");
}

client.close?.();
process.exit(0);
