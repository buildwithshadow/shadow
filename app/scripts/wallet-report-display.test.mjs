import assert from 'node:assert/strict';
import test from 'node:test';
import {walletReportDisplay} from '../src/walletReportDisplay.mjs';
const account='0x1111111111111111111111111111111111111111';
const requestId='arc-wallet:'+ 'a'.repeat(32)+':'+account;
const expected={account,requestId,chainId:5042};
function report() {return {kind:'shadow-arc-wallet-balance-report',requestId,chainId:5042,address:account,usdc:'0x3600000000000000000000000000000000000000',
  block:{number:'100',hash:'0x'+'b'.repeat(64),timestamp:'1791741600',minimumNewerBlocks:20},
  balance:{usdcAtomic:'10000001',usdc:'10.000001',nativeAtomic:'10000001000000000001',nativeUsdc:'10.000001000000000001'},
  checks:{twoRpcBlocksMatch:true,twoRpcBalancesMatch:true,canonicalBlockRechecked:true,usdcRepresentationsMatch:true}};}
test('display preserves exact token precision and does not double count native USDC',()=>{
  const r=walletReportDisplay(JSON.stringify(report()),expected);
  assert.equal(r.balance,'10.000001');assert.equal(r.network,'Arc mainnet');assert.equal(r.checks.length,4);
  assert.match(r.checkedAtUtc,/Z$/);assert.match(r.scope,/not added together/);
});
test('another wallet, request, chain, token or failed source check cannot become a trusted summary',()=>{
  for (const change of [r=>r.address='0x'+'2'.repeat(40),r=>r.requestId+='x',r=>r.chainId=5042002,r=>r.usdc=account,r=>r.checks.twoRpcBalancesMatch=false]) {
    const r=report();change(r);assert.equal(walletReportDisplay(JSON.stringify(r),expected),null);
  }
});
test('malformed, oversized, future schema and unsafe integers fall back to raw display',()=>{
  for(const text of ['{','null','[]','x'.repeat(1_000_001)]) assert.equal(walletReportDisplay(text,expected),null);
  for(const change of [r=>r.kind='other',r=>r.balance.usdcAtomic='1e7',r=>r.balance.usdcAtomic='0'+r.balance.usdcAtomic,r=>r.balance.nativeAtomic='0',r=>r.balance.usdc='20',r=>r.block.timestamp='8640000000001',r=>r.block.number=(2n**256n).toString(),r=>r.address='<script>']) {
    const r=report();change(r);assert.equal(walletReportDisplay(JSON.stringify(r),expected),null);
  }
});
test('testnet report is separate and zero balance remains readable',()=>{
  const r=report();r.chainId=5042002;r.balance={usdcAtomic:'0',usdc:'0',nativeAtomic:'0',nativeUsdc:'0'};
  const value=walletReportDisplay(JSON.stringify(r),{...expected,chainId:5042002});
  assert.equal(value.balance,'0');assert.equal(value.network,'Arc testnet');
});
