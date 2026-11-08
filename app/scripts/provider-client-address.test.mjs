import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request} from 'node:http';
import {createProviderServer} from '../../examples/float-mainnet-provider-server/server.mjs';
const address='0x0000000000000000000000000000000000000001';
const endpointHash='0x'+'11'.repeat(32);
const recordStore={read:()=>null,putOnce:()=>{throw Error('no writes');},list:()=>[],has:()=>false,assertConsistent:()=>{},describe:()=>({})};
const options={connection:{chainId:31337n,address,client:{}},account:{address},endpointHash,price:1n,recordStore,service:()=>{throw Error('no work');},recoveryOnly:true,publicOrigin:'https://provider.example',maxRequestsPerMinute:2};
async function withServer(extra,fn) {
 const server=createProviderServer({...options,...extra});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const send=(headers={})=>new Promise((resolve,reject)=>{
  const req=request(`http://127.0.0.1:${server.address().port}/accept`,{method:'POST',headers,agent:false},res=>{
   let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));
  });req.on('error',reject);req.end('{}');
 });
 try {await fn(send);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('trusted request-local caller identities keep rate buckets separate',async()=>{
 const identities={alpha:'192.0.2.1',beta:'192.0.2.2'};
 await withServer({clientAddress:req=>identities[req.headers['x-fixture-identity']]},async send=>{
  for(let i=0;i<2;i++){
   const results=await Promise.all(Object.keys(identities).map(id=>send({'x-fixture-identity':id,'x-forwarded-for':'198.51.100.'+(i+1)})));
   assert.deepEqual(results.map(r=>r.status),[503,503]);
  }
  assert.deepEqual((await Promise.all(Object.keys(identities).map(id=>send({'x-fixture-identity':id})))).map(r=>r.status),[429,429]);
 });
});
test('missing, nonliteral and failed embedding identities are refused without fallback',async()=>{
 for(const value of [null,undefined,'','unknown','1.2.3.4, 5.6.7.8','[::1]','fe80::1%en0','1.2.3.4:80','x'.repeat(100)]){
  await withServer({clientAddress:()=>value,trustLoopbackProxy:true},async send=>{
   const result=await send({'x-shadow-client-ip':'192.0.2.10'});assert.equal(result.status,400,String(value));assert.match(result.body,/Missing trusted client/);
  });
 }
 await withServer({clientAddress:()=>{throw Error('sensitive callback error');}},async send=>{
  const result=await send();assert.equal(result.status,400);assert.doesNotMatch(result.body,/sensitive/);
 });
 await withServer({clientAddress:()=>Promise.reject(Error('late callback error'))},async send=>{
  assert.equal((await send()).status,400);
 });
});
test('default caller resolution is unchanged when no adapter is supplied',async()=>{
 await withServer({},async send=>{assert.equal((await send()).status,503);});
 await withServer({trustLoopbackProxy:true},async send=>{
  assert.equal((await send()).status,400);assert.equal((await send({'x-shadow-client-ip':'192.0.2.10'})).status,503);
 });
});
test('hosting callback configuration must be explicit and synchronous',()=>{
 for(const clientAddress of ['192.0.2.1',{},true])assert.throws(()=>createProviderServer({...options,clientAddress}),/must be a function/);
});
