"use strict";

// Contract verified against request-user-input-panel in Desktop 26.1021.31345.
// Only the mounted native question renderer is supported; arbitrary dialogs,
// permission prompts and questionnaire variants remain outside this capability.
function questionOwnerSource(foregroundExpression = '') {
  return `
    const questionOwn = (value, key) => {
      try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
    };
    const questionVisible = (el) => {
      if (!el || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    };
    // DOM pointers may reference either Fiber alternate. Resolve the committed
    // branch using React's root.current and shared-child bailout rules, without
    // walking the entire application tree on each watcher poll.
    // https://github.com/facebook/react/blob/main/packages/react-reconciler/src/ReactFiberTreeReflection.js
    const questionStats = {scannedInputs:0, resolvedInputs:0, renderers:0, asyncPanels:0, asyncKeys:0, inactive:0, invalid:0};
    const questionFiberCache = new Map();
    const questionCurrentFiber = fiber => {
      if (!fiber) return null;
      const alternate = questionOwn(fiber, 'alternate');
      if (!alternate) return fiber;
      let a = fiber, b = alternate;
      for (let depth = 0; depth < 256; depth++) {
        const parentA = questionOwn(a, 'return');
        if (!parentA) {
          const current = questionOwn(questionOwn(a, 'stateNode'), 'current');
          return current === a ? fiber : current === b ? alternate : null;
        }
        const parentB = questionOwn(parentA, 'alternate');
        if (!parentB) {
          const next = questionOwn(parentA, 'return');
          if (!next) return null;
          a = b = next;
          continue;
        }
        const childA = questionOwn(parentA, 'child'), childB = questionOwn(parentB, 'child');
        if (childA === childB) {
          let child = childA;
          for (let n = 0; child && n < 50000; n++, child = questionOwn(child, 'sibling')) {
            if (child === a) return fiber;
            if (child === b) return alternate;
          }
          return null;
        }
        if (questionOwn(a, 'return') !== questionOwn(b, 'return')) {
          a = parentA; b = parentB;
        } else {
          let found = false;
          for (const parent of [parentA, parentB]) {
            let child = questionOwn(parent, 'child');
            for (let n = 0; child && n < 50000; n++, child = questionOwn(child, 'sibling')) {
              if (child === a) { a = parent; b = parent === parentA ? parentB : parentA; found = true; break; }
              if (child === b) { b = parent; a = parent === parentA ? parentB : parentA; found = true; break; }
            }
            if (found) break;
          }
          if (!found) return null;
        }
        if (questionOwn(a, 'alternate') !== b) return null;
      }
      return null;
    };
    const questionFiber = fiber => {
      if (!fiber) return null;
      if (!questionFiberCache.has(fiber)) questionFiberCache.set(fiber, questionCurrentFiber(fiber));
      return questionFiberCache.get(fiber);
    };
    const questionThreadId = value => { const text = String(value || '').trim(); const match = text.match(/(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i); return match ? match[1] : text; };
    const questionOwners = new Map();
    const questionVisited = new Set();
    for (const el of [...document.querySelectorAll('button, textarea, input, [contenteditable="true"]')].filter(questionVisible).slice(0, 1200)) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      let fiber = questionFiber(key ? questionOwn(el, key) : null);
      questionStats.scannedInputs++;
      if (fiber) questionStats.resolvedInputs++;
      for (let depth = 0; fiber && depth < 64; depth++, fiber = questionFiber(questionOwn(fiber, 'return'))) {
        if (questionVisited.has(fiber)) break;
        questionVisited.add(fiber);
        const props = questionOwn(fiber, 'memoizedProps');
        const questions = questionOwn(props, 'questionAndOptions');
        const submit = questionOwn(props, 'onSubmit');
        if (!Array.isArray(questions) || !questions.length || questions.length > 20 || typeof submit !== 'function') continue;
        questionStats.renderers++;
        let parent = questionFiber(questionOwn(fiber, 'return')), context = null;
        for (let n = 0; parent && n < 64; n++, parent = questionFiber(questionOwn(parent, 'return'))) {
          const p = questionOwn(parent, 'memoizedProps');
          const request = questionOwn(p, 'request');
          if (questionOwn(request, 'kind') === 'questions' && questionOwn(p, 'conversationId')) { context = p; break; }
        }
        if (!context) {
          let node = questionFiber(questionOwn(fiber, 'return')), panel = null, key = null;
          for (let n = 0; node && n < 64; n++, node = questionFiber(questionOwn(node, 'return'))) {
            const p = questionOwn(node, 'memoizedProps');
            if (!panel && Array.isArray(questionOwn(p, 'questions')) && typeof questionOwn(p, 'onDraftChange') === 'function' && typeof questionOwn(p, 'onSubmit') === 'function' && typeof questionOwn(p, 'onSkip') === 'function') panel = p;
            const candidate = questionOwn(p, 'questionKey');
            if (candidate && questionOwn(candidate, 'threadId') && questionOwn(candidate, 'entityKey') && questionOwn(candidate, 'itemId')) { key = candidate; break; }
          }
          if (panel) questionStats.asyncPanels++;
          if (key) questionStats.asyncKeys++;
          if (panel && panel.hasSubmitted) questionStats.inactive++;
          if (panel && key && !panel.hasSubmitted) {
            const index = panel.questionIndex;
            const q = panel.questions[index];
            if (Number.isInteger(index) && q && q.id === key.itemId && typeof q.question === 'string' && Array.isArray(q.options) && q.options.length <= 100 && q.options.every(o => typeof o === 'string')) {
              const rows = [{id: q.id, question: q.question, multiple: false, allow_custom: true, placeholder: '', options: q.options.map((label, i) => ({id: String(i), label}))}];
              questionOwners.set(fiber, {props, panel, mode: 'async', submit: panel.onSubmit, skip: panel.onSkip, conversationId: key.threadId, requestId: key.itemId, request: {messageId: key.entityKey}, rows});
            } else questionStats.invalid++;
          }
          continue;
        }
        const request = questionOwn(context, 'request');
        const metadata = questionOwn(request, 'nativeRequestMetadata');
        const requestId = questionOwn(metadata, 'request_id');
        const questionIds = questionOwn(metadata, 'question_ids');
        if (!context || !requestId || !questionOwn(request, 'messageId') || questionOwn(request, 'questionnaire') != null
          || !Array.isArray(questionIds) || questionIds.some(id => typeof id !== 'string' || !id) || questionIds.length !== questions.length || new Set(questionIds).size !== questionIds.length
          || questionOwn(context, 'submissionDisabled') === true || questionOwn(props, 'submissionDisabled') === true
          || (questionOwn(metadata, 'expires_at') != null && questionOwn(metadata, 'expires_at') * 1000 <= Date.now())) continue;
        const rows = questions.map((q, index) => {
          const options = questionOwn(q, 'options');
          if (!Array.isArray(options) || options.length > 100 || typeof questionOwn(q, 'question') !== 'string') return null;
          const values = options.map(o => ({id: questionOwn(o, 'id'), label: questionOwn(o, 'value')}));
          if (values.some(o => typeof o.id !== 'string' || !o.id || typeof o.label !== 'string' || !o.label) || new Set(values.map(o => o.id)).size !== values.length) return null;
          return {id: questionIds[index], question: q.question, multiple: q.isMultiSelect === true, allow_custom: q.isOther === true, placeholder: q.otherPlaceholder || '', options: values};
        });
        if (rows.some(q => !q || (!q.options.length && !q.allow_custom))) continue;
        questionOwners.set(fiber, {props, submit, request, conversationId: context.conversationId, requestId, rows});
      }
    }
    const questionIdentity = owner => owner ? JSON.stringify([questionThreadId(owner.conversationId), owner.mode === 'async' ? 'request_user_input_async' : owner.request.messageId, owner.requestId, owner.rows]) : '';
    const questionForeground = ${foregroundExpression || 'null'};
    const questionRequests = new Map();
    for (const owner of questionOwners.values()) {
      if (questionForeground !== null && questionThreadId(owner.conversationId) !== questionThreadId(questionForeground)) continue;
      questionRequests.set(questionIdentity(owner), owner);
    }
    const questionOwner = questionRequests.size === 1 ? [...questionRequests.values()][0] : null;
    const questionDiagnostics = { ownerCount: questionOwners.size, requestCount: questionRequests.size, ...questionStats,
      reason: questionOwner ? 'ready' : questionRequests.size > 1 ? 'ambiguous' : questionOwners.size ? 'background' : 'not_found' };
  `;
}

