'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {questionReadExpression}=require('../question_surface');
function fixture(overrides={}) {
 const id='["request_user_input_async","call_test",0]';
 const key={threadId:'01a171ba-82ae-73f1-8cc9-d60273101704',entityKey:'tail:test',itemId:id};
 const panel={questions:[{id,question:'今晚想吃什么？',options:['火锅','日料'],draft:''}],questionIndex:0,hasSubmitted:false,isSubmitting:false,onDraftChange(){throw Error('read must not mutate')},onSubmit(){throw Error('read must not submit')},onSkip(){throw Error('read must not skip')},...overrides};
 const root={memoizedProps:{questionKey:key}};
 const parent={memoizedProps:panel,return:root};
 const owner={memoizedProps:{questionAndOptions:[{question:{$$typeof:Symbol.for('react.transitional.element')},options:[{id:'0',value:'火锅'}]}],onSubmit(){}},return:parent};
 const el={__reactFiber$test:owner,closest(){return null},getBoundingClientRect(){return {width:10,height:10}}};
 return vm.runInNewContext(questionReadExpression(),{document:{querySelectorAll(){return [el]}},Date});
}
test('async question uses native question identity and plain source text without invoking callbacks',()=>{
 const result=fixture();assert.equal(result.questions[0].question,'今晚想吃什么？');assert.equal(result.questions[0].options[1].label,'日料');assert.equal(result.conversation_id,'01a171ba-82ae-73f1-8cc9-d60273101704');
});
for(const overrides of [{hasSubmitted:true},{isSubmitting:true},{questionIndex:3},{questions:[{id:'other',question:'x',options:[]}]}])test('rejects stale or inactive async question '+JSON.stringify(overrides),()=>assert.equal(fixture(overrides),null));
