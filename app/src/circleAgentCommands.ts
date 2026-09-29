import { getAddress, isAddress } from 'viem';

export function circleAgentCommands(lineId: string, agent: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(lineId) || !isAddress(agent)) throw new Error('Load a valid funding line first.');
  const flags = `--agent ${getAddress(agent)} --line ${lineId.toLowerCase()}`;
  const base = 'node app/scripts/shadow-circle-agent.mjs';
  return {
    inspect: `${base} inspect ${flags}`,
    purchase: `${base} purchase ${flags} --confirm`,
    recover: `${base} recover ${flags}`,
    repay: `${base} repay ${flags} --confirm`,
  };
}