function questionReadExpression() {
  return `(() => { ${questionOwnerSource()} return questionOwner ? {identity: questionIdentity(questionOwner), conversation_id: questionOwner.conversationId, questions: questionOwner.rows, submitting: questionOwner.panel?.isSubmitting === true} : null; })()`;
}

function validateQuestionAnswers(questions, encoded, skip = false) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('control_target_stale: questions unavailable');
  if (skip) return questions.map(() => ({}));
  if (typeof encoded !== 'string' || encoded.length > 65536) throw new Error('question_answer_invalid: answer too large');
  let payload;
  try { payload = JSON.parse(encoded); } catch { throw new Error('question_answer_invalid: malformed answers'); }
  if (!payload || !Array.isArray(payload.answers) || payload.answers.length !== questions.length) throw new Error('question_answer_invalid: answer count mismatch');
  return questions.map((q, index) => {
    const answer = payload.answers[index];
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('question_answer_invalid: invalid answer');
    if (answer.skip === true) return {};
    const selected = answer.selectedOptionIds;
    const freeform = answer.freeformText === undefined ? '' : answer.freeformText;
    if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string' || !q.options.some(o => o.id === id))
      || new Set(selected).size !== selected.length || (!q.multiple && selected.length > 1)
      || typeof freeform !== 'string' || freeform.length > 8192 || (freeform.trim() && !q.allow_custom)
      || (!selected.length && !freeform.trim())) throw new Error('question_answer_invalid: unsupported or empty answer');
    return {...(q.multiple ? {selectedOptionIds: selected} : selected.length ? {selectedOptionId: selected[0]} : {}), ...(freeform.trim() ? {freeformText: freeform.trim()} : {})};
  });
}

module.exports = {questionOwnerSource, questionReadExpression, validateQuestionAnswers};
