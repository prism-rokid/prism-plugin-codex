const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const { CodexDesktopController } = require("../codex_cdp.js");

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const ROOT_SELECTOR = "[data-codex-composer-root]";
const MARKER_SELECTOR = "[data-above-composer-conversation-id]";
const FORM_SELECTOR = 'form[data-thread-find-composer="true"]';
const FOCUS_SELECTOR = "[data-app-shell-focus-area]";
const MODERN = { "data-composer-navigation-target": "reasoning", "data-selected-reasoning-effort": "xhigh" };
const LEGACY = { "data-codex-intelligence-trigger": "true" };
const PERMISSION_SELECTOR = '[data-composer-navigation-target="permissions"]';
const HIDDEN_SELECTOR = '[aria-hidden="true"], [hidden], [inert]';
const rect = () => ({ width: 200, height: 40 });

function span(text = "", { id = "", children = [], ariaHidden = false } = {}) {
  const node = {
    id,
    children,
    ariaHidden,
    tagName: "SPAN",
    get textContent() {
      return this.children.map((child) => child.textContent).join("") + text;
    },
    querySelector: (selector) => selector === "span" ? node.children[0] || null : null,
  };
  for (const child of children) {
    child.remove = () => node.children.splice(node.children.indexOf(child), 1);
  }
  return node;
}

function composerRoot({ threadID = THREAD_ID, activePage = true, focusArea = "", parentElement = null, fingerprint = "" } = {}) {
  const scope = {
    parentElement,
    getBoundingClientRect: rect,
    querySelector: () => null,
    matches: () => false,
    hasAttribute: () => false,
    getAttribute: (name) => name === "data-composer-placement" ? "thread" : null,
    closest(selector) {
      if (selector.startsWith(ROOT_SELECTOR)) return scope;
      if (selector === FORM_SELECTOR) return parentElement || scope;
      if (selector === FOCUS_SELECTOR) return focusArea ? { getAttribute: () => focusArea } : null;
      if (selector.includes('[data-app-shell-active-page="false"]')) return activePage ? null : scope;
      if (selector === '[data-app-shell-active-page="true"]') return activePage ? parentElement || scope : null;
      return null;
    },
    querySelectorAll(selector) {
      return selector === MARKER_SELECTOR && marker ? [marker] : [];
    },
  };
  const marker = threadID ? {
    parentElement: scope,
    getAttribute: (name) => name === "data-above-composer-conversation-id" ? threadID : null,
    closest: (selector) => scope.closest(selector),
  } : null;
  if (fingerprint) scope.__reactFiber$fixture = { memoizedProps: {
    scope: { __scopeBrand: "ComposerScope" },
    value: { kind: "local", placement: "main", conversationId: null, routeConversationId: null, clientThreadId: fingerprint },
  } };
  return scope;
}

function button(attributes, label, { inside = true, hidden = false, visible = true, owner = composerRoot() } = {}) {
  const attrs = { ...attributes };
  return {
    id: "active-trigger",
    owner: inside ? owner : null,
    get children() {
      return label();
    },
    get textContent() {
      return this.children.map((child) => child.textContent).join("");
    },
    getBoundingClientRect: () => visible ? rect() : { width: 0, height: 0 },
    closest: (selector) => {
      if (selector.includes(HIDDEN_SELECTOR)) return hidden ? {} : owner?.closest(selector) || null;
      return inside ? owner.closest(selector) : null;
    },
    getAttribute: (name) => attrs[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attrs, name),
    setExpanded: (value) => { attrs["aria-expanded"] = String(value); },
    setAttribute: (name, value) => { attrs[name] = value; },
    querySelector: () => null,
    cloneNode() {
      const copy = span("", { children: label() });
      function descendants(node) {
        return node.children.flatMap((child) => [child, ...descendants(child)]);
      }
      copy.querySelectorAll = (selector) => descendants(copy).filter((node) => {
        if (selector === HIDDEN_SELECTOR) return node.ariaHidden;
        if (selector === "[id]") return Boolean(node.id);
        return selector === "span";
      });
      return copy;
    },
  };
}

function fixture(candidates, menus = [], roots = [...new Set(candidates.map((candidate) => candidate.owner).filter(Boolean))], extraQueries = {}) {
  const controller = Object.create(CodexDesktopController.prototype);
  const matchesTriggers = (selector) => candidates.filter((candidate) =>
    candidate.getAttribute("data-codex-intelligence-trigger") === "true" ||
    (selector.includes('[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort]') &&
      candidate.getAttribute("data-composer-navigation-target") === "reasoning" &&
      candidate.hasAttribute("data-selected-reasoning-effort"))
  );
  for (const root of roots) {
    const query = root.querySelectorAll.bind(root);
    root.querySelectorAll = (selector) => selector.includes('data-codex-intelligence-trigger="true"')
      ? matchesTriggers(selector).filter((trigger) => trigger.closest(FORM_SELECTOR) === root)
      : query(selector);
  }
  const document = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector.includes('data-codex-intelligence-trigger="true"')) return matchesTriggers(selector);
      if (selector === '[role="menu"]') return menus;
      if (Object.hasOwn(extraQueries, selector)) return extraQueries[selector]();
      if (selector === MARKER_SELECTOR) return roots.flatMap((root) => root.querySelectorAll(MARKER_SELECTOR));
      if (selector.startsWith("[data-codex-composer")) return roots;
      return [];
    },
  };
  controller.evaluate = async (source) => vm.runInNewContext(source, {
    document, window: {},
    getComputedStyle: () => ({ visibility: "visible" }),
  });
  controller.focusFixtureElement = (element) => { document.activeElement = element; };
  controller.ensureReady = async () => {};
  controller.clickElement = async () => assert.fail("Read-only projection must not click Codex");
  controller.closeVisibleMenus = async () => {
    document.activeElement = null;
    candidates.forEach((candidate) => candidate.setExpanded(false));
  };
  return controller;
}

