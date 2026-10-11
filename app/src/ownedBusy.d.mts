export interface BusyOwner {set(message:string):void;claim(message:string):()=>void}
export function createBusyOwner(setMessage:(message:string)=>void):BusyOwner;
export function withOwnedBusy<T>(coordinator:BusyOwner,message:string,work:()=>Promise<T>):Promise<T>;
