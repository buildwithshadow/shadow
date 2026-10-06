import assert from 'node:assert/strict';
import { test } from 'node:test';
import { circleCliEnvironment } from './circle-agent-cli-environment.mjs';
import { parseVerifiedCliArgs, runVerifiedCli } from './circle-cli-verified.mjs';
import { EventEmitter } from 'node:events';

test('Circle subprocesses retain profile and keyring access without project or proxy environment',()=>{
 const input={HOME:'/user',PATH:'/untrusted/bin',CIRCLE_CLI_HOME:'/private/profiles',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/bus',LANG:'C.UTF-8',DEBUG:'*',CIRCLE_API_KEY:'not-forwarded',HTTP_PROXY:'not-forwarded'};
 const env=circleCliEnvironment(input);
 assert.deepEqual(env,{PATH:'/usr/bin:/bin',HOME:'/user',LANG:'C.UTF-8',DBUS_SESSION_BUS_ADDRESS:'unix:path=/run/user/bus',CIRCLE_CLI_HOME:'/private/profiles'});
 assert.equal(input.PATH,'/untrusted/bin');
});
for(const key of ['NODE_OPTIONS','NODE_PATH','CIRCLE_PROXY_URL'])test(`${key} is refused without echoing its value`,()=>{
 assert.throws(()=>circleCliEnvironment({[key]:'sensitive-value'}),error=>error.message.includes(key)&&!error.message.includes('sensitive-value'));
});
test('relative profile home is refused',()=>assert.throws(()=>circleCliEnvironment({CIRCLE_CLI_HOME:'relative'}),/absolute/));
test('verified launcher permits private login and inspection but no spend or endpoint overrides',()=>{
 assert.deepEqual(parseVerifiedCliArgs(['wallet','login','builder@example.com','--testnet']).args,['wallet','login','builder@example.com','--testnet']);
 assert.doesNotThrow(()=>parseVerifiedCliArgs(['wallet','list','--type','agent','--chain','ARC-TESTNET','--output','json']));
 for(const args of [['wallet','transfer','0xabc'],['wallet','execute','call'],['wallet','login','builder@example.com','--otp','private'],['wallet','list','--proxy-url','https://example.com'],['wallet','list','--chain','ARC','--chain','ARC-TESTNET']])assert.throws(()=>parseVerifiedCliArgs(args));
});
test('launcher inherits private input only after verification and uses the frozen working directory',async()=>{
 let prepared=false;
 const result=await runVerifiedCli(['wallet','login','builder@example.com','--testnet'],{
  inputEnvironment:{HOME:'/user'},prepare:async()=>{prepared=true;return '/verified/dist/index.js';},
  spawnImpl:(executable,args,options)=>{
   assert.equal(prepared,true);assert.equal(executable,process.execPath);
   assert.deepEqual(args,['/verified/dist/index.js','wallet','login','builder@example.com','--testnet']);
   assert.equal(options.cwd,'/verified/dist');assert.equal(options.stdio,'inherit');assert.equal(options.env.PATH,'/usr/bin:/bin');
   const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0,null));return child;
  },
 });assert.equal(result,0);
});
test('failed verification or forbidden environment cannot launch authentication',async()=>{
 let started=false;
 const spawnImpl=()=>{started=true;throw Error('must not launch');};
 await assert.rejects(()=>runVerifiedCli(['wallet','login','builder@example.com'],{inputEnvironment:{},prepare:async()=>{throw Error('unapproved bytes');},spawnImpl}),/unapproved/);
 await assert.rejects(()=>runVerifiedCli(['wallet','login','builder@example.com'],{inputEnvironment:{CIRCLE_PROXY_URL:'secret'},spawnImpl}),/CIRCLE_PROXY_URL/);
 assert.equal(started,false);
});


test('live terms inspection is allowed and acceptance requires the user confirmation flag',()=>{
 assert.deepEqual(parseVerifiedCliArgs(['terms','show','--init','--output','json']).args,['terms','show','--init','--output','json']);
 assert.deepEqual(parseVerifiedCliArgs(['terms','accept','--confirm-terms','--output','json']).args,['terms','accept','--output','json']);
 for(const args of [['terms','accept'],['terms','accept','--output','json'],['terms','reset'],['terms','show','--init','--init']])assert.throws(()=>parseVerifiedCliArgs(args));
 assert.equal(circleCliEnvironment({CIRCLE_ACCEPT_TERMS:'1'}).CIRCLE_ACCEPT_TERMS,undefined);
});
test('terms acceptance passes only the explicitly requested vendor command',async()=>{
 let command;
 await runVerifiedCli(['terms','accept','--confirm-terms','--output','json'],{
  inputEnvironment:{},prepare:async()=>'/verified/dist/index.js',
  spawnImpl:(_executable,args)=>{command=args;const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0,null));return child;},
 });assert.deepEqual(command,['/verified/dist/index.js','terms','accept','--output','json']);
});