test("modern Composer exposes its native combined value and rejects hidden and out-of-Composer lookalikes", async () => {
  const owner = composerRoot({ focusArea: "main" });
  const modern = button(MODERN, () => [
    span("Select model", { ariaHidden: true }),
    span("Model Prototype"),
    span("低 极高", { ariaHidden: true }),
    span("高"),
  ], { owner });
  const controller = fixture([
    button(LEGACY, () => [span("Hidden tree")], { visible: false, owner }),
    button(LEGACY, () => [span("Retained animation")], { hidden: true, owner }),
    button(MODERN, () => [span("Other control")], { inside: false }),
    button({ "data-composer-navigation-target": "reasoning" }, () => [span("Retry loading models")], { owner }),
    modern,
  ]);
  const closed = await controller.closedComposerControls(THREAD_ID);
  assert.equal(closed.intelligence?.currentValue ?? null, "Model Prototype 高");
  assert.equal(closed.intelligence.controlId, "codex.intelligence");
  assert.equal((await controller.composerControlState()).model, "Model Prototype");
  assert.equal((await controller.composerControlReadiness(THREAD_ID)).intelligence, true);
  assert.equal((await controller.closedComposerControls("other-conversation")).intelligenceReason, "foreground_changed");
});

test("compact Composer reads reasoning that is a direct text node in its native description", async () => {
  const trigger = button({ ...MODERN, "aria-describedby": "tooltip compact-label" }, () => [
    span("Click to select", { id: "tooltip" }),
    span(" 极高", { id: "compact-label", children: [span("Model Prototype")] }),
  ]);
  const closed = await fixture([trigger]).closedComposerControls();
  assert.equal(closed.intelligence?.currentValue ?? null, "Model Prototype 极高");
  assert.equal(closed.intelligence.effortValue, "xhigh");
});

test("legacy markers remain readable; a missing trigger stays unavailable", async () => {
  const owner = composerRoot();
  const legacy = button(LEGACY, () => [span("Legacy label")], { owner });
  assert.equal((await fixture([legacy]).closedComposerControls(THREAD_ID)).intelligence.currentValue, "Legacy label");
  const controller = fixture([], [], [owner]);
  const closed = await controller.closedComposerControls(THREAD_ID);
  assert.equal(closed.intelligence, null);
  assert.equal(closed.intelligenceReason, "trigger_missing");
  assert.equal((await controller.composerControlReadiness(THREAD_ID)).intelligence, false);
});

test("modern intelligence menu reads options only inside its ARIA-owned menu", async () => {
  const trigger = button({ ...MODERN, "aria-controls": "active-menu" }, () => [span("Model A")]);
  const ownedMenu = {
    id: "active-menu",
    getAttribute: () => null,
    getBoundingClientRect: rect,
    closest: () => null,
    querySelectorAll: (selector) => selector === '[role="menuitemradio"]' ? rows : [],
  };
  function row(label, checked) {
    return {
      innerText: label,
      getBoundingClientRect: rect,
      closest: (selector) => selector === '[role="menu"]' ? ownedMenu : null,
      hasAttribute: () => false,
      getAttribute: (name) => name === "aria-checked" ? String(checked) : null,
    };
  }
  const hidden = {
    ...row("Inactive pane", true),
    closest: (selector) => selector.includes(HIDDEN_SELECTOR) ? {} : selector === '[role="menu"]' ? ownedMenu : null,
  };
  const rows = [row("Model A", true), row("Model B", false), hidden];
  const unrelated = {
    ...ownedMenu,
    id: "other-menu",
    getAttribute: () => "other-trigger",
    querySelectorAll: () => assert.fail("Unowned menu must not be read"),
  };
  const controller = fixture([trigger], [unrelated, ownedMenu]);
  controller.clickElement = async (source) => {
    assert.equal(await controller.evaluate(source) === trigger, true, "The click must target the modern trigger");
    trigger.setExpanded(true);
  };
  controller.waitFor = async (source) => assert.ok(await controller.evaluate(source));

  const groups = await controller.listIntelligenceMenuGroups();
  assert.equal(groups.length, 1);
  assert.deepEqual(Array.from(groups[0].rows, (entry) => entry.label), ["Model A", "Model B"]);

  const duplicate = { ...ownedMenu, id: "duplicate", getAttribute: (name) => name === "aria-labelledby" ? trigger.id : null };
  const ambiguous = fixture([trigger], [ownedMenu, duplicate]);
  trigger.setExpanded(true);
  assert.equal((await ambiguous.intelligenceRootControls()).length, 0);
});

