"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test } = require('../index.js');

function row(second, type, payload) {
  return JSON.stringify({ timestamp: `2026-11-20T08:00:${String(second).padStart(2,'0')}.000Z`, type, payload });
}
function message(id, role, text, phase) {
  return { type: 'message', id, role, turn_id: 'native-task', phase,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] };
}
test('completion replaces both the original request and its later question reply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'prism-history-completion-'));
  const file = path.join(dir,'rollout.jsonl');
  const emitted = new Map();
  const updates = () => __test.changedHistoryTurns(__test.historyTurnsFromTail(file,'test-thread',5), emitted);
  try {
    fs.writeFileSync(file,[
      row(0,'event_msg',{type:'task_started',turn_id:'native-task'}),
      row(1,'response_item',message('original','user','检查连接')),
      row(2,'response_item',message('commentary','assistant','正在检查','commentary')),
    ].join('\n')+'\n');
    const initial = updates();
    assert.equal(initial[0].turn.messages.find(m=>m.Type==='progress').Status,'running');
    fs.appendFileSync(file,row(3,'response_item',message('question-reply','user','<send_user_message_question_reply>[{"answer":"现在可以了"}]</send_user_message_question_reply>'))+'\n');
    const continued = updates();
    assert(continued.some(u=>u.operation==='append'&&u.turn.turn_id==='question-reply'));
    fs.appendFileSync(file,[
      row(4,'response_item',message('final','assistant','当前连接正常','final_answer')),
      row(5,'event_msg',{type:'task_complete',turn_id:'native-task'}),
    ].join('\n')+'\n');
    const completed = updates();
    for (const id of ['original','question-reply']) {
      const update = completed.find(u=>u.turn.turn_id===id);
      assert(update, `missing completion for ${id}`);
      assert.equal(update.operation,'replace');
      assert.equal(update.turn.messages.find(m=>m.Type==='progress').Status,'completed');
    }
    assert.deepEqual(updates(),[],'unchanged turns must not be resent');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('revision bookkeeping stays bounded to the requested history window', () => {
  const emitted = new Map([['old',1],['retained',1]]);
  const unchanged = {turn_id:'retained',revision:1};
  assert.deepEqual(__test.changedHistoryTurns([unchanged],emitted),[]);
  assert.equal(emitted.size,1);
  assert.equal(emitted.has('old'),false);
});
