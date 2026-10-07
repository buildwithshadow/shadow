import { decodeEventLog, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, pad, parseAbi } from 'viem';
import { gatewayAssert as assert } from './gateway-reserve-assert.mjs';
import { GATEWAY_TESTNET, decodeGatewayAttestation, gatewayAbi, makeGatewayIntent, transferSpecHash } from './gateway-reserve.mjs';

// Experimental calldata planner, not a wallet adapter, broadcaster or ownership verifier.
// The account itself is the sponsor. Its EOA controller is never recorded as sponsor.
export const GATEWAY_GUARDED_TESTNET = '0xd39d55Cc0C84408DCC409baDB776459641Dfd4be';
export const atomicFundingAbi = parseAbi([
  'function openLine((address agent,uint256 reserve,uint256 lineSpendCap,uint256 dailySpendCap,uint64 lineExpiry,uint64 maximumRepaymentWindow,address provider,bytes32 endpointHash,uint256 providerPerSpendCap,uint256 providerDailyCap,uint64 providerExpiry) params) returns (bytes32 lineId)',
  'event LineOpened(bytes32 indexed lineId,address indexed sponsor,address indexed agent,uint64 epoch,uint256 reserve,uint64 termsVersion)',
  'event ProviderPolicySet(bytes32 indexed lineId,address indexed provider,bytes32 endpointHash,uint256 perSpendCap,uint256 dailySpendCap,uint64 expiry,bool active,uint64 termsVersion)',
]);
const paramNames = ['agent','reserve','lineSpendCap','dailySpendCap','lineExpiry','maximumRepaymentWindow','provider','endpointHash','providerPerSpendCap','providerDailyCap','providerExpiry'];
const zero = /^0x0+$/i;
function address(value) {
  assert.match(value, /^0x[0-9a-fA-F]{40}$/, 'Invalid account address');
  assert(!zero.test(value), 'A nonzero account address is required');
  return getAddress(value);
}
function uint(value, bits = 256) {
  assert.equal(typeof value, 'string', 'Amounts and counters must be decimal strings');
  assert.match(value, /^(0|[1-9][0-9]*)$/, 'Invalid decimal integer');
  assert(BigInt(value) < 2n ** BigInt(bits), 'Integer exceeds its field size');
  return BigInt(value);
}
function sameAddress(a,b) { assert.equal(a.toLowerCase(),b.toLowerCase(),'Unexpected address'); }

/** Source balance/signature stay with the EOA; mint and caller are bound to its account.
 * The caller must separately verify that the EOA actually controls that deployed account.
 */
export function makeSmartAccountGatewayIntent({ controller, sponsorAccount, amount, maxFee, maxBlockHeight, salt }) {
  controller=address(controller); sponsorAccount=address(sponsorAccount);
  assert.notEqual(controller.toLowerCase(),sponsorAccount.toLowerCase(),'Use a distinct deployed smart account');
  const intent=makeGatewayIntent({sponsor:controller,amount,maxFee,maxBlockHeight,salt});
  intent.spec.destinationRecipient=pad(sponsorAccount.toLowerCase(),{size:32});
  intent.spec.destinationCaller=intent.spec.destinationRecipient;
  return intent;
}
export function validateSmartAccountGatewayIntent(intent,controller,sponsorAccount) {
  const expected=makeSmartAccountGatewayIntent({controller,sponsorAccount,amount:intent.spec.value,maxFee:intent.maxFee,maxBlockHeight:intent.maxBlockHeight,salt:intent.spec.salt});
  assert.deepEqual(intent,expected,'Gateway intent differs from the bounded smart account route');
  return transferSpecHash(intent.spec);
}

/** One atomic account operation: mint, clear old allowance, approve exact reserve,
 * open the account's own line, clear allowance. Every call must revert the entire
 * inner batch on failure. Never submit these as independent transactions.
 */
