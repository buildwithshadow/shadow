import {expect,it} from 'vitest';
import {pinnedContext} from '../src/pinned-context.mjs';
import {approved} from './fixtures/public-config.mjs';
it('uses immutable runtime history bytes while preserving the original protected history binding',()=>{const vars=approved(),context=pinnedContext(vars,{});expect(context.manifestHash).toBe(vars.MANIFEST_APPROVED_SHA256);expect(context.baseline.approvedHistory.file).toBe('/approved/original-history.json');expect(context.approvedHistoryRuntimeFile).toMatch(/^\/tmp\//);});
it('refuses changed history or policy bytes without deriving a new approval',()=>{const vars=approved();expect(()=>pinnedContext({...vars,HISTORY_JSON:'{}'},{})).toThrow('not approved');expect(()=>pinnedContext({...vars,BASELINE_JSON:vars.BASELINE_JSON+' '},{})).toThrow('not approved');expect(()=>pinnedContext({...vars,MANIFEST_JSON:vars.MANIFEST_JSON+' '},{})).toThrow('not approved');});
it('requires the complete approved history input',()=>{const vars=approved();expect(()=>pinnedContext({...vars,HISTORY_JSON:undefined},{})).toThrow('not approved');});
