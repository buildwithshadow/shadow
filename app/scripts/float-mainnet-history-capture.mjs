import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { connect } from './float-mainnet-cli.mjs';
import { captureApprovedHistory } from './float-mainnet-approved-history.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';

async function main() {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
    manifest: { type: 'string' }, out: { type: 'string' } } });
  if (!values.manifest || !values.out) throw new Error('--manifest and a new --out path are required');
  const connection = await connect(values, { readOnly: true });
  const history = await captureApprovedHistory(connection, values.manifest);
  writeFileSync(values.out, history.bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ kind: 'UnapprovedShadowHistoryCapture', chainId: String(connection.chainId),
    address: connection.address, sha256: history.sha256, anchor: history.parsed.anchor,
    fromBlock: history.parsed.identity.deployBlock, logCount: history.parsed.logs.length,
    bytes: history.bytes.length, approved: false, transactionsSent: 0 }));
}
if (isEntrypoint(import.meta)) main().catch(() => {
  console.error('History capture failed. No approval or monitor configuration was created. Inspect the read only prerequisites.');
  process.exitCode = 1;
});
