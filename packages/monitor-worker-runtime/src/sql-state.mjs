const KEYS = new Set(['heartbeat.json','snapshot.json','hold.json','events.json','publication.json','runner.lock']);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
export function createMonitorSqlState(sql) {
 sql.exec('CREATE TABLE IF NOT EXISTS monitor_state (name TEXT PRIMARY KEY, bytes TEXT NOT NULL)');
 const key = name => {if(!KEYS.has(name))throw Error('invalid monitor state key');return name;};
 const has = name => sql.exec('SELECT name FROM monitor_state WHERE name=?',key(name)).toArray().length===1;
 const read = name => {const rows=sql.exec('SELECT bytes FROM monitor_state WHERE name=?',key(name)).toArray();if(rows.length!==1)throw Error('missing monitor state');return rows[0].bytes;};
 const write=(name,bytes)=>{key(name);if(typeof bytes!=='string'||bytes.length>MAX_RECORD_BYTES||new TextEncoder().encode(bytes).length>MAX_RECORD_BYTES)throw Error('monitor state record exceeds bound');sql.exec('INSERT INTO monitor_state(name,bytes) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes',name,bytes);};
 return Object.freeze({
  has,read,write,
  remove(name,force){if(!has(name)&&!force)throw Error('missing monitor state');sql.exec('DELETE FROM monitor_state WHERE name=?',key(name));},
  acquire(name,bytes){key(name);if(name!=='runner.lock')throw Error('invalid monitor lock');if(has(name))return false;write(name,bytes);return true;},
  release(name,token){if(name!=='runner.lock'||JSON.parse(read(name)).token!==token)throw Error('monitor lock owner mismatch');sql.exec('DELETE FROM monitor_state WHERE name=?',key(name));},
 });
}
