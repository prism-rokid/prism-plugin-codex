'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { CodexDesktopController } = require('../codex_cdp');
const { __test } = require('../index');

const THREAD = '01a08be7-f4a0-7e23-b8aa-6f16d6773657';
const PLAN = '# Test plan\n\nReturn a single line.';

function fixture() {
  const state = { body: PLAN, foreground: THREAD, active: true, submits: [], draft: '' };
  const element = () => ({
    closest: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    getAttribute: () => THREAD
  });
  const button = element(), card = element();
  const marker = { ...element(), parentElement: element(), getAttribute: () => state.foreground };
  const context = vm.createContext({ window: {}, document: { querySelectorAll(selector) {
    if (selector === '[data-above-composer-conversation-id]') return [marker];
    if (selector === '[data-plan-selection-surface]') return state.noCard ? [] : [card];
    return state.active ? [button] : [];
  } } });
  function commit() {
    const request = { type: 'implementPlan', id: 'request', turnId: 'turn', planContent: state.body };
    button.__reactFiber$test = { memoizedProps: {
      isPlanMode: true, isImmediateResponse: true, isBusy: state.busy,
      questionAndOptions: [{ options: [{ id: 'implement-plan' }] }],
      onFreeformChange(text, previous) {
        assert.equal(previous, state.draft);
        state.draft = text;
      },
      onSubmit(drafts) {
        if (drafts[0].freeformText) assert.equal(drafts[0].freeformText, state.draft);
        state.submits.push(JSON.parse(JSON.stringify(drafts)));
        if (!state.keepPending) state.active = false;
      }
    }, return: { memoizedProps: { conversationId: THREAD, pendingRequest: request } } };
    card.__reactFiber$test = { memoizedProps: { turnId: request.turnId,
      item: { type: 'proposed-plan', content: state.editedBody ?? state.body, completed: true },
      isThreadPreviewCollapsed: state.editing } };
  }
  commit();
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async expression => vm.runInContext(expression, context);
  controller.waitFor = async expression => assert.ok(await controller.evaluate(expression), 'native plan must resolve');
  return { state, commit, controller };
}

test('live native plan publishes a review and invokes the selected implementation exactly once', async () => {
  const { controller, state } = fixture();
  const review = await controller.readInteractiveSurface();
  assert.equal(review.kind, 'plan_review');
  assert.equal(review.description, PLAN);
  assert.ok(!Object.hasOwn(review, '_requestId'));
  assert.equal(__test.interactiveSurfaceForForeground({}, null, THREAD, review), review);
  const implement = review.actions[0];
  assert.equal(implement.available, true);
  await assert.rejects(controller.applyInteractiveSurface(review.surface_id, implement.action_id, 'unexpected'), /invalid response|invalid plan review response/);
  await controller.applyInteractiveSurface(review.surface_id, implement.action_id);
  assert.deepEqual(state.submits, [[{ selectedOptionId: 'implement-plan' }]]);
  await assert.rejects(controller.applyInteractiveSurface(review.surface_id, implement.action_id), /no longer available/);
});

test('feedback uses the native freeform plan response and rejects empty feedback', async () => {
  const { controller, state } = fixture();
  const review = await controller.readInteractiveSurface();
  const revise = review.actions[1];
  assert.equal(revise.requires_input, true);
  await assert.rejects(controller.applyInteractiveSurface(review.surface_id, revise.action_id, ' '), /invalid plan review response/);
  await controller.applyInteractiveSurface(review.surface_id, revise.action_id, '  Check the offline case.  ');
  assert.deepEqual(state.submits, [[{ freeformText: 'Check the offline case.' }]]);
});

test('replaced, background, busy and edited plans cannot receive a stale approval', async () => {
  const { controller, state, commit } = fixture();
  const initial = await controller.readInteractiveSurface();
  for (const change of [
    { body: '# Different plan' },
    { body: PLAN, foreground: '01a08be7-f4a0-7e23-b8aa-6f16d6773650' },
    { foreground: THREAD, busy: true },
    { busy: false, editing: true },
    { editing: false, editedBody: '# Desktop revision' },
    { editedBody: undefined, noCard: true }
  ]) {
    Object.assign(state, change);
    commit();
    await assert.rejects(controller.applyInteractiveSurface(initial.surface_id, initial.actions[0].action_id), /no longer available/);
  }
  assert.deepEqual(state.submits, []);
});
