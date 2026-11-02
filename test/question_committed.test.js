'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { questionReadExpression, questionOwnerSource } = require('../question_surface');
const { CodexDesktopController } = require('../codex_cdp');

const THREAD = '01a08be7-f4a0-7e23-b8aa-6f16d6773657';
const ITEM = '["request_user_input_async","call_speed",0]';

function fixture() {
  const rootState = { current: null };
  let graph = null;
  const element = { closest() { return null; }, getBoundingClientRect() { return { width: 10, height: 10 }; } };
  const marker = { parentElement: element, getAttribute() { return state.foreground || THREAD; } };
  const context = vm.createContext({ document: { querySelectorAll(selector) {
    return selector === '[data-above-composer-conversation-id]' ? [marker] : [element];
  } }, window: {}, Date });
  const state = { submitted: 0, skipped: 0, drafted: '', failSubmit: false, options: {} };
  function commit(options = {}) {
    state.options = { ...state.options, ...options };
    const o = state.options;
    const key = { threadId: o.threadId || THREAD, entityKey: o.entityKey || 'tail:active', itemId: o.itemId || ITEM };
    const panel = { questions: [{ id: key.itemId, question: o.question || '光速是多少？', options: ['三千', '三十万'], draft: o.draft || '' }],
      questionIndex: 0, hasSubmitted: o.hasSubmitted || false, isSubmitting: o.isSubmitting || false,
      onDraftChange(text) { if(state.failDraft)throw Error('draft write failed'); state.drafted = text; if(state.deferDraft){state.pendingDraft=text;return;} commit({ draft: text, entityKey: 'committed:turn' }); },
      onSubmit() { state.nativeDraft = state.drafted; state.submitted++; if (state.failSubmit) throw Error('native result unknown'); commit(state.deferSubmit ? {isSubmitting:true} : { hasSubmitted: true }); },
      onSkip() { state.skipped++; commit({ hasSubmitted: true }); } };
    const next = graph && graph[0].alternate ? graph.map(node => node.alternate) : Array.from({length:5}, () => ({}));
    const [root, keyFiber, panelFiber, renderer, host] = next;
    Object.assign(root, { tag: 3, stateNode: rootState, return: null });
    Object.assign(keyFiber, { memoizedProps: { questionKey: key }, return: root });
    Object.assign(panelFiber, { memoizedProps: panel, return: keyFiber });
    Object.assign(renderer, { memoizedProps: { questionAndOptions: [{}], onSubmit() { throw Error('wrong renderer callback'); } }, return: panelFiber });
    Object.assign(host, { memoizedProps: {}, return: renderer });
    root.child = keyFiber; keyFiber.child = panelFiber; panelFiber.child = renderer; renderer.child = host;
    if (graph) next.forEach((node, i) => { node.alternate = graph[i]; graph[i].alternate = node; });
    if (!element.__reactFiber$test) element.__reactFiber$test = host;
    graph = next; rootState.current = root;
    return next;
  }
  commit();
  const evaluate = expression => vm.runInContext(expression, context);
  const controller = Object.create(CodexDesktopController.prototype);
  controller.evaluate = async expression => evaluate(expression);
  controller.waitFor = async expression => { if (!await evaluate(expression)) throw Error('condition not committed'); };
  return { commit, evaluate, controller, state, element, rootState, graph: () => graph };
}

test('DOM fiber can point to the previous submitted question while committed alternate is pending', () => {
  const f = fixture(); f.commit({ hasSubmitted: true });
  // Keep a stale DOM pointer whose parents carry submitted state.
  f.element.__reactFiber$test = f.graph().at(-1);
  f.commit({ hasSubmitted: false });
  const result = f.evaluate(questionReadExpression());
  assert.equal(result.questions[0].question, '光速是多少？');
});

test('request identity survives container rekey and thread prefix changes', async () => {
  const f = fixture(); const first = await f.controller.readQuestionSurface();
  f.commit({ entityKey: 'turn:complete', threadId: 'local:' + THREAD });
  f.element.__reactFiber$test = f.graph().at(-1);
  const updated = await f.controller.readQuestionSurface();
  assert.equal(updated.surface_id, first.surface_id);
  f.commit({ itemId: '["request_user_input_async","call_next",0]' });
  f.element.__reactFiber$test = f.graph().at(-1);
  assert.notEqual((await f.controller.readQuestionSurface()).surface_id, first.surface_id);
});

test('answers use the committed callback after drafting commits a new React tree', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface();
  await f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', JSON.stringify({ answers: [{ selectedOptionIds: ['1'], freeformText: '', skip: false }] }));
  assert.equal(f.state.drafted, '三十万');
  assert.equal(f.state.submitted, 1);
  assert.equal(await f.controller.readQuestionSurface(), null);
});

test('skip invokes the native skip once, and stale identity does not invoke callbacks', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface();
  f.commit({ itemId: '["request_user_input_async","call_next",0]' });
  await assert.rejects(f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':skip', ''), /question changed/);
  assert.equal(f.state.skipped, 0);
  const next = await f.controller.readQuestionSurface();
  await f.controller.applyQuestionSurface(next.surface_id, next.surface_id + ':skip', '');
  assert.equal(f.state.skipped, 1);
});

test('a failed draft write does not permanently consume the question', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface();
  f.state.failDraft = true;
  const input = JSON.stringify({ answers: [{ selectedOptionIds: ['0'], freeformText: '', skip: false }] });
  await assert.rejects(f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', input), /draft write failed/);
  assert.equal(f.state.submitted, 0);
  f.state.failDraft = false;
  await f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', input);
  assert.equal(f.state.submitted, 1);
});

