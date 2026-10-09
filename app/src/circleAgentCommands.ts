import { getAddress, isAddress } from 'viem';

export type CircleAgentRoute = 'public-testnet' | 'guarded-testnet';

export function circleAgentCommands(lineId: string, agent: string, route: CircleAgentRoute = 'public-testnet') {
  if (!/^0x[0-9a-fA-F]{64}$/.test(lineId) || !isAddress(agent)) throw new Error('Load a valid funding line first.');
  if (!['public-testnet', 'guarded-testnet'].includes(route)) throw new Error('Unsupported Circle runner route.');
  const flags = `--agent ${getAddress(agent)} --line ${lineId.toLowerCase()}`;
  const base = route === 'guarded-testnet' ? 'node app/scripts/shadow-circle-guarded-testnet.mjs' : 'node app/scripts/shadow-circle-agent.mjs';
  return {
    inspect: `${base} inspect ${flags}`,
    purchase: `${base} purchase ${flags} --confirm`,
    recover: `${base} recover ${flags}`,
    repay: `${base} repay ${flags} --confirm`,
  };
}
