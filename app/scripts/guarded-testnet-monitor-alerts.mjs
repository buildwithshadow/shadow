// Read only, pinned guarded Arc testnet notifier. Mainnet has a separate entrypoint.
import { runGuardedTestnetAlertsCli } from './float-mainnet-monitor-alerts.mjs';
import { isEntrypoint } from './float-mainnet-preflight.mjs';

if (isEntrypoint(import.meta)) runGuardedTestnetAlertsCli().catch(() => {
  console.error('Shadow guarded testnet notification check failed. Inspect configuration, access and lock state locally. Credentials and transport details suppressed.');
  process.exitCode = 1;
});
