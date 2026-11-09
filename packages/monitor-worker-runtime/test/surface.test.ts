import {expect,it} from 'vitest';
import handler,{MonitorAdmin,MonitorRead} from '../src/worker.mjs';
it('keeps read and administrative capabilities separate and exposes no public HTTP control',async()=>{
 const names=(cls:{prototype:object})=>Object.getOwnPropertyNames(cls.prototype).filter(name=>name!=='constructor').sort();
 expect(names(MonitorRead)).toEqual(['admissionState','status']);
 expect(names(MonitorAdmin)).toEqual(['acknowledge','arm','exportState','initialize','recoverInterrupted','stop','usage']);
 expect((await handler.fetch()).status).toBe(404);
});
