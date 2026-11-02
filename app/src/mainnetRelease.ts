export type MainnetRelease = 'settled' | 'legacy';

// Links issued before the replacement did not name a deployment. They must
// continue to resolve against their original contract, never the new one.
export function mainnetRelease(search: string): MainnetRelease | null {
  const query = new URLSearchParams(search);
  const versions = query.getAll('deployment');
  if (versions.length > 1) return null;
  if (versions.length === 1) return versions[0] === 'settled' || versions[0] === 'legacy' ? versions[0] : null;
  return query.has('line') ? 'legacy' : 'settled';
}