export function prepareSmartAccountReserveBatch(input) {
  const { intent, attestationPayload, attestationSignature, params, nextEpoch, currentBlock, now, chainId }=input;
  assert.equal(chainId,GATEWAY_TESTNET.chainId,'Arc testnet only');
  const controller=address(input.controller), sponsorAccount=address(input.sponsorAccount);
  const shadow=address(input.shadow);
  sameAddress(shadow,GATEWAY_GUARDED_TESTNET);
  assert(![shadow,GATEWAY_TESTNET.token,GATEWAY_TESTNET.wallet,GATEWAY_TESTNET.minter].some(target=>target.toLowerCase()===sponsorAccount.toLowerCase()),'A protocol contract cannot be the sponsor account');
  const transferHash=validateSmartAccountGatewayIntent(intent,controller,sponsorAccount);
  const decoded=decodeGatewayAttestation(attestationPayload,uint(currentBlock));
  assert.equal(keccak256(decoded.transferSpecBytes),transferHash,'Attestation differs from the signed route');
  assert.match(attestationSignature,/^0x[0-9a-fA-F]{130}$/,'A complete Circle attestation signature is required');
  assert.deepEqual(Object.keys(params).sort(),[...paramNames].sort(),'Unexpected line parameters');
  const p={...params,agent:address(params.agent),provider:address(params.provider)};
  assert.notEqual(p.provider.toLowerCase(),shadow.toLowerCase(),'Shadow cannot be its own provider');
  for (const key of ['reserve','lineSpendCap','dailySpendCap','providerPerSpendCap','providerDailyCap']) {
    const amount=uint(p[key]); assert(amount>0n&&amount<=100000n,'Line amounts must be within 0.10 test USDC');
  }
  assert.equal(p.reserve,intent.spec.value,'Mint must equal the exact reserve');
  assert(uint(p.lineSpendCap)<=uint(p.reserve),'Line spending exceeds reserve');
  assert(uint(p.dailySpendCap)<=uint(p.lineSpendCap),'Daily spending exceeds line cap');
  assert(uint(p.providerPerSpendCap)<=uint(p.providerDailyCap)&&uint(p.providerDailyCap)<=uint(p.dailySpendCap),'Provider limits exceed line limits');
  assert.match(p.endpointHash,/^0x[0-9a-fA-F]{64}$/); assert(!zero.test(p.endpointHash),'Endpoint must be explicit');
  const timestamp=uint(now,64),expiry=uint(p.lineExpiry,64),providerExpiry=uint(p.providerExpiry,64),repayment=uint(p.maximumRepaymentWindow,64);
  assert(expiry>timestamp&&expiry<=timestamp+86400n,'Line expiry must be within 24 hours');
  assert(providerExpiry>timestamp&&providerExpiry<=expiry,'Provider expiry must be inside the line window');
  assert(repayment>0n&&repayment<=86400n,'Repayment window must be bounded');
  const epoch=uint(nextEpoch,64); assert(epoch>0n,'Next line epoch must be positive');
  const lineId=keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'uint64'}],[BigInt(chainId),shadow,sponsorAccount,p.agent,epoch]));
  const approve=value=>({to:GATEWAY_TESTNET.token,value:'0',data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[shadow,value]})});
  const numeric=Object.fromEntries(paramNames.map(key=>[key,['agent','provider','endpointHash'].includes(key)?p[key]:BigInt(p[key])]));
  return {
    version:1,chainId,controller,sponsorAccount,shadow,lineId,nextEpoch,
    transferSpecHash:transferHash,expirationBlock:decoded.expirationBlock,params:p,
    calls:[
      {to:GATEWAY_TESTNET.minter,value:'0',data:encodeFunctionData({abi:gatewayAbi,functionName:'gatewayMint',args:[attestationPayload,attestationSignature]})},
      approve(0n),approve(uint(p.reserve)),
      {to:shadow,value:'0',data:encodeFunctionData({abi:atomicFundingAbi,functionName:'openLine',args:[numeric]})},
      approve(0n),
    ],
  };
}

function events(receipt,emitter,abi,eventName) {
  return receipt.logs.filter(log=>log.address.toLowerCase()===emitter.toLowerCase()).flatMap(log=>{
    try {const decoded=decodeEventLog({abi,...log,strict:true});return decoded.eventName===eventName?[decoded.args]:[];} catch {return [];}
  });
}
/** Verify effects only after the enclosing transaction has been independently
 * bound to the reviewed wallet batch and proven canonical/finalized on two RPCs.
 * Outer receipt success alone is insufficient: Safe-like accounts can catch an
 * inner failure. Missing/ambiguous events throw and must stay held, never resend.
 */
