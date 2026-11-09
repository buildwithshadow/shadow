import {createHash} from 'node:crypto';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function notificationImport(context,destinationId,packet,now=Date.now()){
 if(packet===undefined)return null;
 if(!packet||typeof packet.bytes!=='string'||packet.bytes.length>8192||new TextEncoder().encode(packet.bytes).length>8192||!/^[0-9a-f]{64}$/.test(packet.sha256??'')||hash(packet.bytes)!==packet.sha256)throw Error('notification import fingerprint mismatch');
 const value=JSON.parse(packet.bytes),binding=hash(JSON.stringify([context.manifestHash,context.baselineHash]));
 if(value.binding!==binding||!/^\-?\d+$/.test(String(destinationId??''))||value.destinationId!==String(destinationId))throw Error('notification import binding mismatch');
 const time=Date.parse(value.sentAt);
 if(!Number.isFinite(time)||time>now||new Date(time).toISOString()!==value.sentAt||!Array.isArray(value.codes)||value.codes.length>100||!value.codes.every(code=>typeof code==='string'&&/^[A-Z_0-9]{1,80}$/.test(code))||!(value.incidentId===null||typeof value.incidentId==='string'&&value.incidentId.length<=80))throw Error('invalid notification import');
 const key=value.key==='healthy'&&value.codes.length===0&&value.incidentId===null?'healthy':`failure:${hash(JSON.stringify({codes:value.codes,incidentId:value.incidentId}))}`;
 if(value.key!==key)throw Error('invalid notification import state');
 return {destinationId:value.destinationId,binding,key:value.key,codes:[...value.codes],incidentId:value.incidentId,sentAt:value.sentAt};
}
