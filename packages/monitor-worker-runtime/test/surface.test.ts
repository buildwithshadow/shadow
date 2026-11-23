import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import handler,{MonitorAdmin,MonitorRead} from '../src/worker.mjs';
it('keeps read and administrative capabilities separate and exposes no public HTTP control',async()=>{
 const names=(cls:{prototype:object})=>Object.getOwnPropertyNames(cls.prototype).filter(name=>name!=='constructor').sort();
 expect(names(MonitorRead)).toEqual(['admissionState','status']);
 expect(names(MonitorAdmin)).toEqual(['acknowledge','arm','exportState','initialize','recoverInterrupted','stop','usage']);
 expect((await handler.fetch()).status).toBe(404);
});

it('routes the independent scheduled trigger to the approved monitor identity',async()=>{
 const manifest='1'.repeat(64),baseline='2'.repeat(64);
 const routes:string[]=[];
 const env={MANIFEST_APPROVED_SHA256:manifest,BASELINE_APPROVED_SHA256:baseline,
  MONITOR:{getByName(name:string){routes.push(name);return {async watchdog(){routes.push('watchdog');}};}}};
 await handler.scheduled({},env);
 expect(routes).toEqual([createHash('sha256').update(`${manifest}:${baseline}`).digest('hex'),'watchdog']);
});
