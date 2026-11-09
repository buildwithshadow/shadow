import { createReadonlyTransport } from '../../rpc-read-websocket/src/transport.ts';
import { expect, it } from 'vitest';
import { workerSocket } from '../src/verified-connection.ts';
it('removes adapted Workers socket listeners exactly and closes its socket',()=>{
 const pair=new WebSocketPair();
 pair[0].accept();pair[1].accept();
 const socket=workerSocket(pair[0]);
 const messages:unknown[]=[];let closes=0;
 const listener=(event:{data?:unknown})=>messages.push(event.data);
 const closed=()=>{closes++;};
 socket.addEventListener('message',listener);
 socket.addEventListener('message',listener);
 pair[0].dispatchEvent(new MessageEvent('message',{data:'first'}));
 expect(messages).toEqual(['first']);
 socket.removeEventListener('message',listener);
 pair[0].dispatchEvent(new MessageEvent('message',{data:'ignored'}));
 expect(messages).toEqual(['first']);
 socket.addEventListener('close',closed);
 socket.removeEventListener('close',closed);
 pair[0].dispatchEvent(new CloseEvent('close'));
 expect(closes).toBe(0);
 socket.close(4002,'protocol error');pair[1].close(1000);
 expect(socket.readyState).not.toBe(1);
});

it('composes accepted Workers sockets with the maintained transport open lifecycle',async()=>{
 const pair=new WebSocketPair();pair[0].accept();pair[1].accept();
 pair[1].addEventListener('message',event=>{
   const request=JSON.parse(String(event.data));
   pair[1].send(JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x13b2'}));
 });
 const transport=createReadonlyTransport({connect:()=>workerSocket(pair[0]),connectAttempts:1});
 try {expect(await transport.request({method:'eth_chainId'})).toBe('0x13b2');}
 finally {transport.close();pair[1].close(1000);}
 expect(transport.stats()).toMatchObject({pending:0,open:false,timers:0,waiters:0,slots:0});
});