test("compact icon-only ModelPicker reads the current native menu owner without opening it", async () => {
  const trigger = button({ ...MODERN, "aria-label": "Select model" }, () => []);
  const selected = { model: "prototype", displayName: "Prototype Model" };
  const unselected = { model: "other", displayName: "Other Model" };
  const getter = {
    get model() {
      assert.fail("Catalog getters must not run");
    },
  };
  const props = {
    triggerButton: { props: { children: { props: MODERN } } },
    model: "prototype",
    fallbackModelLabel: "Fallback",
    reasoningEffort: "xhigh",
    open: false,
    modelOptions: [{ model: unselected }, { model: getter }, { model: selected }],
    powerSelections: [],
  };
  trigger.__reactFiber$test = { return: { memoizedProps: props } };
  const controller = fixture([trigger]);
  const controls = await controller.closedComposerControls();
  assert.equal(controls.intelligence.currentValue, "Prototype Model xhigh");

  props.reasoningEffort = "medium";
  const mismatch = await controller.closedComposerControls();
  assert.equal(mismatch.intelligence, null);
  assert.equal(mismatch.intelligenceReason, "value_unavailable");
});

test("an expanded SimpleView placeholder resolves only from the owning native label candidate", async () => {
  const trigger = button(MODERN, () => [span("Choose effort")]);
  trigger.setExpanded(true);
  const props = {
    isOpen: true,
    showOpenLabel: true,
    selectedLabelCandidate: { id: "model:xhigh", model: "model", modelLabel: "Native Model", reasoningEffort: "xhigh" },
  };
  trigger.__reactFiber$test = {
    memoizedProps: {
      get selectedLabelCandidate() {
        assert.fail("Fiber props getters must not run");
      },
    },
    return: { memoizedProps: props },
  };
  const controller = fixture([trigger]);
  assert.equal((await controller.closedComposerControls()).intelligence.currentValue, "Native Model xhigh");

  trigger.__reactFiber$test.return.return = { memoizedProps: { ...props } };
  assert.equal((await controller.closedComposerControls()).intelligence, null);
});

test("bound controls resolve the active main Composer, including an outer root's thread marker", async () => {
  const thread = composerRoot({ focusArea: "main" });
  const nestedEditor = composerRoot({ threadID: "", focusArea: "main", parentElement: thread });
  const wrongThread = composerRoot({ threadID: "22222222-2222-4222-8222-222222222222", focusArea: "right-panel" });
  const inactive = composerRoot({ activePage: false, focusArea: "main" });
  const current = button(MODERN, () => [span("Current model"), span("高")], { owner: nestedEditor });
  const candidates = [
    button(MODERN, () => [span("Side chat")], { owner: wrongThread }),
    button(MODERN, () => [span("Inactive page")], { owner: inactive }),
    current,
  ];
  const controller = fixture(candidates, [], [wrongThread, inactive, thread, nestedEditor]);

  assert.equal((await controller.closedComposerControls(THREAD_ID)).intelligence?.currentValue ?? null, "Current model 高");
  assert.equal((await controller.composerControlReadiness(THREAD_ID)).intelligence, true);
});

test("two genuine controls in the current Composer are ambiguous", async () => {
  const owner = composerRoot({ focusArea: "main" });
  const controller = fixture([
    button(MODERN, () => [span("Private model A")], { owner }),
    button(MODERN, () => [span("Private model B")], { owner }),
  ]);
  const controls = await controller.closedComposerControls(THREAD_ID);

  assert.equal(controls.intelligence, null);
  assert.equal(controls.intelligenceReason, "trigger_ambiguous");
});

test("a known main conversation cannot borrow an unbound legacy trigger", async () => {
  const main = composerRoot({ focusArea: "main" });
  const side = composerRoot({ threadID: "", focusArea: "right-panel" });
  const controller = fixture([
    button(LEGACY, () => [span("Unrelated legacy model")], { owner: side }),
  ], [], [side, main]);
  controller.clickElement = async (source) => {
    const target = await controller.evaluate(source);
    assert.equal(target, null, "The unbound legacy trigger must not receive the click");
  };

  assert.equal((await controller.closedComposerControls(THREAD_ID)).intelligence, null);
  await assert.rejects(controller.openIntelligenceMenu(), /control_target_stale/);
});

test("a main anonymous draft cannot borrow a retained Composer's legacy model", async () => {
  const main = composerRoot({ threadID: "", focusArea: "main", fingerprint: "active-draft" });
  const retained = composerRoot({ threadID: "", fingerprint: "retained-draft" });
  const controller = fixture([
    button(LEGACY, () => [span("Unrelated legacy model")], { owner: retained }),
  ], [], [retained, main]);
  controller.clickElement = async (source) => {
    await controller.evaluate(source);
    assert.fail("The retained Composer must not receive a click");
  };
  assert.equal((await controller.closedComposerControls()).intelligence, null);
  await assert.rejects(controller.openIntelligenceMenu(), /control_target_stale/);
});

