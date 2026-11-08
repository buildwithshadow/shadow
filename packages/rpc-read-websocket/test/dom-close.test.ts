import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createReadonlyTransport} from '../src/transport.ts';
import {FakeSocket,ManualTimers,tick} from './fakes.ts';
import {rejection} from './helpers.ts';
class DomCloseSocket extends FakeSocket {
 override close(code?:number){
  if(code!==undefined&&code!==1000&&(code<3000||code>4999))throw new DOMException('Invalid close code','InvalidAccessError');
  super.close(code);
 }
}
for(const kind of ['malformed','binary','oversized','unmatched'])test(`DOM-compatible socket closes after ${kind} input`,async()=>{
 const socket=new DomCloseSocket();socket.readyState=1;const timers=new ManualTimers();
 const transport=createReadonlyTransport({connect:()=>socket,timers,maxMessageBytes:64,maxUnmatchedReplies:1});
 const result=rejection(transport.request({method:'eth_chainId'}));await tick();
 if(kind==='malformed')socket.receive('{');
 if(kind==='binary')socket.receive(new ArrayBuffer(1));
 if(kind==='oversized')socket.receive('x'.repeat(65));
 if(kind==='unmatched'){socket.reply(999,'0x1');socket.reply(998,'0x1');}
 try{
  const error=await result;assert.equal(error.reason,kind==='oversized'?'message-too-large':'protocol-error');
  assert.equal(socket.readyState,3);assert.equal(socket.listenerCount(),0);assert.equal(timers.outstanding,0);
 }finally{transport.close();}
});
