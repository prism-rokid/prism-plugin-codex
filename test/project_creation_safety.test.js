const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CodexDesktopController } = require('../codex_cdp');

const cwd = '/fixture/project';
const id = 'opaque-project';
function hazardousProps() {
  const crossOriginWindow = new Proxy({}, {
    get() { throw new Error('SecurityError: cross-origin Window'); },
    getPrototypeOf() { throw new Error('SecurityError: cross-origin Window'); },
    ownKeys() { throw new Error('SecurityError: cross-origin Window'); },
  });
  const props = { irrelevant: crossOriginWindow, children: { props: { project: { path: cwd, projectId: id } } } };
  Object.defineProperty(props, 'projectId', { enumerable: true, get() { throw new Error('getter must never run'); } });
  props.cycle = props;
  return props;
}
function controllerFor(document) {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  controller.ensureProjectExpanded = async () => ({ expanded: true });
  controller.evaluate = source => vm.runInNewContext(source, { document }, { timeout: 500 });
  controller.waitFor = async () => true;
  let selected;
  controller.clickDomElement = async source => { selected = await controller.evaluate(source); };
  return { controller, selected: () => selected };
}
function button(props, popup = false) {
  return { __reactFiber$fixture: { memoizedProps: props },
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: () => null, hasAttribute: key => key === 'aria-haspopup' && popup };
}
function fixture({ duplicate = false, wrongPath = false } = {}) {
  const props = hazardousProps();
  props.canStartNewThread = true;
  props.onStartNewThread = () => {};
  if (wrongPath) props.children.props.project.path = '/different';
  const primary = button(props), menu = button(props, true);
  const outside = button(props);
  const row = { __reactProps$fixture: hazardousProps(), querySelectorAll: () => duplicate ? [primary, menu, button(props)] : [primary, menu] };
  const document = { querySelector: () => row,
    querySelectorAll: selector => selector.includes('project-row') ? [row] : [outside, primary, menu] };
  return { ...controllerFor(document), primary, outside };
}
test('project mapping skips cross-origin proxies and getters while reading nested exact cwd data', async () => {
  const f = fixture();
  assert.equal(await f.controller.projectIdForCwd(cwd), id);
});
test('project creation ignores unsafe retained references and buttons outside the exact project row', async () => {
  const f = fixture();
  await f.controller.startNewThreadInProject(cwd);
  assert.equal(f.selected(), f.primary);
  assert.notEqual(f.selected(), f.outside);
});
test('project creation rejects two eligible buttons instead of guessing', async () => {
  const f = fixture({ duplicate: true });
  await f.controller.startNewThreadInProject(cwd);
  assert.equal(f.selected(), null);
});
test('project creation requires both exact opaque identity and cwd', async () => {
  const f = fixture({ wrongPath: true });
  await f.controller.startNewThreadInProject(cwd);
  assert.equal(f.selected(), null);
});
test('project search bounds a broad cyclic retained graph', async () => {
  const props = {};
  for (let i = 0; i < 400; i++) props[i] = { cycle: props };
  props.last = { projectId: id, path: cwd };
  const row = { __reactProps$fixture: props };
  const f = controllerFor({ querySelectorAll: () => [row] });
  await assert.rejects(f.controller.projectIdForCwd(cwd), /codex_project_not_visible_for_cwd/);
});

test('anonymous draft fingerprint survives retained cross-origin objects and a deep composer owner', async () => {
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  let source;
  controller.evaluate = async value => { source = value; return {}; };
  await controller.currentThreadRuntimeState();
  const start = source.indexOf('const anonymousDraftFingerprint =');
  const end = source.indexOf('const clientThreadID =', start);
  const composer = { parentElement: null, __reactFiber$fixture: { memoizedProps: hazardousProps() } };
  let fiber = composer.__reactFiber$fixture;
  for (let i = 0; i < 40; i++) { fiber.return = { memoizedProps: {} }; fiber = fiber.return; }
  fiber.memoizedProps = { clientThreadId: 'opaque-client-fixture' };
  const result = vm.runInNewContext(`(() => { const currentThreadId = ''; ${source.slice(start,end)} return anonymousDraftFingerprint(); })()`, { composer }, { timeout: 500 });
  assert.equal(result, 'opaque-client-fixture');
});
