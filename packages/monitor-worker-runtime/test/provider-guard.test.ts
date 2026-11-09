import {env} from 'cloudflare:workers';
import {keccak256} from 'viem';
import {expect,it} from 'vitest';
import {approved} from './fixtures/public-config.mjs';
import {createWorkerProviderMonitorGuard} from '../src/provider-guard.mjs';
it('binds the actual durable public monitor view to the existing canonical admission checks',async()=>{
 const monitor=env.PUBLIC_MONITOR.getByName('composed-guard');await monitor.setup();await monitor.arm();const cycle=(await monitor.due()).result;expect(cycle.ok,JSON.stringify(cycle.alerts)).toBe(true);
 let reads=0,blocks=0,codes=0;
 const connection={chainId:5042n,address:'0x'+'1'.padStart(40,'0'),client:{
  getBlock:async()=>{blocks++;const state=await monitor.admissionState();return {number:BigInt(state.status.observedAt.blockNumber),hash:state.status.observedAt.blockHash,timestamp:BigInt(state.status.observedAt.timestamp)};},
  getCode:async()=>{codes++;return '0x1234';},
 }};
 const guard=createWorkerProviderMonitorGuard(approved(keccak256('0x1234')),connection,{admissionState:async()=>{reads++;return monitor.admissionState();}});
 await guard();expect(reads).toBe(2);expect(blocks).toBe(2);expect(codes).toBe(1);
 await monitor.stop();await expect(guard()).rejects.toThrow('could not be verified');
});
it('cannot use an unapproved local policy or a missing read binding',()=>{
 const vars=approved();
 expect(()=>createWorkerProviderMonitorGuard(vars,{},null)).toThrow('binding unavailable');
 expect(()=>createWorkerProviderMonitorGuard({...vars,BASELINE_JSON:vars.BASELINE_JSON+' '},{},{admissionState:async()=>({})})).toThrow('not approved');
});
