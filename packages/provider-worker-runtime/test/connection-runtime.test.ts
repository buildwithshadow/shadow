import { expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, keccak256, toBytes } from 'viem';
import { floatAbi, DOMAIN_NAME, DOMAIN_VERSION, SPEND_INTENT_TYPE_STRING } from '../../../app/scripts/float-mainnet-config.mjs';
import { hashManifest, productionConnectionSource } from '../src/verified-connection.ts';
import { readProviderConfig } from '../src/config.ts';

for (const mode of ['verified','wrong-chain','wrong-code'] as const) {
 it(`production connection over Workers upgrade: ${mode}`,async()=>{
  const code='0x60016000',address='0x00000000000000000000000000000000000000c1';
  const manifest=JSON.stringify({ok:true,chainId:5042002,contract:{address},bytecode:{onchainRuntimeKeccak256:keccak256(code)},deployment:{blockNumber:'1'}});
  const vars={DEPLOYMENT:'synthetic',PROVIDER:'0x00000000000000000000000000000000000000a1',CHAIN_ID:'5042002',CONTRACT:address,ENDPOINT_HASH:'0x'+'11'.repeat(32),PRICE:'1',MANIFEST_APPROVED_SHA256:hashManifest(new TextEncoder().encode(manifest)),MANIFEST_JSON:manifest,RPC_WSS_URL:'wss://rpc.example.test/private-endpoint-token'};
  const parsed=readProviderConfig(vars);if(!parsed.ok)throw Error('invalid fixture');
  const pair=new WebSocketPair();pair[1].accept();const methods:string[]=[];
  pair[1].addEventListener('message',event=>{
   const request=JSON.parse(String(event.data));methods.push(request.method);
   let result:unknown;
   if(request.method==='eth_chainId')result=mode==='wrong-chain'?'0x1':'0x4cef52';
   else if(request.method==='eth_getCode')result=mode==='wrong-code'?'0x6002':code;
   else if(request.method==='eth_call'){
    const fn=decodeFunctionData({abi:floatAbi,data:request.params[0].data}).functionName;
    const expected:Record<string,unknown>={NAME_HASH:keccak256(toBytes(DOMAIN_NAME)),VERSION_HASH:keccak256(toBytes(DOMAIN_VERSION)),SPEND_INTENT_TYPEHASH:keccak256(toBytes(SPEND_INTENT_TYPE_STRING)),deploymentChainId:5042002n};
    result=encodeFunctionResult({abi:floatAbi,functionName:fn,result:expected[fn]});
   } else throw Error('unexpected request');
   pair[1].send(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  const fetchMock=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,options)=>{expect(options).toMatchObject({redirect:'manual',headers:{Upgrade:'websocket'}});return new Response(null,{status:101,webSocket:pair[0]});});
  const bundle=await productionConnectionSource(vars,parsed.config);if(!bundle)throw Error('no connection');
  try {
   if(mode==='verified'){
    const connection=await bundle.connect();expect(connection.chainId).toBe(5042002n);expect(connection.address.toLowerCase()).toBe(address);
    expect(methods).toEqual(['eth_chainId','eth_getCode','eth_call','eth_call','eth_call','eth_call']);
   }else await expect(bundle.connect()).rejects.toThrow('deployment verification failed');
   expect(fetchMock).toHaveBeenCalledTimes(1);
  }finally{bundle.close?.();fetchMock.mockRestore();pair[1].close(1000);}
  expect(pair[0].readyState).not.toBe(1);
 });
}
