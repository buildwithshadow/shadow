import {keccak256,toBytes} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';

// DISPOSABLE keys derived from labels for an isolated local chain. They hold nothing anywhere else.
const key=(label:string)=>keccak256(toBytes(`shadow-recovery-deadline-test:${label}`));
export const KEYS={owner:key('owner'),sponsor:key('sponsor'),agent:key('agent'),provider:key('provider'),executor:key('executor')} as const;
export const ADDR={owner:privateKeyToAccount(KEYS.owner).address,sponsor:privateKeyToAccount(KEYS.sponsor).address,agent:privateKeyToAccount(KEYS.agent).address,provider:privateKeyToAccount(KEYS.provider).address,executor:privateKeyToAccount(KEYS.executor).address} as const;
export const ANVIL_PORT=18583;
export const ANVIL_URL=`http://127.0.0.1:${ANVIL_PORT}`;
export const ENDPOINT_HASH=`0x${'1'.repeat(64)}` as const;
export const RESERVE=100_000n;
export const PRICE=1000n;
/** The head reported to the provider is inflated by this many blocks ONLY to size the lookback scan (mining that many blocks is not feasible locally). */
export const HEAD_INFLATION=2_000_000n;
