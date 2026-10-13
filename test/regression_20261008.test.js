const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { CodexDesktopController } = require('../codex_cdp');
const { __test } = require('../index');

test('one attachment invocation supports the current native wrapper and legacy arrays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-attachment-'));
  const file = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(file, 'unique file content');
  let wrappers = 0, legacy = 0, backedFile;
  let displayName = 'sentinel.txt', nativeMIME = 'text/plain';
  const controller = { pastedFilesHandlers: new Map([
    ['current', ({ files, dataTransfer }) => {
      wrappers++;
      assert.equal(files[0].name, displayName);
      assert.equal(files[0], backedFile, 'native disk-backed File must not be cloned into an in-memory File');
      assert.equal(files[0].type, nativeMIME);
      assert.equal(files[0].path, file);
      assert.equal(dataTransfer.files[0], files[0]);
    }],
    ['legacy', (files) => { legacy++; assert.equal(files.length, 1); }],
  ]) };
  const composer = { getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  composer.parentElement = { __reactFiber$test: { memoizedProps: { composerController: controller } } };
  const inputs = new Map();
  const document = {
    querySelectorAll: () => [composer],
    createElement: () => ({ files: [], remove() { inputs.delete(this.id); } }),
    body: { appendChild: (input) => inputs.set(input.id, input) },
    getElementById: (id) => inputs.get(id),
  };
  class DataTransfer {
    constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; }
  }
  const c = Object.create(CodexDesktopController.prototype);
  c.options = {};
  c.focusComposer = async () => {};
  c.evaluate = async (source) => vm.runInNewContext(source, { document, DataTransfer, Map });
  c.send = async (method, params) => {
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: inputs.has(params.selector.slice(1)) ? 2 : 0 };
    assert.equal(method, 'DOM.setFileInputFiles');
    assert.deepEqual(params.files, [file]);
    backedFile = new File(['unique file content'], '000-native-file', { type: nativeMIME });
    [...inputs.values()][0].files = [backedFile];
    return {};
  };
  c.waitFor = async () => {};
  try {
    await c.attachLocalFile(file, 'sentinel.txt', 'text/plain');
    assert.equal(wrappers, 1); assert.equal(legacy, 1);
    assert.equal(inputs.size, 0);
    displayName = 'sentinel.png'; nativeMIME = 'image/png';
    await c.attachLocalFile(file, displayName, 'application/octet-stream');
    assert.equal(wrappers, 2); assert.equal(legacy, 2);
    assert.equal(inputs.size, 0);
    controller.pastedFilesHandlers = new Map([['bad', () => { throw new Error('native failed'); }]]);
    await assert.rejects(c.attachLocalFile(file, 'sentinel.txt'), /native_attachment_handler_failed.*native failed/);
    assert.equal(inputs.size, 0, 'temporary transport must be removed on native errors too');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('metadata appends preserve terminal identity and a genuinely new task rearms it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-'));
  const file = path.join(dir, 'rollout.jsonl');
  const row = (type, turn_id) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-08T13:00:00Z', payload: { type, turn_id } }) + '\n';
  try {
    fs.writeFileSync(file, row('task_started', 'turn-a') + row('task_complete', 'turn-a'));
    const first = __test.summarizeRolloutChunk(file);
    fs.appendFileSync(file, row('thread_settings_applied', '') + row('token_usage', ''));
    assert.equal(__test.summarizeRolloutChunk(file).terminalID, first.terminalID);
    fs.appendFileSync(file, row('task_started', 'turn-b'));
    assert.equal(__test.summarizeRolloutChunk(file).terminal, false);
    fs.appendFileSync(file, row('task_complete', 'turn-b'));
    assert.equal(__test.summarizeRolloutChunk(file).terminalID, 'turn-b');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy terminal row identity stays stable across unrelated file growth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-legacy-'));
  const file = path.join(dir, 'rollout.jsonl');
  try {
    fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n');
    const id = __test.summarizeRolloutChunk(file).terminalID;
    fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'thread_settings_applied' } }) + '\n');
    assert.equal(__test.summarizeRolloutChunk(file).terminalID, id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('internal environment and integration envelopes are hidden without filtering business prose', () => {
  const message = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  for (const text of ['# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>']) {
    assert.equal(__test.historyMessageFromRolloutRow(message(text), 'thread'), null);
    assert.equal(__test.visibleUserHistoryText(text), '');
  }
  const prose = 'Explain AGENTS.md instructions and external_codex_apps_open_page.';
  assert.equal(__test.historyMessageFromRolloutRow(message(prose), 'thread').Content, prose);
});

test('image-only user messages remain visible and keep the assistant reply in the same turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-image-history-'));
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    {
      type: 'response_item',
      timestamp: '2026-10-12T03:35:37.000Z',
      payload: {
        type: 'message', id: 'image-user', role: 'user',
        content: [{ type: 'input_image', name: 'prism-image-test.png' }],
      },
    },
    {
      type: 'response_item',
      timestamp: '2026-10-12T03:35:42.000Z',
      payload: {
        type: 'message', id: 'image-reply', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'The image contains a test graphic.' }],
      },
    },
  ];
  try {
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const user = __test.historyMessageFromRolloutRow(rows[0], 'thread');
    assert.equal(user.Content, '');
    assert.deepEqual(user.Metadata, { attachments: [{ name: 'prism-image-test.png', kind: 'image' }] });

    const turns = __test.historyTurnsFromTail(file, 'thread');
    assert.equal(turns.length, 1);
    assert.equal(turns[0].messages[0].Role, 'user');
    assert.deepEqual(turns[0].messages[0].Metadata, { attachments: [{ name: 'prism-image-test.png', kind: 'image' }] });
    assert.ok(turns[0].messages.some((message) => message.Role === 'assistant' && message.Content.includes('test graphic')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('late control postcondition is reconciled without a second click', async () => {
  const c = Object.create(CodexDesktopController.prototype);
  c.options = {};
  c.waitFor = async () => { throw new Error('CDP wait timed out'); };
  c.evaluate = async () => true;
  await c.waitForControl('state', 'plan.disable');
  c.evaluate = async () => false;
  await assert.rejects(c.waitForControl('state', 'goal.set postcondition'), /goal.set postcondition did not settle/);
});
