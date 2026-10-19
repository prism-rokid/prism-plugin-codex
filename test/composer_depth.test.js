const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CodexDesktopController } = require('../codex_cdp');

function fixture(depth, mode = 'submit', queue = true, secondOwner = false) {
  const events = [];
  const element = (text = '') => ({
    innerText: text,
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: () => null,
    hasAttribute: () => false,
    matches: () => true,
    querySelectorAll: () => [],
    dispatchEvent: event => { events.push([text, event.type]); },
  });
  const owner = { submitButtonMode: mode, isResponseInProgress: mode === 'stop',
    isQueueingEnabled: queue, submitDisabled: false };
  const primary = element('primary');
  primary.__reactFiber$fixture = { memoizedProps: {
    isLoading: false, disabled: false, ariaLabel: 'opaque', Icon: {}, onClick() {},
  } };
  let fiber = primary.__reactFiber$fixture;
  for (let i = 1; i <= depth; i++) {
    fiber.return = { memoizedProps: i === depth ? owner : {} };
    fiber = fiber.return;
  }
  if (secondOwner) fiber.return = { memoizedProps: { ...owner } };
  const dictation = element();
  // It shares the same owner, but lacks the primary-button contract.
  dictation.__reactFiber$fixture = { memoizedProps: {}, return: fiber };
  const permission = element();
  permission.hasAttribute = key => key === 'data-composer-navigation-target';
  const composer = element('test sentinel');
  composer.querySelectorAll = selector => selector === '[data-composer-navigation-target]'
    ? [permission] : selector === 'button, [role="button"]' ? [dictation, permission, primary] : [];
  const document = { querySelectorAll: selector => selector === '.composer-attachment-surface' ? [] : [composer] };
  const controller = Object.create(CodexDesktopController.prototype);
  controller.ensureReady = async () => {};
  controller.waitFor = async () => true;
  const Event = class { constructor(type) { this.type = type; } };
  controller.evaluate = source => vm.runInNewContext(source, { document, MouseEvent: Event, PointerEvent: Event });
  let clicked;
  controller.clickElement = async source => { clicked = await controller.evaluate(source); };
  return { controller, primary, events, getClicked: () => clicked };
}

for (const depth of [26, 60]) {
  for (const [mode, queue, expected] of [['submit', true, 'send'], ['stop', true, 'queue'], ['stop', false, 'guide']]) {
    test(`depth ${depth} resolves ${expected} consistently for readiness and click`, async () => {
      const f = fixture(depth, mode, queue);
      const facts = await f.controller.waitForComposerSendReady(100);
      assert.equal(facts.submission_kind, expected);
      await f.controller.clickComposerPrimaryButton(expected);
      assert.equal(f.getClicked(), f.primary);
    });
  }
  test(`depth ${depth} interrupts only the real Stop button`, async () => {
    const f = fixture(depth, 'stop');
    await f.controller.interrupt();
    assert.equal(f.getClicked(), f.primary);
  });
}

test('deep duplicate owners fail safely and report the reason without input text', async () => {
  const { controller } = fixture(26, 'submit', true, true);
  await assert.rejects(controller.waitForComposerSendReady(1), error => {
    assert.match(error.message, /composer_action_owner_ambiguous/);
    assert.doesNotMatch(error.message, /test sentinel/);
    return true;
  });
  await assert.rejects(controller.clickComposerPrimaryButton(), /control_target_stale/);
});

test('owner beyond the bounded search fails safely', async () => {
  const { controller } = fixture(80);
  await assert.rejects(controller.waitForComposerSendReady(1), /composer_action_owner_ambiguous/);
});