test('unknown failure after native submit must not replay the answer', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface(); f.state.failSubmit = true;
  const input = JSON.stringify({ answers: [{ selectedOptionIds: ['1'], freeformText: '', skip: false }] });
  await assert.rejects(f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', input), /native result unknown/);
  await assert.rejects(f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', input), /already submitted/);
  assert.equal(f.state.submitted, 1);
});

test('a shared bailout subtree resolves each stale return pointer to the committed parent', () => {
  const f = fixture(); const old = f.graph();
  const next = f.commit({ question: '更新后的题目' });
  // React can reuse the host child without updating its return pointer.
  next[3].child = old[4];
  const result = f.evaluate(questionReadExpression());
  assert.equal(result.questions[0].question, '更新后的题目');
});

test('multiple visible renderers of the same request are deduplicated', () => {
  const f = fixture(); const nodes = f.graph();
  const renderer = { ...nodes[3], child: null };
  const host = { return: renderer }; renderer.child = host; nodes[3].sibling = renderer;
  const el = { ...f.element, __reactFiber$test: host };
  // Both renderer fibers share one native panel/key and therefore one request.
  const value = vm.runInNewContext(`(() => { ${questionOwnerSource()} return {owner:!!questionOwner, diagnostics:questionDiagnostics}; })()`, {
    document: { querySelectorAll() { return [f.element, el]; } }, Date
  });
  assert.equal(value.owner, true);
  assert.equal(value.diagnostics.requestCount, 1);
});

test('native submitting state is not mistaken for a consumed question', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface(); f.state.deferSubmit = true;
  const waitFor = f.controller.waitFor; let completionChecked = false;
  f.controller.waitFor = async expression => {
    if (f.state.submitted) {
      assert.equal(f.evaluate(expression), false, 'network in flight is not success');
      const pending = await f.controller.readQuestionSurface();
      assert.equal(pending.surface_id, s.surface_id);
      assert.ok(pending.actions.every(action => !action.available));
      completionChecked = true;
      f.commit({isSubmitting:false,hasSubmitted:true});
    }
    return waitFor(expression);
  };
  await f.controller.applyQuestionSurface(s.surface_id, s.surface_id + ':submit', JSON.stringify({answers:[{selectedOptionIds:['1'],freeformText:'',skip:false}]}));
  assert.equal(completionChecked, true);
});

test('a background conversation cannot hide or supply the foreground question', () => {
  const active = fixture(), background = fixture();
  background.commit({threadId:'11111111-1111-4111-8111-111111111111'});
  const result = vm.runInNewContext(`(() => { ${questionOwnerSource(JSON.stringify(THREAD))} return {identity:questionIdentity(questionOwner),diagnostics:questionDiagnostics}; })()`, {
    document:{querySelectorAll(){return [background.element,active.element];}},Date
  });
  assert.equal(result.diagnostics.ownerCount,2);
  assert.equal(result.diagnostics.requestCount,1);
  assert.ok(result.identity.includes(THREAD));
});

test('two distinct visible requests in one conversation remain ambiguous', () => {
  const a = fixture(), b = fixture(); b.commit({itemId:'["request_user_input_async","call_other",0]'});
  const result = vm.runInNewContext(`(() => { ${questionOwnerSource(JSON.stringify(THREAD))} return {owner:!!questionOwner,diagnostics:questionDiagnostics}; })()`, {
    document:{querySelectorAll(){return [a.element,b.element];}},Date
  });
  assert.equal(result.owner,false);
  assert.equal(result.diagnostics.reason,'ambiguous');
});

test('an uncommitted alternate cannot expose a future question', () => {
  const f = fixture(); const committed = f.graph(); f.commit();
  f.element.__reactFiber$test = f.graph().at(-1);
  committed[3].memoizedProps = {};
  f.rootState.current = committed[0];
  assert.equal(f.evaluate(questionReadExpression()),null);
});

test('dictated freeform answers follow the same committed submit path', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface();
  await f.controller.applyQuestionSurface(s.surface_id,s.surface_id+':submit',JSON.stringify({answers:[{selectedOptionIds:[],freeformText:'大约三十万千米每秒',skip:false}]}));
  assert.equal(f.state.drafted,'大约三十万千米每秒');
  assert.equal(f.state.submitted,1);
});

test('native submit reads the updated store before the draft renderer commits', async () => {
  const f = fixture(); const s = await f.controller.readQuestionSurface(); f.state.deferDraft = true;
  const waitFor = f.controller.waitFor;
  f.controller.waitFor = async expression => {
    assert.equal(f.state.submitted,1,'there must be no render wait between writing and submitting');
    return waitFor(expression);
  };
  await f.controller.applyQuestionSurface(s.surface_id,s.surface_id+':submit',JSON.stringify({answers:[{selectedOptionIds:['0'],freeformText:'',skip:false}]}));
  assert.equal(f.state.nativeDraft,'三千');
  assert.equal(f.state.submitted,1);
});

test('switching the foreground during native submission is not completion evidence', async () => {
  const f=fixture();const s=await f.controller.readQuestionSurface();f.state.deferSubmit=true;
  f.controller.waitFor=async expression=>{
    f.state.foreground='11111111-1111-4111-8111-111111111111';
    assert.equal(f.evaluate(expression),false);
    throw Error('completion unknown after navigation');
  };
  await assert.rejects(f.controller.applyQuestionSurface(s.surface_id,s.surface_id+':submit',JSON.stringify({answers:[{selectedOptionIds:['0'],freeformText:'',skip:false}]})),/completion unknown/);
  assert.equal(f.state.submitted,1);
});

test('public question surface does not expose private controller bookkeeping', async()=>{
  const f=fixture();const surface=await f.controller.readInteractiveSurface();
  assert.equal(surface.kind,'questionnaire');
  assert.equal('_identity' in surface,false);
  assert.equal('_conversationId' in surface,false);
});
