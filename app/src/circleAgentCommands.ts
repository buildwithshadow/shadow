import { getAddress, isAddress } from 'viem';

export type CircleAgentRoute = 'public-testnet' | 'guarded-testnet' | 'guarded-mainnet';

export function circleAgentCommands(lineId: string, agent: string, route: CircleAgentRoute = 'public-testnet') {
  if (!/^0x[0-9a-fA-F]{64}$/.test(lineId) || !isAddress(agent)) throw new Error('Load a valid funding line first.');
  if (!['public-testnet', 'guarded-testnet', 'guarded-mainnet'].includes(route)) throw new Error('Unsupported Circle runner route.');
  const flags = `--agent ${getAddress(agent)} --line ${lineId.toLowerCase()}`;
  if (route === 'guarded-mainnet') {
    const base = 'node app/scripts/shadow-circle-guarded-mainnet.mjs';
    const local = '--state "$SHADOW_CIRCLE_MAINNET_STATE" --runtime "$SHADOW_CIRCLE_RUNTIME"';
    const session = '--session-policy "$SHADOW_CIRCLE_MAINNET_SESSION"';
    const monitor = '--monitor-baseline "$SHADOW_CIRCLE_MAINNET_BASELINE" --monitor-manifest "$SHADOW_CIRCLE_MAINNET_MANIFEST" --monitor-state "$SHADOW_CIRCLE_MAINNET_MONITOR_STATE"';
    return {
      inspect: `${base} inspect ${flags} ${local}`,
      purchase: `${base} purchase ${flags} ${local} ${session} ${monitor} --confirm`,
      recover: `${base} recover ${flags} ${local} ${session}`,
      repay: `${base} repay ${flags} ${local} --confirm`,
    };
  }
  const base = route === 'guarded-testnet' ? 'node app/scripts/shadow-circle-guarded-testnet.mjs' : 'node app/scripts/shadow-circle-agent.mjs';
  return {
    inspect: `${base} inspect ${flags}`,
    purchase: `${base} purchase ${flags} --confirm`,
    recover: `${base} recover ${flags}`,
    repay: `${base} repay ${flags} --confirm`,
  };
}
