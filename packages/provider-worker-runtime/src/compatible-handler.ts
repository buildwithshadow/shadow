import {httpServerHandler} from 'cloudflare:node';

/** Validate the JS server boundary and bridge the runtime's narrower address/listen types. */
export function compatibleHandler(server:unknown) {
 if(typeof server!=='object'||server===null||!('listen'in server)||typeof server.listen!=='function'||!('address'in server)||typeof server.address!=='function'||!('close'in server)||typeof server.close!=='function')throw Error('invalid provider HTTP server');
 const listen=server.listen,addressOf=server.address,closeServer=server.close;
 const close=()=>{Reflect.apply(closeServer,server,[()=>{}]);};
 try {
  const facade={
   listen(...args:unknown[]){Reflect.apply(listen,server,args);return facade;},
   address(){
    const address:unknown=Reflect.apply(addressOf,server,[]);
    if(address===null)return null;
    if(typeof address!=='object'||!('port'in address)||typeof address.port!=='number'||!Number.isSafeInteger(address.port))throw Error('invalid provider HTTP address');
    return {port:address.port};
   },
  };
  const handler=httpServerHandler(facade),fetchHandler=handler.fetch;
  if(typeof fetchHandler!=='function')throw Error('invalid provider HTTP handler');
  return {
   close,
   async fetch(request:Request):Promise<Response>{
    const response:unknown=await Reflect.apply(fetchHandler,handler,[request]);
    if(!(response instanceof Response))throw Error('invalid provider HTTP response');
    return response;
   },
  };
 }catch{close();throw Error('provider HTTP bridge unavailable');}
}
