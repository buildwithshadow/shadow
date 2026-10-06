import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CIRCLE_CLI_SHA256 } from './circle-agent-cli-transport.mjs';
import { freezeCircleCliSource } from './circle-agent-cli-runtime.mjs';
import { circleCliEnvironment } from './circle-agent-cli-environment.mjs';

export function parseVerifiedCliArgs(argv) {
  const options={runtime:join(homedir(),'.local/share/shadow/circle-runtime'),cache:join(homedir(),'.local/share/shadow/verified-circle-cli')};
  const args=[],seen=new Set();
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--runtime'||key==='--cache') {
      if(seen.has(key)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Runtime and cache require one explicit path.');
      seen.add(key);options[key.slice(2)]=resolve(argv[++i]);
    } else args.push(key);
  }
  if(args.length===1 && ['--version','--help'].includes(args[0]))return {...options,args};
  const command=args.slice(0,2).join(' ');
  if(command==='wallet login') {
    if((args[2]??'').startsWith('-') || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args[2]??'') ||
       (args.length!==3 && !(args.length===4&&args[3]==='--testnet')))throw Error('Login requires an email and optional --testnet. Enter the OTP privately in Terminal.');
  } else {
    const flags={
      'wallet status':new Set(['--type','--output']),
      'wallet list':new Set(['--type','--chain','--output']),
      'transaction list':new Set(['--address','--chain','--output','--state','--page-size','--page-after']),
    }[command];
    if(!flags)throw Error('This launcher supports authentication and read only inspection. Use Shadow’s bounded runner for signing and transactions.');
    const used=new Set();
    for(let i=2;i<args.length;i+=2) {
      const flag=args[i],value=args[i+1];
      if(!flags.has(flag)||used.has(flag)||!value||value.startsWith('--'))throw Error('Unsupported or duplicated inspection flag.');
      used.add(flag);
      if(flag==='--type'&&value!=='agent')throw Error('Only Agent Wallet inspection is supported.');
      if(flag==='--output'&&value!=='json')throw Error('Only JSON inspection output is supported.');
      if(flag==='--chain'&&!['ARC','ARC-TESTNET'].includes(value))throw Error('Only Arc networks are supported.');
    }
  }
  return {...options,args};
}

export async function prepareVerifiedCli(options) {
  const original=join(options.runtime,'node_modules/@circle-fin/cli/dist/index.js');
  const source=await readFile(original,'utf8');
  if(createHash('sha256').update(source).digest('hex')!==CIRCLE_CLI_SHA256)throw Error('Circle CLI entrypoint differs from the reviewed release.');
  return freezeCircleCliSource(source,original,options.cache);
}

export async function runVerifiedCli(argv,{prepare=prepareVerifiedCli,spawnImpl=spawn,inputEnvironment=process.env}={}) {
  const options=parseVerifiedCliArgs(argv);
  const env=circleCliEnvironment(inputEnvironment);
  const entrypoint=await prepare(options);
  return new Promise((resolvePromise,reject)=>{
    // Human input goes directly to the vendor CLI, never through Shadow logs.
    const child=spawnImpl(process.execPath,[entrypoint,...options.args],{cwd:dirname(entrypoint),env,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',(code,signal)=>resolvePromise(signal?1:code??1));
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  runVerifiedCli(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