export function verifySmartAccountReserveEvents({receipt,hash,plan,intent}) {
  assert.equal(plan.chainId,GATEWAY_TESTNET.chainId,'Arc testnet only');
  sameAddress(plan.shadow,GATEWAY_GUARDED_TESTNET);
  assert.equal(validateSmartAccountGatewayIntent(intent,plan.controller,plan.sponsorAccount),plan.transferSpecHash);
  assert.equal(plan.params.reserve,intent.spec.value,'Mint must equal the exact reserve');
  const expectedLine=keccak256(encodeAbiParameters([{type:'uint256'},{type:'address'},{type:'address'},{type:'address'},{type:'uint64'}],[BigInt(plan.chainId),plan.shadow,plan.sponsorAccount,plan.params.agent,uint(plan.nextEpoch,64)]));
  assert.equal(plan.lineId,expectedLine,'Line identity does not match the original sponsor and epoch');
  assert.equal(receipt.transactionHash.toLowerCase(),hash.toLowerCase(),'Wrong transaction');
  assert.equal(receipt.status,'success','Outer transaction failed');
  sameAddress(receipt.to,plan.sponsorAccount);
  const minted=events(receipt,GATEWAY_TESTNET.minter,gatewayAbi,'AttestationUsed');
  const opened=events(receipt,plan.shadow,atomicFundingAbi,'LineOpened');
  const policies=events(receipt,plan.shadow,atomicFundingAbi,'ProviderPolicySet');
  assert.equal(minted.length,1,'Expected exactly one original mint');
  assert.equal(opened.length,1,'Expected exactly one funded line; outer success is not enough');
  assert.equal(policies.length,1,'Expected exactly one reviewed provider policy');
  const m=minted[0],l=opened[0],p=policies[0];
  sameAddress(m.token,GATEWAY_TESTNET.token); sameAddress(m.recipient,plan.sponsorAccount);
  assert.equal(m.transferSpecHash,plan.transferSpecHash);
  assert.equal(m.sourceDomain,GATEWAY_TESTNET.domain); assert.equal(m.sourceDepositor,intent.spec.sourceDepositor); assert.equal(m.sourceSigner,intent.spec.sourceSigner);
  assert.equal(m.value,uint(plan.params.reserve));
  assert.equal(l.lineId,plan.lineId); sameAddress(l.sponsor,plan.sponsorAccount); sameAddress(l.agent,plan.params.agent);
  assert.equal(l.epoch,uint(plan.nextEpoch)); assert.equal(l.reserve,uint(plan.params.reserve)); assert.equal(l.termsVersion,1n);
  assert.equal(p.lineId,plan.lineId); sameAddress(p.provider,plan.params.provider); assert.equal(p.endpointHash,plan.params.endpointHash);
  assert.equal(p.perSpendCap,uint(plan.params.providerPerSpendCap)); assert.equal(p.dailySpendCap,uint(plan.params.providerDailyCap));
  assert.equal(p.expiry,uint(plan.params.providerExpiry)); assert.equal(p.active,true); assert.equal(p.termsVersion,1n);
  const funding=events(receipt,GATEWAY_TESTNET.token,erc20Abi,'Transfer').filter(e=>e.from.toLowerCase()===plan.sponsorAccount.toLowerCase()&&e.to.toLowerCase()===plan.shadow.toLowerCase());
  assert.equal(funding.length,1,'Expected exactly one token transfer into the reserve'); assert.equal(funding[0].value,uint(plan.params.reserve));
  const approvals=events(receipt,GATEWAY_TESTNET.token,erc20Abi,'Approval').filter(e=>e.owner.toLowerCase()===plan.sponsorAccount.toLowerCase()&&e.spender.toLowerCase()===plan.shadow.toLowerCase());
  assert(approvals.length>0&&approvals.at(-1).value===0n,'Final allowance reset is missing');
  return {hash:receipt.transactionHash,lineId:plan.lineId,sponsor:plan.sponsorAccount,controller:plan.controller,reserve:plan.params.reserve,transferSpecHash:plan.transferSpecHash};
}
