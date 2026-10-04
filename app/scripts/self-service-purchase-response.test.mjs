import assert from 'node:assert/strict';
import test from 'node:test';
import {readBoundedJson} from '../src/boundedResponse.mjs';

test('provider JSON is limited by bytes rather than characters', async()=> {
  const json=JSON.stringify({text:'😀'.repeat(100)});
  await assert.rejects(readBoundedJson(new Response(json),300),/too large/);
  assert.deepEqual(await readBoundedJson(new Response(json),500),{text:'😀'.repeat(100)});
});
test('chunked endless response stops and cancels at the bound',async()=> {
  let reads=0,cancelled=false;
  const stream=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(100));},cancel(){cancelled=true;}},{highWaterMark:0});
  await assert.rejects(readBoundedJson(new Response(stream),250),/too large/);
  assert.equal(reads,3);assert.equal(cancelled,true);
});
test('oversized declared body is cancelled without a read',async()=> {
  let reads=0,cancelled=false;
  const stream=new ReadableStream({pull(){reads++;},cancel(){cancelled=true;}},{highWaterMark:0});
  await assert.rejects(readBoundedJson(new Response(stream,{headers:{'content-length':'1001'}}),1000),/too large/);
  assert.equal(reads,0);assert.equal(cancelled,true);
});
test('invalid JSON, unreadable body and invalid UTF-8 fail closed',async()=> {
  await assert.rejects(readBoundedJson(new Response('not JSON')));
  await assert.rejects(readBoundedJson(new Response(null)),/readable body/);
  await assert.rejects(readBoundedJson(new Response(new Uint8Array([0xff]))));
});
test('JSON split across UTF-8 chunks is parsed once within the byte limit',async()=> {
 const bytes=new TextEncoder().encode('{"text":"😀"}');let cursor=0;
 const stream=new ReadableStream({pull(c){if(cursor===bytes.length)c.close();else c.enqueue(bytes.slice(cursor,++cursor));}});
 assert.deepEqual(await readBoundedJson(new Response(stream),bytes.length),{text:'😀'});
});
