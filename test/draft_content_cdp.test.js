const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { __test } = require('../codex_cdp');

function readDraft({ text = '', value, attachments = false, editors = 1, disabled = false, editorIsContainer = false, controlText = 'Plan Model Context' } = {}) {
  const visible = extra => ({
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    getAttribute: () => null,
    closest: () => null,
    matches: () => false,
    querySelectorAll: () => [],
    ...extra,
  });
  const editor = visible({ innerText: text, value, disabled });
  const container = visible({
    innerText: editorIsContainer ? text : controlText,
    value: editorIsContainer ? value : undefined,
    matches: () => editorIsContainer,
    querySelectorAll: () => Array.from({ length: editorIsContainer ? 0 : editors }, () => editor),
  });
  const card = visible({ classList: { contains: () => true }, innerText: 'local-file.png' });
  const document = {
    querySelectorAll: selector => selector === '.composer-attachment-surface'
      ? (attachments ? [card] : []) : [container],
  };
  return vm.runInNewContext(`(() => { ${__test.composerDraftContentStateSource()} return prismComposerDraftContentState(); })()`, { document });
}

test('draft emptiness ignores surrounding model and plan control text', () => {
  const state = readDraft();
  assert.equal(state.composer_text, '');
  assert.equal(state.composer_available, true);
  assert.equal(state.composer_has_attachments, false);
});

test('draft content preserves native text and textarea values', () => {
  assert.equal(readDraft({ text: 'unsent work' }).composer_text, 'unsent work');
  assert.equal(readDraft({ value: 'textarea work' }).composer_text, 'textarea work');
});

test('attachment-only drafts are explicitly non-empty', () => {
  assert.equal(readDraft({ attachments: true }).composer_has_attachments, true);
});

for (const options of [{ editors: 0 }, { editors: 2 }, { disabled: true }]) {
  test(`unreadable or ambiguous draft editor fails closed ${JSON.stringify(options)}`, () => {
    const state = readDraft(options);
    assert.equal(state.composer_available, false);
    assert.equal(state.composer_text, null);
  });
}

// Legacy Desktop marks the editable itself as the Composer container.
test('draft content reads an editable container itself', () => {
  assert.equal(readDraft({ editorIsContainer: true, text: 'legacy draft' }).composer_text, 'legacy draft');
  assert.equal(readDraft({ editorIsContainer: true }).composer_text, '');
});

test('an editor without readable text fails closed', () => {
  const state = readDraft({ text: null });
  assert.equal(state.composer_text, null);
  assert.equal(state.composer_available, false);
});
