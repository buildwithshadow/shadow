import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {notificationImport} from '../src/notification-import.mjs';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const context={manifestHash:'a'.repeat(64),baselineHash:'b'.repeat(64)};
const now=1800000000000;
const state=()=>({destinationId:'123',binding:hash(JSON.stringify([context.manifestHash,context.baselineHash])),key:'healthy',codes:[],incidentId:null,sentAt:new Date(now).toISOString()});
const packet=(value:unknown)=>{const bytes=JSON.stringify(value);return {bytes,sha256:hash(bytes)};};
it('imports only independently fingerprinted state for the same identity and destination',()=>{
 expect(notificationImport(context,'123',packet(state()),now)).toEqual(state());
 expect(notificationImport(context,'123',undefined,now)).toBeNull();
});
for(const [name,change] of [
 ['destination',(v:ReturnType<typeof state>)=>({...v,destinationId:'999'})],
 ['release binding',(v:ReturnType<typeof state>)=>({...v,binding:'0'.repeat(64)})],
 ['future timestamp',(v:ReturnType<typeof state>)=>({...v,sentAt:new Date(now+1).toISOString()})],
 ['malformed codes',(v:ReturnType<typeof state>)=>({...v,codes:['not allowed']})],
 ['inconsistent state key',(v:ReturnType<typeof state>)=>({...v,key:'failure:'+'0'.repeat(64)})],
] as const)it(`rejects an imported ${name}`,()=>expect(()=>notificationImport(context,'123',packet(change(state())),now)).toThrow());