test("stable model state cannot be attributed to a previously selected conversation", async () => {
  const current = composerRoot({ threadID: "22222222-2222-4222-8222-222222222222", focusArea: "main" });
  const trigger = button(MODERN, () => [span("Current model"), span("高")], { owner: current });
  const controller = fixture([trigger]);
  assert.equal((await controller.composerControlState()).intelligence, "Current model 高");
  assert.deepEqual(await controller.composerControlState(THREAD_ID), {
    permission: "", intelligence: "", model: "", reasoning: "", reasoningLabel: "", reasoningEffort: "",
  });
});


test("the current native scope can identify a markerless conversation and rejects disagreement", async () => {
  const owner = composerRoot({ threadID: "" });
  const scope = { kind: "local", placement: "main", conversationId: THREAD_ID, routeConversationId: THREAD_ID, clientThreadId: "client-current" };
  owner.__reactFiber$fixture = { memoizedProps: { scope: { __scopeBrand: "ComposerScope" }, value: scope } };
  const controller = fixture([button(MODERN, () => [span("Native model"), span("高")], { owner })]);
  assert.equal((await controller.closedComposerControls(THREAD_ID)).intelligence?.currentValue, "Native model 高");
  scope.routeConversationId = "22222222-2222-4222-8222-222222222222";
  assert.equal((await controller.closedComposerControls(THREAD_ID)).intelligence, null);
});

test("two active main Composer owners are rejected even when only one has the expected thread", async () => {
  const expected = composerRoot({ focusArea: "main" });
  const other = composerRoot({ focusArea: "main", threadID: "22222222-2222-4222-8222-222222222222" });
  const trigger = button(MODERN, () => [span("Model"), span("高")], { owner: expected });
  assert.equal((await fixture([trigger], [], [expected, other]).closedComposerControls(THREAD_ID)).intelligence, null);
});

const indexPath = require.resolve("../index.js");

function pluginFixture(t, controller) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-codex-projection-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });

  const indexRequire = createRequire(indexPath);
  const fixtureRequire = (id) => {
    if (id === "./codex_cdp") return { ...indexRequire(id), createCodexDesktopController: () => controller };
    if (id === "os") return { ...os, homedir: () => home };
    return indexRequire(id);
  };
  const fixtureProcess = { platform: process.platform, env: { PRISM_CODEX_HOME: codexHome } };
  // 直接运行插件的轮询和队列，避免启动订阅计时器及账户用量客户端。
  const loadIndex = vm.compileFunction(
    fs.readFileSync(indexPath, "utf8") + "\nreturn { adapter, pollDesktopWatch, desktopWatchSubscribers, currentDesktopConversationSnapshot };",
    ["require", "module", "process"],
    { filename: indexPath },
  );
  const fixtureModule = { exports: {} };
  return { ...loadIndex(fixtureRequire, fixtureModule, fixtureProcess), helpers: fixtureModule.exports.__test, home, sessions };
}

test("an ambiguous model owner leaves permission readable in the desktop detail snapshot", async (t) => {
  const expected = composerRoot({ focusArea: "main" });
  const other = composerRoot({ focusArea: "main", threadID: "22222222-2222-4222-8222-222222222222" });
  const permission = button({ "data-composer-navigation-target": "permissions" }, () => [span("Ask first")], { owner: expected });
  const controller = fixture([
    button(MODERN, () => [span("Expected model"), span("高")], { owner: expected }),
    button(MODERN, () => [span("Other model"), span("高")], { owner: other }),
  ], [], [expected, other], { [PERMISSION_SELECTOR]: () => [permission] });
  controller.queuedMessageState = async () => null;
  controller.threadPinned = async () => false;
  controller.conversationHeaderMenuAvailable = async () => false;

  const { currentDesktopConversationSnapshot, helpers } = pluginFixture(t, controller);
  const snapshot = await currentDesktopConversationSnapshot({ controller, runtime: { current_thread_id: THREAD_ID } });
  const detail = helpers.detailSnapshotFromDesktopWatch(THREAD_ID, snapshot);
  assert.equal(detail.native_conversation_id, THREAD_ID);
  assert.equal(detail.current_permission?.displayName, "Ask first");
  assert.equal(detail.current_model, null);
  assert.equal(detail.current_reasoning, null);
});

