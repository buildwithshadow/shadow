import { useId } from 'react';
import { walletReportDisplay } from './walletReportDisplay.mjs';
import type { PurchaseRecord } from './selfServicePurchase.mjs';

// Input is passed only after engine verification, never directly from storage.
export function VerifiedServiceReport({text, record, account, chainId}: {text:string; record:PurchaseRecord; account:string; chainId:number}) {
  const titleId = useId();
  const report = walletReportDisplay(text, {account, requestId:record.requestId, chainId});
  return <section aria-labelledby={titleId}>
    <h3 id={titleId}>Your verified service report</h3>
    <p>Funding line: <code>{record.intent.typedData.message.lineId}</code></p>
    {report && <>
      <p><strong>{report.balance} USDC</strong> on {report.network}</p>
      <dl className="fundingDetails"><div><dt>Wallet checked</dt><dd><code>{report.account}</code></dd></div>
        <div><dt>Checked at</dt><dd><time dateTime={report.checkedAtUtc}>{report.checkedAtUtc.replace('T', ' ').replace('.000Z', ' UTC')}</time></dd></div>
        <div><dt>Confirmed block</dt><dd>{report.blockNumber}</dd></div></dl>
      <ul>{report.checks.map(check => <li key={check}>{check}</li>)}</ul><p>{report.scope}</p>
    </>}
    <details open={!report}><summary>{report ? 'Report JSON' : 'Service result text'}</summary><pre className="publicServiceResult">{text}</pre></details>
  </section>;
}
