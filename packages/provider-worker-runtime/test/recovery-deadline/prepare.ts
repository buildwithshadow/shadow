import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {createPublicClient,createWalletClient,defineChain,http,keccak256,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ADDR,ANVIL_PORT,ANVIL_URL,ENDPOINT_HASH,KEYS,PRICE} from './constants.ts';

// Node-side, at vitest config load. Compiles the unmodified settled contract, starts an isolated NON-FORK anvil (chain 5042,
// 127.0.0.1), deploys MockUSDC (TEST SIMULATION) and the actual contract, and writes a generated wrangler config.
const HERE=dirname(fileURLToPath(import.meta.url));
const ROOT=resolve(HERE,'../../../..');
const OUT=resolve(HERE,'../../.recovery-deadline');
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const rpc=async(method:string,params:unknown[]=[])=>{
 const r=await fetch(ANVIL_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(3000)});
 const b=await r.json() as {result?:unknown;error?:{message:string}};if(b.error)throw Error(`${method}: ${b.error.message}`);return b.result;
};
function compile(){
 const suffix=['svm','0.8.24','solc-0.8.24'];
 const candidates=process.env.SOLC_BIN?[process.env.SOLC_BIN]:['solc',
  resolve(process.env.XDG_DATA_HOME||resolve(homedir(),'.local/share'),...suffix),
  resolve(homedir(),'.svm/0.8.24/solc-0.8.24'),
  resolve(homedir(),'Library/Application Support',...suffix)];
 const compiler=candidates.find(path=>{try{return /Version: 0\.8\.24\+commit\.e11b9ed9/.test(execFileSync(path,['--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));}catch{return false;}});
 if(!compiler)throw Error('Native Solidity 0.8.24 is required; set SOLC_BIN to the pinned compiler installed by Foundry.');
 const files=[resolve(ROOT,'contracts/src/ShadowFloatMainnetPublicSettled.sol'),resolve(HERE,'MockUSDC.sol')];
 const out=execFileSync(compiler,['--via-ir','--optimize','--optimize-runs','1','--metadata-hash','none','--no-cbor-metadata','--combined-json','abi,bin','--allow-paths',ROOT,...files],{maxBuffer:64*1024*1024,encoding:'utf8'});
 const contracts=JSON.parse(out).contracts as Record<string,{abi:unknown[];bin:string}>;
 const pick=(name:string)=>{const k=Object.keys(contracts).find(x=>x.endsWith(`:${name}`));if(!k)throw Error(`missing ${name}`);return contracts[k];};
 return {settled:pick('ShadowFloatMainnetPublicSettled'),mock:pick('MockUSDC')};
}
export async function prepare():Promise<string>{
 const {settled,mock}=compile();
 try{await rpc('eth_chainId');throw Error(`${ANVIL_URL} is already serving; refusing to reuse it`);}catch(e){if((e as Error).message.includes('already serving'))throw e;}
 const anvil=spawn('anvil',['--chain-id','5042','--port',String(ANVIL_PORT),'--host','127.0.0.1','--quiet'],{stdio:'ignore'});
 process.on('exit',()=>{try{anvil.kill('SIGKILL');}catch{/* already gone */}});
 anvil.unref(); // Permit normal test shutdown, then terminate only this owned child in the exit hook.
 for(let i=0;i<100;i++){try{if(await rpc('eth_chainId')==='0x13b2')break;}catch{await new Promise(r=>setTimeout(r,100));}if(i===99)throw Error('anvil did not start');}
 for(const a of Object.values(ADDR))await rpc('anvil_setBalance',[a,'0x56bc75e2d63100000']);
 const chain=defineChain({id:5042,name:'local-5042',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:{default:{http:[ANVIL_URL]}}});
 const pub=createPublicClient({chain,transport:http(ANVIL_URL)});
 const owner=createWalletClient({chain,transport:http(ANVIL_URL),account:privateKeyToAccount(KEYS.owner)});
 const mockAddr=(await pub.waitForTransactionReceipt({timeout:10000,pollingInterval:20,hash:await owner.deployContract({abi:mock.abi as never,bytecode:`0x${mock.bin}` as Hex})})).contractAddress!;
 const tuple=(v:bigint[])=>({protocolReserve:v[0],lineReserve:v[1],lineSpend:v[2],perSpend:v[3],dailySpend:v[4]});
 const fReceipt=await pub.waitForTransactionReceipt({timeout:10000,pollingInterval:20,hash:await owner.deployContract({abi:settled.abi as never,bytecode:`0x${settled.bin}` as Hex,args:[mockAddr,5042n,tuple([10_000_000n,1_000_000n,50_000n,50_000n,50_000n]),tuple([1_000_000n,100_000n,5_000n,5_000n,5_000n]),3600n,86400n,3600n] as never})});
 const float=fReceipt.contractAddress!,deployBlock=fReceipt.blockNumber;
 const code=await pub.getCode({address:float});if(!code||code==='0x')throw Error('no runtime code');
 const manifest=JSON.stringify({ok:true,chainId:'5042',publicRegistration:true,repaymentBindingVersion:2,contract:{name:'ShadowFloatMainnetPublicSettled',address:float,accountingModel:'settled-v1'},bytecode:{onchainRuntimeKeccak256:keccak256(code)},deployment:{blockNumber:deployBlock.toString()}});
 const vars={DEPLOYMENT:'recovery-deadline-local',PROVIDER:ADDR.provider,CHAIN_ID:'5042',CONTRACT:float,ENDPOINT_HASH,PRICE:PRICE.toString(),MANIFEST_JSON:manifest,MANIFEST_APPROVED_SHA256:sha(manifest),LOCAL_RPC_URL:ANVIL_URL,MOCK_USDC:mockAddr};
 const config={name:'provider-recovery-deadline-test',main:resolve(HERE,'worker.ts'),compatibility_date:'2026-11-09',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,
  durable_objects:{bindings:[{name:'PROVIDER_COORDINATOR',class_name:'RecoveryDeadlineCoordinatorDO'},{name:'RECORD_STORE',class_name:'RecordStoreDO'},{name:'STORE_WITNESS',class_name:'StoreWitnessDO'}]},
  migrations:[{tag:'v1',new_sqlite_classes:['RecoveryDeadlineCoordinatorDO','RecordStoreDO','StoreWitnessDO']}],vars};
 mkdirSync(OUT,{recursive:true});const path=resolve(OUT,'wrangler.generated.json');writeFileSync(path,JSON.stringify(config,null,1));
 return path;
}
