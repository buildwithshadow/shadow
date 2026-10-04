import {mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

// Trusted OS ownership protects the cache/identity root from other local users.
// This does not defend against root or an administrator with the owner's uid.
export async function requirePrivateState(directory) {
  const path=resolve(directory);await mkdir(path,{recursive:true,mode:0o700});
  const info=await lstat(path),uid=process.getuid?.();
  if(await realpath(path)!==path || !info.isDirectory() || (info.mode&0o077)!==0
      || (uid!==undefined&&info.uid!==uid))throw new Error('Circle state must be an owner-controlled private directory.');
  for(let ancestor=dirname(path);;ancestor=dirname(ancestor)){
    const trusted=await lstat(ancestor);
    if(!trusted.isDirectory() || trusted.isSymbolicLink() || (uid!==undefined&&trusted.uid!==uid&&trusted.uid!==0)
        || ((trusted.mode&0o022)!==0 && !(trusted.mode&0o1000)))throw new Error('Circle state has an unsafe writable ancestor.');
    if(ancestor===dirname(ancestor))break;
  }
  return path;
}