function sliderMenuFixture({ locked = [], legacy = false } = {}) {
  const marker = '[data-reasoning-slider="true"]';
  const trigger = button({ ...(legacy ? LEGACY : MODERN), "aria-controls": "slider-menu" }, () => [span("Fixture model"), span("High")]);
  const options = [
    { id: "model-a:high", label: "Modèle A · Élevé" },
    { id: "model-a:low", label: "Modèle A · Faible" },
    { id: "model-b:medium", label: "Modèle B · Moyen" },
  ].map((option) => ({ ...option, isLocked: locked.includes(option.id) }));
  const [first, middle, last] = options;
  let selectedID = first.id;
  const menu = {
    id: "slider-menu", getAttribute: () => null, getBoundingClientRect: rect, closest: () => null,
    querySelectorAll: (selector) => selector === marker ? [row] : [],
  };
  const row = {
    getBoundingClientRect: rect,
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: (selector) => selector === '[role="menu"]' ? menu : null,
    focus: () => controller.focusFixtureElement(row),
    // 保留的 Fiber 包含不同顺序和额外档位，后续方向键也不会更新它。
    __reactFiber$fixture: { memoizedProps: {
      powerSelections: [middle, first, last, { id: "old:extra" }].map(({ id }) => ({ id, reasoningEffort: "old" })),
      selectedPowerSelection: first,
    } },
  };
  const setRendered = (id, rendered = options) => {
    selectedID = id;
    row.__reactProps$fixture = { "data-reasoning-slider": true, children: {
      props: { children: { props: { options: rendered, selectedOptionId: id } } },
    } };
  };
  setRendered(selectedID);
  const controller = fixture([trigger], [menu], [trigger.owner], {
    [marker]: () => [row],
    '[role="status"]': () => [{ textContent: "旧模型 轻度，第 1 项，共 4 项" }],
  });
  controller.clickElement = async (source) => {
    assert.equal(await controller.evaluate(source), trigger);
    trigger.setExpanded(true);
  };
  controller.waitFor = async (source) => {
    if (!await controller.evaluate(source)) throw new Error("CDP wait timed out");
  };
  controller.selectThread = async () => ({ selected: true });
  controller.isThreadSelected = async (threadID) => threadID === THREAD_ID;
  controller.withTransparentNativeMenus = (read) => read();
  controller.readInteractiveSurface = async () => null;
  const keys = [];
  controller.send = async (method, event) => {
    assert.equal(method, "Input.dispatchKeyEvent");
    if (event.type !== "rawKeyDown") return;
    keys.push(event.key);
    const index = options.findIndex((option) => option.id === selectedID);
    const next = options[index + (event.key === "ArrowRight" ? 1 : -1)];
    if (next && !next.isLocked) setRendered(next.id);
  };
  return { controller, trigger, row, keys, options, setRendered, selected: () => selectedID };
}

