#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, keccak256, stringToHex } from 'viem';
import { createCircleAgentExecutor } from './circle-agent-execution.mjs';
import { createCircleAgentJournal } from './circle-agent-journal.mjs';
import { createCircleCliTransport } from './circle-agent-cli-transport.mjs';
import { createRpcReadTransport } from './rpc-read-transport.mjs';
import { createCandidateFundingKit, CANDIDATE_FUNDING, candidateFundingChain } from '../src/candidateFunding.ts';
import { createSelfServicePurchase } from '../src/selfServicePurchase.mjs';
import abi from './float-mainnet-abi.json' with { type: 'json' };
import manifest from '../../contracts/deployments/public-testnet/arc-testnet.manifest.json' with { type: 'json' };

const SERVICE = Object.freeze({ provider:'0xFAF237F98f35A86149E901e18EB4BAd67bC0D347', endpoint:'https://api.shadowbuild.xyz:8443/provider/shadow-v2-cycle', providerUrl:'https://api.shadowbuild.xyz:8443/provider', principal:'50000', sourcePayment:'0x28d70ae57f6eda6ff27e0c2a5a13c3074ecf6792f79c726bae02f6f7c9c53b38' });
const CONTRACT = getAddress(manifest.contract.address);
const must = (ok, message) => { if (!ok) throw new Error(message); };
const serial = value => JSON.stringify(value, (_,v)=>typeof v==='bigint'?v.toString():v, 2);
export function parseAgentArgs(args) {
  const [command='help', ...rest] = args;
  must(['help','doctor','inspect','purchase','recover','repay'].includes(command), 'Unknown command. Use help.');
  const flags = {};
  for (let i=0;i<rest.length;i++) {
    const k=rest[i];must(['--agent','--line','--state','--runtime','--confirm'].includes(k), `Unknown option: ${k}`);
    must(!(k in flags),'Repeated option.');
    if(k==='--confirm')flags[k]=true;
    else { must(rest[i+1] && !rest[i+1].startsWith('--'),`Missing ${k} value.`);flags[k]=rest[++i]; }
  }
  if(command==='help')return {command};
  const agent=getAddress(flags['--agent']);
  const line=flags['--line']?.trim().toLowerCase();
  if(command!=='doctor')must(/^0x[0-9a-fA-F]{64}$/.test(line),'A valid funding line ID is required.');
  must(!flags['--confirm'] || ['purchase','repay'].includes(command),'This command is read-only; --confirm is not allowed.');
  return {command,agent,line,confirm:flags['--confirm']===true,state:resolve(flags['--state']??join(homedir(),'.local/share/shadow/agent-testnet')),runtime:resolve(flags['--runtime']??join(homedir(),'.local/share/shadow/circle-runtime'))};
}
export async function recoverAgentPurchase({executor,state,engine,client,save}) {
  const operations={};
  for(const [name,request] of Object.entries(state.requests))operations[name]=await executor.reconcile(request.key);
  const delivery=engine.load()?await engine.recover():null;
  let next;
  if(operations.purchase?.status==='not-submitted' && delivery?.status==='unconfirmed') {
    // The signed authorization was already given to the provider. Even though this
    // executor never sent it, retain it until expiry and verify unpaid finality.
    const block=await client.getBlock({blockTag:'finalized'});
    if(block.timestamp>BigInt(delivery.record.intent.typedData.message.signatureExpiry)) {
      await engine.archive();
      delete state.requests.purchase;save();
      next='The unsent authorization expired and was verified unpaid. Run purchase --confirm to prepare a new request.';
    } else next='No execution was submitted. Keep this record and run recover after the signed authorization expires; no payment was retried.';
  }
  return {operations,delivery:delivery?.status??'No saved purchase',report:delivery?.bytes?new TextDecoder().decode(delivery.bytes):undefined,next};
}
export async function runAgent(options) {
  if(options.command==='help')return {help:'Node 22.18+ required. Commands: doctor --agent 0x…; inspect|purchase|recover|repay --agent 0x… --line 0x…. purchase and repay only send with --confirm. Install the isolated Circle runtime using docs/circle-agent-onboarding.md. All operations are Arc testnet only.'};
  must(manifest.ok && manifest.chainId==='5042002' && manifest.contract.name==='ShadowFloatPublicTestnet','Invalid deployment manifest.');
  const {agent,line,command}=options;
  const client=createPublicClient({chain:candidateFundingChain,transport:createRpcReadTransport('https://rpc.testnet.arc.network',{expectedChainId:5042002,fallbackUrls:['https://rpc.blockdaemon.testnet.arc.network','https://rpc.drpc.testnet.arc.network'],timeout:15000,queueOptions:{maxAttempts:3,spacingMs:150,baseDelayMs:750,maxDelayMs:3000}})});
  const kit=createCandidateFundingKit({...CANDIDATE_FUNDING,address:CONTRACT,runtimeHash:manifest.bytecode.onchainRuntimeKeccak256,selfRegistration:true});
  await kit.verifyCandidate(client);
  const journal=await createCircleAgentJournal(options.state);
  if(command==='doctor') {
    const transport=await createCircleCliTransport({entrypoint:join(options.runtime,'node_modules/@circle-fin/cli/dist/index.js'),agent,journal});
    const session=await transport.session();
    const [code,balance]=await Promise.all([client.getCode({address:agent}),client.getBalance({address:agent})]);
    return {...session,deployed:Boolean(code&&code!=='0x'),nativeBalance:balance.toString(),sponsorLink:`https://www.shadowbuild.xyz/start?agent=${agent}`,next:!code||code==='0x'?'Deploy this Circle wallet with a zero-value self-transfer on Arc testnet after funding it. Review that transaction in your own agent environment.':'Share the sponsor link. Your sponsor chooses and authorizes the budget.'};
  }
  const current=await kit.readCandidateLine(client,line);
  must(current.agent.toLowerCase()===agent.toLowerCase(),'This funding line belongs to a different agent.');
  const summarize = snapshot => ({chainId:5042002,agent,lineId:line,contract:CONTRACT,state:snapshot.stateName,debt:snapshot.principalOutstanding.toString(),reserve:snapshot.availableReserve.toString(),purchasePrice:'0.05 test USDC',provider:SERVICE.provider,manageLink:`https://www.shadowbuild.xyz/start?line=${line}`});
  const summary=summarize(current);
  const freshSummary=async()=>summarize(await kit.readCandidateLine(client,line));
  if(command==='inspect'||(['purchase','repay'].includes(command)&&!options.confirm))return {...summary,next:command==='inspect'?'Inspect the limits, then run purchase with --confirm when ready.':'Nothing signed or sent. Add --confirm to authorize this bounded testnet action.'};
  return journal.withLock(`agent-runner:${agent.toLowerCase()}:${line.toLowerCase()}`, async()=>{
    const file=join(options.state,`purchase-${agent.toLowerCase()}-${line.toLowerCase()}.json`);
    const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,agent,line,storage:{},requests:{}};
    must(state.version===1&&state.agent===agent&&state.line===line,'Purchase journal identity mismatch.');
    const save=()=>{const tmp=file+'.tmp';const fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,serial(state)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,file);const dir=openSync(options.state,'r');try{fsyncSync(dir);}finally{closeSync(dir);}};
    const storage={getItem:k=>state.storage[k]??null,setItem:(k,v)=>{state.storage[k]=v;save();},removeItem:k=>{delete state.storage[k];save();}};
    const transport=await createCircleCliTransport({entrypoint:join(options.runtime,'node_modules/@circle-fin/cli/dist/index.js'),agent,journal});
    const executor=createCircleAgentExecutor({client,circle:transport,journal,config:{chainId:5042002,agent,contract:CONTRACT,runtimeHash:manifest.bytecode.onchainRuntimeKeccak256,provider:SERVICE.provider,endpointHash:keccak256(stringToHex(SERVICE.endpoint)),maxAmount:'50000',maxNetworkFee:'100000000000000000'}});
    async function execute(name,to,data) {
      const request={operationId:`${line}:${name}`,to,data,value:0n};
      state.requests[name]={key:executor.operationKey(request)};save();
      const result=await executor.execute(request);
      must(result.status==='confirmed','Operation is unresolved. Run recover; do not start another payment.');
      return result.txHash;
    }
    const wallet={chain:candidateFundingChain,getChainId:async()=>5042002,getAddresses:async()=>[agent],request:async({method,params})=>{
      must(method==='eth_signTypedData_v4'&&getAddress(params[0])===agent,'Unsupported wallet request.');
      return transport.signPurchase(params[1],{contract:CONTRACT,provider:SERVICE.provider,endpointHash:keccak256(stringToHex(SERVICE.endpoint))});
    },sendTransaction:async request=>{must(getAddress(request.account)===agent&&getAddress(request.to)===CONTRACT&&BigInt(request.value)===0n,'Unexpected purchase transaction.');return execute('purchase',request.to,request.data);}};
    const engine=createSelfServicePurchase({client,wallet,storage,withLock:async(_key,work)=>work(),config:{chainId:5042002,account:agent,contract:CONTRACT,runtimeHash:manifest.bytecode.onchainRuntimeKeccak256,...SERVICE}});
    if(command==='recover') {
      const recovery=await recoverAgentPurchase({executor,state,engine,client,save});
      return {...await freshSummary(),...recovery};
    }
    await transport.session();
    if(command==='purchase') {
      if(!engine.load())await engine.prepare(line,`report:${randomUUID().replaceAll('-','')}:${SERVICE.sourcePayment}`);
      const existing=engine.load();
      if(['submitted','delivered'].includes(existing.stage))return {...summary,next:'A purchase is already recorded. Run recover; this command will not submit it again.'};
      await engine.submit();
      const delivered=await engine.recover();
      return {...await freshSummary(),paymentStatus:delivered.status,transaction:delivered.record.txHash,report:delivered.bytes?new TextDecoder().decode(delivered.bytes):undefined};
    }
    const repaymentLine=await kit.readCandidateLine(client,line);
    if(repaymentLine.principalOutstanding===0n)return {...summarize(repaymentLine),next:'No debt to repay. Nothing sent.'};
    must(repaymentLine.principalOutstanding===50000n,'This runner repays exactly 0.05 test USDC only.');
    const allowance=await client.readContract({address:CANDIDATE_FUNDING.usdc,abi:erc20Abi,functionName:'allowance',args:[agent,CONTRACT]});
    if(allowance<50000n)await execute('approve-repay',CANDIDATE_FUNDING.usdc,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[CONTRACT,50000n]}));
    const transaction=await execute('repay',CONTRACT,encodeFunctionData({abi,functionName:'repay',args:[line,50000n]}));
    const after=await kit.readCandidateLine(client,line);
    return {...summarize(after),transaction,next:'Sponsor can review close and reclaim on Shadow.'};
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(()=>runAgent(parseAgentArgs(process.argv.slice(2)))).then(result=>console.log(serial(result))).catch(error=>{console.error(error.shortMessage??error.message);process.exitCode=1;});
}
