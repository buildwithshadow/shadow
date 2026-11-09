import {createHash,randomUUID} from 'node:crypto';
const ROUTES=['accept','status','serve'] as const;
type Route=typeof ROUTES[number];
interface Quota {start:number;count:number}
/** Durable Map surface used by the existing provider limiter. One actor owns each identity. */
export function durableRouteQuotas(storage:DurableObjectStorage) {
 const sql=storage.sql;
 sql.exec('CREATE TABLE IF NOT EXISTS provider_route_quotas (route TEXT NOT NULL, caller TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(route,caller))');
 let salt=storage.kv.get<string>('quota:salt');if(!salt){salt=randomUUID();storage.kv.put('quota:salt',salt);}
 const key=(caller:string)=>createHash('sha256').update(`${salt}:${caller}`).digest('hex');
 const maps=ROUTES.map(route=>{
  const read=(id:string)=>sql.exec<{start:number;count:number}>('SELECT start,count FROM provider_route_quotas WHERE route=? AND caller=?',route,id).toArray()[0];
  const value=(id:string,entry:Quota):Quota=>({start:entry.start,get count(){return read(id)?.count??entry.count;},set count(count:number){
   if(!Number.isSafeInteger(count)||count<0)throw Error('invalid quota count');
   sql.exec('UPDATE provider_route_quotas SET count=? WHERE route=? AND caller=?',count,route,id);
  }});
  // IDs returned by iteration are already private hashes. The provider passes
  // them directly back to delete, so distinguish them from validated IP callers.
  const storedKey=(caller:string)=>/^[0-9a-f]{64}$/.test(caller)?caller:key(caller);
  const map={
   get size(){return sql.exec<{total:number}>('SELECT count(*) AS total FROM provider_route_quotas WHERE route=?',route).one().total;},
   get(caller:string){const id=storedKey(caller),entry=read(id);return entry?value(id,entry):undefined;},
   has(caller:string){return read(storedKey(caller))!==undefined;},
   set(caller:string,entry:Quota){if(!Number.isSafeInteger(entry.start)||!Number.isSafeInteger(entry.count)||entry.count<0)throw Error('invalid quota');sql.exec('INSERT INTO provider_route_quotas(route,caller,start,count) VALUES(?,?,?,?) ON CONFLICT(route,caller) DO UPDATE SET start=excluded.start,count=excluded.count',route,storedKey(caller),entry.start,entry.count);return map;},
   delete(caller:string){const id=storedKey(caller),present=read(id)!==undefined;sql.exec('DELETE FROM provider_route_quotas WHERE route=? AND caller=?',route,id);return present;},
   *keys(){for(const row of sql.exec<{caller:string}>('SELECT caller FROM provider_route_quotas WHERE route=? ORDER BY rowid',route).toArray())yield row.caller;},
   *[Symbol.iterator]():Generator<[string,Quota]>{for(const row of sql.exec<{caller:string;start:number;count:number}>('SELECT caller,start,count FROM provider_route_quotas WHERE route=? ORDER BY rowid',route).toArray())yield [row.caller,value(row.caller,row)];},
  };return [route,map] as const;
 });
 return Object.fromEntries(maps) as Record<Route,typeof maps[number][1]>;
}
