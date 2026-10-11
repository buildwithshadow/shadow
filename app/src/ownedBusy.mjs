export function createBusyOwner(setMessage) {
  let owner = null;
  return {
    set(message) { owner = null; setMessage(message); },
    claim(message) {
      const token = Symbol('busy operation'); owner = token; setMessage(message);
      return () => { if (owner === token) { owner = null; setMessage(''); } };
    },
  };
}
export async function withOwnedBusy(coordinator, message, work) {
  const release = coordinator.claim(message);
  try { return await work(); } finally { release(); }
}
