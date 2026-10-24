// Accounting is chosen explicitly by the runtime-verified release manifest.
// Never infer a legacy model from an RPC error on a newer ledger.
export const LEGACY_ACCOUNTING = "legacy-v1";
export const SETTLED_ACCOUNTING = "settled-v1";
export function accountingModel(value = LEGACY_ACCOUNTING) {
  if (![LEGACY_ACCOUNTING, SETTLED_ACCOUNTING].includes(value)) throw new Error("Unsupported contract.accountingModel");
  return value;
}
export function committedCapitalOfLines(lines, model = LEGACY_ACCOUNTING) {
  model = accountingModel(model);
  return lines.reduce((total, line) => total + line.availableReserve
    + (model === LEGACY_ACCOUNTING || line.state === "DRAWN" ? line.principalOutstanding : 0n)
    + (model === LEGACY_ACCOUNTING ? line.recoveryAvailable : 0n), 0n);
}
export function defaultedPrincipalOfLines(lines) {
  return lines.reduce((total, line) => total + (line.state === "DEFAULTED" ? line.principalOutstanding : 0n), 0n);
}
export async function readAccountingState(connection, blockNumber) {
  const model = accountingModel(connection.accountingModel);
  if (model === LEGACY_ACCOUNTING) return { accountingModel: model };
  const totalDefaultedPrincipal = await connection.client.readContract({
    address: connection.address,
    abi: [{ type: "function", name: "totalDefaultedPrincipal", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] }],
    functionName: "totalDefaultedPrincipal", blockNumber,
  });
  if (typeof totalDefaultedPrincipal !== "bigint" || totalDefaultedPrincipal < 0n) throw new Error("Invalid defaulted principal ledger");
  return { accountingModel: model, totalDefaultedPrincipal };
}
