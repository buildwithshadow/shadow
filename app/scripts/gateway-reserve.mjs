import { gatewayAssert as assert } from './gateway-reserve-assert.mjs';
import { encodePacked, keccak256, pad, parseAbi, decodeEventLog, bytesToHex, hexToBytes } from 'viem';

// Deliberately limited to the Arc testnet rehearsal. Domains are not chain IDs.
export const GATEWAY_TESTNET = Object.freeze({
  chainId: 5042002, domain: 26,
  wallet: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  minter: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
  token: '0x3600000000000000000000000000000000000000',
  api: 'https://gateway-api-testnet.circle.com/v1',
});
export const gatewayAbi = parseAbi([
  'function deposit(address token,uint256 value)',
  'function gatewayMint(bytes attestationPayload,bytes signature)',
  'function domain() view returns (uint32)',
  'function isTransferSpecHashUsed(bytes32 hash) view returns (bool)',
  'event Deposited(address indexed token,address indexed depositor,address indexed sender,uint256 value)',
  'event AttestationUsed(address indexed token,address indexed recipient,bytes32 indexed transferSpecHash,uint32 sourceDomain,bytes32 sourceDepositor,bytes32 sourceSigner,uint256 value)',
]);
const names = ['version','sourceDomain','destinationDomain','sourceContract','destinationContract','sourceToken','destinationToken','sourceDepositor','destinationRecipient','sourceSigner','destinationCaller','value','salt','hookData'];
const types = ['uint32','uint32','uint32',...Array(8).fill('bytes32'),'uint256','bytes32','bytes'];
export function transferSpecHash(spec) {
  assert.equal(spec.hookData, '0x', 'Hooks are outside this rehearsal');
  return keccak256(encodePacked(['bytes4',...types.slice(0,-1),'uint32','bytes'],
    ['0xca85def7',...names.slice(0,-1).map(k=>spec[k]),0,'0x']));
}
export function makeGatewayIntent({ sponsor, amount, maxFee, maxBlockHeight, salt = bytesToHex(crypto.getRandomValues(new Uint8Array(32))) }) {
  assert.match(sponsor, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(BigInt(sponsor),0n);
  assert(BigInt(amount)>0n && BigInt(amount)<=100000n, 'Reserve ceiling is 0.10 test USDC');
  assert(BigInt(maxFee)>=0n && BigInt(maxFee)<=10000n, 'Fee ceiling is 0.01 test USDC');
  assert(BigInt(maxBlockHeight)>0n && BigInt(maxBlockHeight)<2n**64n, 'A bounded source expiry is required');
  assert.match(salt,/^0x[0-9a-fA-F]{64}$/);
  const address = v => pad(v.toLowerCase(),{size:32});
  const g=GATEWAY_TESTNET;
  return {maxBlockHeight:String(maxBlockHeight),maxFee:String(maxFee),spec:{
    version:1,sourceDomain:g.domain,destinationDomain:g.domain,
    sourceContract:address(g.wallet),destinationContract:address(g.minter),
    sourceToken:address(g.token),destinationToken:address(g.token),
    sourceDepositor:address(sponsor),destinationRecipient:address(sponsor),
    sourceSigner:address(sponsor),destinationCaller:address(sponsor),
    value:String(amount),salt,hookData:'0x',
  }};
}
export function gatewayTypedData(intent) {
  return {domain:{name:'GatewayWallet',version:'1'},primaryType:'BurnIntent',types:{
    TransferSpec:names.map((name,i)=>({name,type:types[i]})),
    BurnIntent:[{name:'maxBlockHeight',type:'uint256'},{name:'maxFee',type:'uint256'},{name:'spec',type:'TransferSpec'}],
  },message:intent};
}
export function validateGatewayIntent(intent, sponsor) {
  const expected=makeGatewayIntent({sponsor,amount:intent.spec.value,maxFee:intent.maxFee,maxBlockHeight:intent.maxBlockHeight,salt:intent.spec.salt});
  assert.deepEqual(intent,expected,'Gateway intent differs from the bounded sponsor-owned route');
  return transferSpecHash(intent.spec);
}
export async function gatewayRead(path, body, fetcher=fetch) {
  assert(path==='/info'||path==='/estimate'||path==='/balances'||/^\/transferSpec\/0x[0-9a-fA-F]{64}$/.test(path)||/^\/transfer\/[0-9a-f-]{36}$/.test(path),'Unsupported read endpoint');
  const response=await fetcher(GATEWAY_TESTNET.api+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(20000),...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  assert(response.ok,`Gateway read HTTP ${response.status}`);
  return response.json();
}

/** A side effect is attempted at most once per durable identity. A missing response
 * stays unknown. Reconciliation may supply evidence, never a second send. The
 * caller must retain this journal; deleting it removes the local protection. */
export async function runGatewayStep({journal,sponsor,operation,phase,request,send,reconcile}) {
  assert.match(sponsor, /^0x[0-9a-fA-F]{40}$/, 'A sponsor wallet identity is required');
  assert.notEqual(BigInt(sponsor), 0n, 'A nonzero sponsor wallet is required');
  const key=`gateway:${operation}:${phase}`;
  return journal.withLock(`gateway-reserve:${GATEWAY_TESTNET.chainId}:${sponsor.toLowerCase()}`,async()=>{
    const prior=await journal.get(key);
    if(prior){
      assert.deepEqual(prior.request,request,'Refusing changed request for an existing operation');
      if(prior.status==='confirmed')return prior;
      const evidence=await reconcile(prior);
      if(!evidence)return prior;
      const done={...prior,status:'confirmed',evidence};await journal.put(key,done);return done;
    }
    // Persist before any remote side effect. Errors deliberately leave unknown.
    let record={request,status:'unknown',createdAt:new Date().toISOString()};
    await journal.put(key,record);
    const response=await send(request);
    record={...record,response};await journal.put(key,record);
    const evidence=await reconcile(record);
    if(evidence){record={...record,status:'confirmed',evidence};await journal.put(key,record);}
    return record;
  });
}

export function verifyGatewayEvent({receipt,hash,kind,intent,sponsor,depositAmount}) {
  const g=GATEWAY_TESTNET;
  assert.equal(receipt.transactionHash.toLowerCase(),hash.toLowerCase(),'Wrong transaction');
  assert.equal(receipt.status,'success','Transaction failed');
  assert.equal(receipt.to.toLowerCase(),(kind==='deposit'?g.wallet:g.minter).toLowerCase());
  const eventName=kind==='deposit'?'Deposited':'AttestationUsed';
  assert(['deposit','mint'].includes(kind));
  const events=receipt.logs.filter(l=>l.address.toLowerCase()===receipt.to.toLowerCase()).flatMap(log=>{
    try{const decoded=decodeEventLog({abi:gatewayAbi,...log,strict:true});return decoded.eventName===eventName?[decoded.args]:[];}catch{return [];}
  });
  assert.equal(events.length,1,`Expected exactly one ${eventName}`);
  const e=events[0];assert.equal(e.token.toLowerCase(),g.token.toLowerCase());
  if(kind==='deposit'){
    assert.equal(e.depositor.toLowerCase(),sponsor.toLowerCase());assert.equal(e.sender.toLowerCase(),sponsor.toLowerCase());
    assert.equal(e.value,BigInt(depositAmount));
  }else{
    assert.equal(e.recipient.toLowerCase(),sponsor.toLowerCase());
    assert.equal(e.transferSpecHash,validateGatewayIntent(intent,sponsor));
    assert.equal(e.sourceDomain,g.domain);
    assert.equal(e.sourceDepositor,intent.spec.sourceDepositor);
    assert.equal(e.sourceSigner,intent.spec.sourceSigner);
    assert.equal(e.value,BigInt(intent.spec.value));
  }
  return {hash:receipt.transactionHash,blockNumber:String(receipt.blockNumber),blockHash:receipt.blockHash,event:eventName};
}

/** Require both RPCs to agree on a canonical, finalized transaction before
 * accepting its event. Balances and pending receipts cannot substitute. */
export async function finalizedGatewayReceipt(clients,hash) {
  assert.equal(clients.length,2,'Two independent clients required');
  const receipts=await Promise.all(clients.map(async c=>{
    assert.equal(await c.getChainId(),GATEWAY_TESTNET.chainId);
    const receipt=await c.getTransactionReceipt({hash});
    const [block,finalized]=await Promise.all([c.getBlock({blockNumber:receipt.blockNumber}),c.getBlock({blockTag:'finalized'})]);
    assert.equal(block.hash,receipt.blockHash,'Noncanonical receipt');
    assert(finalized.number>=receipt.blockNumber,'Receipt not finalized');return receipt;
  }));
  assert.equal(receipts[0].blockHash,receipts[1].blockHash);
  assert.equal(receipts[0].status,receipts[1].status);
  assert.deepEqual(receipts[0].logs,receipts[1].logs,'RPC event disagreement');
  return receipts[0];
}

export function validateGatewayAttestation(payload,intent,sponsor,currentBlock) {
  assert.match(payload,/^0x(?:[0-9a-fA-F]{2})+$/);
  let bytes=hexToBytes(payload);
  if(bytesToHex(bytes.subarray(0,4)).slice(2)==='1e12db71'){
    assert(bytes.length>=8 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4)===1,'Exactly one attestation required');bytes=bytes.subarray(8);
  }
  assert.equal(bytesToHex(bytes.subarray(0,4)).slice(2),'ff6fb334');
  assert(bytes.length>=40,'Truncated attestation');
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(36),340,'Unexpected transfer encoding');
  assert.equal(bytes.length,380,'Trailing or missing attestation data');
  const expiry=BigInt(bytesToHex(bytes.subarray(4,36)));
  assert(expiry>BigInt(currentBlock),'Attestation expired');
  assert.equal(keccak256(bytesToHex(bytes.subarray(40))),validateGatewayIntent(intent,sponsor),'Attestation does not match the signed funding intent');
  return {transferSpecHash:transferSpecHash(intent.spec),expirationBlock:String(expiry)};
}
