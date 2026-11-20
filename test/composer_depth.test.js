const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CodexDesktopController } = require('../codex_cdp');

function fixture(depth, mode = 'submit', queue = true, secondOwner = false, modern = false) {
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
  const owner = modern
    ? {
      turn: {
        serverInProgress: mode === 'stop',
        hasMessageContent: true,
        transitionBlocksSubmit: false,
      },
      submitDisabled: false,
      isInteractionBlocked: false,
      queuedFollowUpSubmission: queue ? {} : null,
    }
    : { submitButtonMode: mode, isResponseInProgress: mode === 'stop',
      isQueueingEnabled: queue, submitDisabled: false };
  const primary = element('primary');
  primary.__reactFiber$fixture = { memoizedProps: {
    isLoading: false, disabled: false, ariaLabel: 'opaque', Icon: {}, onClick() {},
  } };
  const button = primary.__reactFiber$fixture.memoizedProps;
  const onStop = () => {};
  const modernOwner = {
    turn: { serverInProgress: mode !== 'submit', hasMessageContent: true, isAeon: false },
    followUpAction: queue ? 'queue' : 'steer',
    submitDisabled: false,
    interactionsEnabled: true,
    handleSubmit() {},
    onStop,
  };
  const setModernAction = (action) => {
    button.onClick = action === 'stop' ? onStop : () => {};
    delete button.blockedReasonOpenNonce;
    if (action === 'submit') button.blockedReasonOpenNonce = undefined;
  };
  if (modern) setModernAction(mode === 'stop' ? 'stop' : 'submit');
  let fiber = primary.__reactFiber$fixture;
  for (let i = 1; i <= depth; i++) {
    const props = modern === 'turn' ? (i === depth ? owner : {}) : modern
      ? (i === depth - 1 ? { primaryAction: { props: button }, isInteractionBlocked: false }
        : i === depth ? modernOwner : {})
      : i === depth ? owner : {};
    fiber.return = { memoizedProps: props };
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
  controller.clickElement = async source => {
    clicked = await controller.evaluate(source);
    if (!clicked) throw new Error('CDP target element not found');
  };
  return { controller, primary, events, setModernAction, getClicked: () => clicked };
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

for (const [mode, queue, expected] of [['submit', true, 'send'], ['stop', true, 'queue']]) {
  test(`Codex 26.1103 turn owner resolves ${expected} without legacy mode props`, async () => {
    const f = fixture(32, mode, queue, false, 'turn');
    const facts = await f.controller.waitForComposerSendReady(100);
    assert.equal(facts.submission_kind, expected);
    await f.controller.clickComposerPrimaryButton(expected);
    assert.equal(f.getClicked(), f.primary);
  });
}

for (const [mode, queue, expected] of [['submit', false, 'send'], ['follow-up', true, 'queue'], ['follow-up', false, 'guide']]) {
  test(`current Composer resolves ${expected} through the rendered primary action`, async () => {
    const f = fixture(34, mode, queue, false, true);
    const facts = await f.controller.waitForComposerSendReady(100);
    assert.equal(facts.submission_kind, expected);
    await f.controller.clickComposerPrimaryButton(expected);
    assert.equal(f.getClicked(), f.primary);
  });
}

test('current Composer never sends using the Stop or dictation button', async () => {
  const f = fixture(34, 'stop', true, false, true);
  await assert.rejects(f.controller.clickComposerPrimaryButton('queue'), /queue_unavailable/);
  await f.controller.interrupt();
  assert.equal(f.getClicked(), f.primary);
  f.setModernAction('dictation');
  await assert.rejects(f.controller.clickComposerPrimaryButton('queue'), /queue_unavailable/);
});

test('current Composer does not click if the action changes between readiness and click', async () => {
  const f = fixture(34, 'follow-up', true, false, true);
  const evaluate = f.controller.evaluate;
  f.controller.evaluate = (source) => {
    const result = evaluate(source);
    if (source.startsWith('Boolean(')) f.setModernAction('stop');
    return result;
  };
  await assert.rejects(f.controller.clickComposerPrimaryButton('queue'), /CDP target element not found/);
  assert.equal(f.getClicked(), null);
});