test("slider-only menu session exposes rendered labels and applies opaque entries step by step", async (t) => {
  const { controller, trigger, keys, options, selected } = sliderMenuFixture();
  const { adapter } = pluginFixture(t, controller);
  const control = (action, target) => adapter.controlSession({ action, session: { NativeThreadID: THREAD_ID }, target });
  const described = await control("menu_session.describe", { owner: { kind: "interactive_control", control_id: "codex.intelligence" } });
  const [group] = described.details.groups;
  assert.equal(described.details.groups.length, 1);
  assert.equal(group.label, "模型与推理");
  assert.deepEqual(Array.from(group.entries, ({ label, available, current }) => [label, available, current]),
    options.map(({ label }, index) => [label, true, index === 0]));
  assert.ok(group.entries.every((entry) => !Object.hasOwn(entry, "option_id")));
  assert.deepEqual(keys, []);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  const applied = await control("menu_session.apply", {
    menu_session_id: described.details.menu_session_id, entry_id: group.entries[2].entry_id,
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(keys, ["ArrowRight", "ArrowRight"]);
  assert.equal(selected(), options[2].id);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("slider-only menu retains native locks and stops before crossing a locked option", async () => {
  const { controller, trigger, keys } = sliderMenuFixture({ legacy: true, locked: ["model-a:low"] });
  const [{ control_id, rows }] = await controller.listIntelligenceMenuGroups();
  assert.deepEqual(Array.from(rows, ({ checked, disabled }) => [checked, disabled]), [[true, false], [false, true], [false, false]]);
  await assert.rejects(() => controller.applyInteractiveComposerMenuSession(control_id, rows[2].optionId, rows), /control_target_stale: .*locked option/);
  assert.deepEqual(keys, []);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("slider-only menu rejects missing host props, unknown selected IDs, and duplicate native IDs", async () => {
  const { controller, trigger, row, keys, options, setRendered } = sliderMenuFixture();
  const [first, second] = options;
  const rejectDescribe = async () => {
    await assert.rejects(() => controller.listIntelligenceMenuGroups(), /control_target_stale: intelligence menu has no readable groups/);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  };
  delete row.__reactProps$fixture;
  await rejectDescribe();
  setRendered("unrendered:option");
  await rejectDescribe();
  setRendered(first.id, [first, { ...second, id: first.id }]);
  await rejectDescribe();
  assert.deepEqual(keys, []);
});

test("slider-only menu rechecks native identities and locks after the first committed step", async () => {
  const mutations = [
    (last) => ({ ...last, id: "removed:option" }),
    (last) => ({ ...last, isLocked: true }),
  ];
  for (const mutate of mutations) {
    const { controller, trigger, keys, options, setRendered } = sliderMenuFixture();
    const [first, second, last] = options;
    const [{ control_id, rows }] = await controller.listIntelligenceMenuGroups();
    const send = controller.send;
    controller.send = async (method, event) => {
      await send(method, event);
      if (event.type === "rawKeyDown") setRendered(second.id, [first, second, mutate(last)]);
    };
    await assert.rejects(() => controller.applyInteractiveComposerMenuSession(control_id, rows[2].optionId, rows), /control_target_stale: .*structure changed/);
    assert.deepEqual(keys, ["ArrowRight"]);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  }
});

test("slider-only menu does not continue after a non-adjacent selection or loss of focus", async () => {
  for (const lostFocus of [false, true]) {
    const { controller, keys, options, setRendered } = sliderMenuFixture();
    const [{ control_id, rows }] = await controller.listIntelligenceMenuGroups();
    const send = controller.send;
    controller.send = async (method, event) => {
      await send(method, event);
      if (event.type !== "rawKeyDown") return;
      if (lostFocus) controller.focusFixtureElement(null);
      else setRendered(options[2].id);
    };
    await assert.rejects(() => controller.applyInteractiveComposerMenuSession(control_id, rows[2].optionId, rows),
      lostFocus ? /control_target_stale: .*lost focus/ : /control_target_stale: .*unexpected option/);
    assert.deepEqual(keys, ["ArrowRight"]);
  }
});



test("a legacy anonymous draft exposes its model and describes its native menu", async (t) => {
  const composer = composerRoot({ threadID: "" });
  composer.__reactFiber$legacy = { memoizedState: { clientThreadId: "legacy-draft" } };
  const trigger = button(LEGACY, () => [span("Legacy model")], { owner: composer });
  const menu = {
    getAttribute: (name) => name === "aria-labelledby" ? trigger.id : null,
    getBoundingClientRect: rect,
    closest: () => null,
    querySelectorAll: (selector) => selector === '[role="menuitemradio"]' ? rows : [],
  };
  const rows = ["Legacy model", "Another native model"].map((label, index) => ({
    innerText: label,
    getBoundingClientRect: rect,
    closest: (selector) => selector === '[role="menu"]' ? menu : null,
    hasAttribute: () => false,
    getAttribute: (name) => name === "aria-checked" ? String(index === 0) : null,
  }));
  const controller = fixture([trigger], [menu]);
  controller.startNewProjectlessThread = async () => {};
  controller.withTransparentNativeMenus = (read) => read();
  controller.clickElement = async (source) => {
    assert.equal(await controller.evaluate(source), trigger);
    trigger.setExpanded(true);
  };
  controller.waitFor = async (source) => assert.ok(await controller.evaluate(source));
  const { adapter } = pluginFixture(t, controller);

  const draft = await adapter.openDraft({ DraftID: "legacy-model-draft" });
  assert.equal(draft.draft_fingerprint, "legacy-draft");
  assert.deepEqual(Array.from(draft.Controls.interactive_controls, ({ control_id, current_value }) =>
    [control_id, current_value]), [["codex.intelligence", "Legacy model"]]);
  const described = await adapter.controlDraft({
    DraftID: draft.DraftID,
    Action: "menu_session.describe",
    Target: { owner: { kind: "interactive_control", control_id: "codex.intelligence" } },
  });
  assert.deepEqual(Array.from(described.Details.entries, ({ label, current }) => [label, current]),
    [["Legacy model", true], ["Another native model", false]]);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("legacy draft model ownership requires one visible main Composer with its own fingerprint", async () => {
  const main = composerRoot({ threadID: "", focusArea: "main" });
  main.__reactFiber$legacy = { memoizedProps: { clientThreadId: "main-draft" } };
  const trigger = button(LEGACY, () => [span("Legacy model")], { owner: main });
  const active = fixture([trigger]);
  assert.equal((await active.closedComposerControls()).intelligence?.currentValue, "Legacy model");
  assert.equal((await active.closedComposerControls(THREAD_ID)).intelligence, null);

  const second = composerRoot({ threadID: "", focusArea: "main" });
  const side = composerRoot({ threadID: "", focusArea: "right-panel" });
  const hidden = composerRoot({ threadID: "", activePage: false, focusArea: "main" });
  for (const owner of [second, side, hidden]) {
    owner.__reactFiber$legacy = { memoizedState: { clientThreadId: "other-draft" } };
  }
  const sideTrigger = button(LEGACY, () => [span("Side model")], { owner: side });
  const hiddenTrigger = button(LEGACY, () => [span("Hidden model")], { owner: hidden });
  for (const controller of [
    fixture([trigger], [], [main, second]),
    fixture([sideTrigger]),
    fixture([hiddenTrigger]),
  ]) {
    assert.equal((await controller.closedComposerControls()).intelligence, null);
  }
  main.__reactFiber$legacy.memoizedState = { clientThreadId: "another-main-draft" };
  assert.equal((await active.closedComposerControls()).intelligence, null);
  main.__reactFiber$legacy = { return: {
    memoizedProps: { children: { props: { clientThreadId: "another-draft" } } },
  } };
  assert.equal((await active.closedComposerControls()).intelligence, null);
});

test("a legacy anonymous draft can open and send with an attachment while the model is unavailable", async (t) => {
  const composer = composerRoot({ threadID: "" });
  // 旧版 Runtime 可从 Composer 自身状态取得草稿身份，没有带品牌的 Scope。
  composer.__reactFiber$legacy = { memoizedState: { clientThreadId: "legacy-draft" } };
  const controller = fixture([], [], [composer]);
  const { adapter, home, sessions } = pluginFixture(t, controller);
  controller.startNewProjectlessThread = async () => {};
  let sent;
  controller.sendMessage = async (payload) => {
    sent = payload;
    const lookup = composer.querySelectorAll.bind(composer);
    composer.querySelectorAll = (selector) => selector === MARKER_SELECTOR ? [{
      parentElement: composer,
      getAttribute: () => THREAD_ID,
    }] : lookup(selector);
    const timestamp = new Date().toISOString();
    fs.writeFileSync(path.join(sessions, `rollout-${timestamp.slice(0, 19)}-${THREAD_ID}.jsonl`), JSON.stringify({
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: payload.text }] },
    }) + "\n");
  };

  const draft = await adapter.openDraft({ DraftID: "legacy-draft-handle" });
  assert.equal(draft.draft_fingerprint, "legacy-draft");
  assert.deepEqual(draft.Controls.interactive_controls, []);
  const localPath = path.join(home, "fixture.txt");
  fs.writeFileSync(localPath, "fixture attachment");
  const result = await adapter.startDraftWithMessage({ DraftID: draft.DraftID, Message: {
    PrismMessageID: "legacy-draft-first-message",
    Text: "Fixture first message",
    Attachments: [{ LocalPath: localPath, Name: "fixture.txt", MIMEType: "text/plain" }],
  } });
  assert.deepEqual(sent, {
    text: "Fixture first message",
    attachments: [{ localPath, name: "fixture.txt", mimeType: "text/plain" }],
  });
  assert.equal(result.Session.NativeThreadID, THREAD_ID);
  assert.equal(result.Receipt.Visible, true);
});

function watcherFixture(t, attrs = MODERN, permission = null) {
  const label = { model: "Model A", effort: "中" };
  const trigger = button(attrs, () => [span(label.model), span(label.effort)]);
  const extraQueries = {};
  if (permission) {
    const control = button({ "data-composer-navigation-target": "permissions" }, () => [span(permission.value)], { owner: trigger.owner });
    extraQueries[PERMISSION_SELECTOR] = () => [control];
    const lookup = trigger.owner.querySelectorAll.bind(trigger.owner);
    trigger.owner.querySelectorAll = (selector) => selector === PERMISSION_SELECTOR ? [control] : lookup(selector);
  }
  const controller = fixture([trigger], [], [trigger.owner], extraQueries);
  controller.readInteractiveSurface = async () => null;
  controller.queuedMessageState = async () => null;
  controller.threadPinned = async () => false;
  controller.conversationHeaderMenuAvailable = async () => false;
  let draft = "";
  Object.defineProperty(trigger.owner, "innerText", { get: () => draft });

  const { pollDesktopWatch, desktopWatchSubscribers, helpers, sessions } = pluginFixture(t, controller);
  const { createDesktopWatchEventQueue } = helpers;

  return {
    label,
    trigger,
    setDraft(value) { draft = value; },
    changeEffort(value, nativeValue) {
      label.effort = value;
      trigger.setAttribute("data-selected-reasoning-effort", nativeValue);
    },
    poll: pollDesktopWatch,
    addSubscriber(pluginWide) {
      const queue = createDesktopWatchEventQueue(null);
      t.after(() => queue.close());
      const subscriber = {
        pluginWide,
        threadID: pluginWide ? "" : THREAD_ID,
        signature: "",
        messagesSignature: "",
        detailSnapshot: null,
        sessionHint: null,
        push: queue.push,
      };
      desktopWatchSubscribers.set(pluginWide ? "plugin" : "thread", subscriber);
      return {
        get sessionHint() { return subscriber.sessionHint; },
        async drain() {
          const marker = {};
          queue.push(marker);
          const events = [];
          for (;;) {
            const { done, value } = await queue.next();
            if (done || value === marker) return events;
            events.push(value);
          }
        },
      };
    },
    appendMessage() {
      const rollout = path.join(sessions, "rollout-2026-08-03T00-00-00-" + THREAD_ID + ".jsonl");
      fs.appendFileSync(rollout, JSON.stringify({
        timestamp: "2026-08-03T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "synthetic-message",
          role: "user",
          content: [{ type: "input_text", text: "Fixture message" }],
        },
      }) + "\n");
    },
  };
}

function assertControlDetail(events, currentValue) {
  assert.equal(events.length, 1, "A closed Composer control change must publish a detail event");
  const [event] = events;
  assert.equal(event.Type, "desktop.state.changed");
  assert.equal(event.Payload.native_session.native_thread_id, THREAD_ID);
  assert.equal(Object.hasOwn(event.Payload, "session_hint"), false);
  assert.deepEqual(
    event.Payload.detail_snapshot.interactive_controls.map(({ current_value }) => current_value),
    [currentValue],
  );
}

test("scene ablation: initial modern model and reasoning reach the subscribed Panel", async (t) => {
  const desktop = watcherFixture(t);
  const subscriber = desktop.addSubscriber(true);
  await desktop.poll();
  const events = await subscriber.drain();
  assert.equal(events.length, 1, "The baseline must reach the real watcher event path");
  const [initial] = events;
  assert.equal(initial.Payload.session_hint.native_thread_id, THREAD_ID);
  assert.deepEqual(initial.Payload.detail_snapshot.interactive_controls.map((entry) => entry.current_value), ["Model A 中"]);
});

test("scene ablation: model and effort changes alone refresh the modern Panel detail", async (t) => {
  const desktop = watcherFixture(t);
  const subscriber = desktop.addSubscriber(true);
  await desktop.poll();
  const [initial] = await subscriber.drain();
  assert.equal(initial.Payload.session_hint.native_thread_id, THREAD_ID);
  desktop.label.model = "Model B";
  await desktop.poll();
  assertControlDetail(await subscriber.drain(), "Model B 中");
  desktop.changeEffort("高", "high");
  await desktop.poll();
  assertControlDetail(await subscriber.drain(), "Model B 高");
  assert.equal(subscriber.sessionHint, initial.Payload.session_hint);
});

test("scene ablation: the notifier alone is observable on a baseline-readable legacy trigger", async (t) => {
  const desktop = watcherFixture(t, { ...LEGACY, "data-selected-reasoning-effort": "xhigh" });
  const subscriber = desktop.addSubscriber(true);
  await desktop.poll();
  const [initial] = await subscriber.drain();
  assert.deepEqual(initial.Payload.detail_snapshot.interactive_controls.map((entry) => entry.current_value), ["Model A 中"]);
  desktop.label.model = "Model B";
  await desktop.poll();
  assertControlDetail(await subscriber.drain(), "Model B 中");
});

test("a recovered control read publishes its detail without a directory hint", async (t) => {
  const desktop = watcherFixture(t);
  const subscriber = desktop.addSubscriber(true);
  desktop.trigger.setAttribute("data-composer-navigation-target", "");
  await desktop.poll();
  const [initial] = await subscriber.drain();
  assert.deepEqual(initial.Payload.detail_snapshot.interactive_controls, []);
  desktop.trigger.setAttribute("data-composer-navigation-target", "reasoning");
  await desktop.poll();
  assertControlDetail(await subscriber.drain(), "Model A 中");
});

test("body and draft updates reach thread detail without waking the directory subscription", async (t) => {
  const desktop = watcherFixture(t);
  const pluginSubscriber = desktop.addSubscriber(true);
  const threadSubscriber = desktop.addSubscriber(false);
  await desktop.poll();
  const [initial] = await threadSubscriber.drain();
  assert.equal(initial.Payload.detail_snapshot.messages_signature, "");
  assert.equal((await pluginSubscriber.drain()).length, 1);
  desktop.setDraft("Fixture draft");
  desktop.appendMessage();
  await desktop.poll();
  assert.deepEqual(await pluginSubscriber.drain(), []);
  const [updated] = await threadSubscriber.drain();
  assert.notEqual(updated.Payload.detail_snapshot.messages_signature, "");
  assert.equal(updated.Payload.detail_snapshot.composer.content, "Fixture draft");
});

test("the latest control detail preserves an already queued directory hint", async (t) => {
  const desktop = watcherFixture(t);
  const subscriber = desktop.addSubscriber(true);
  await desktop.poll();
  desktop.label.model = "Model B";
  await desktop.poll();
  const events = await subscriber.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0].Payload.session_hint.native_thread_id, THREAD_ID);
  assert.equal(events[0].Payload.detail_snapshot.interactive_controls[0].current_value, "Model B 中");
});


test("permission alone keeps its watcher behavior; a model update carries the full detail", async (t) => {
  const permission = { value: "Ask first" };
  const desktop = watcherFixture(t, MODERN, permission);
  const subscriber = desktop.addSubscriber(true);
  await desktop.poll();
  const [initial] = await subscriber.drain();
  assert.equal(initial.Payload.session_hint.native_thread_id, THREAD_ID);
  const values = (event) => event.Payload.detail_snapshot.interactive_controls.map(({ current_value }) => current_value);
  assert.deepEqual(values(initial), ["Model A 中", "Ask first"]);

  permission.value = "Full access";
  await desktop.poll();
  assert.deepEqual(await subscriber.drain(), []);

  desktop.label.model = "Model B";
  await desktop.poll();
  const events = await subscriber.drain();
  assert.equal(events.length, 1);
  assert.deepEqual(values(events[0]), ["Model B 中", "Full access"]);
  assert.equal(Object.hasOwn(events[0].Payload, "session_hint"), false);
  assert.equal(subscriber.sessionHint, initial.Payload.session_hint);
});
