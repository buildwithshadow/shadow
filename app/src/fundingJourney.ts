import { isAddress, zeroAddress, parseUnits } from "viem";
import type { CandidateOpenInput } from "./candidateFunding.ts";

export const fundingSteps = [
  "wallet",
  "register",
  "agent",
  "budget",
  "fund",
] as const;
export type FundingStep =
  | "home"
  | (typeof fundingSteps)[number]
  | "line"
  | "purchase";
export function fundingPath(
  step: FundingStep,
  agent: string,
  line: string,
): string {
  if (step === "home") return "/start";
  const query = new URLSearchParams();
  if (
    (step === "line" || step === "purchase") &&
    /^0x[0-9a-fA-F]{64}$/.test(line)
  )
    query.set("line", line);
  else if (validAgent(agent)) query.set("agent", agent.trim());
  return `/start/${step}${query.size ? `?${query}` : ""}`;
}
export const stepLabels: Record<FundingStep, string> = {
  home: "Get started",
  wallet: "Wallet",
  register: "Register",
  agent: "Agent",
  budget: "Budget",
  fund: "Review and fund",
  line: "Your funding line",
  purchase: "Buy a service",
};
export function fundingStep(pathname: string, search: string): FundingStep {
  const suffix = pathname
    .toLowerCase()
    .replace(/\/+$/, "")
    .slice("/start".length)
    .replace(/^\//, "");
  if (Object.hasOwn(stepLabels, suffix)) return suffix as FundingStep;
  const query = new URLSearchParams(search);
  return query.has("line") || query.get("role") === "agent"
    ? "line"
    : query.has("agent")
      ? "wallet"
      : "home";
}
export function validAgent(value: string): boolean {
  return isAddress(value.trim()) && value.trim().toLowerCase() !== zeroAddress;
}
export function guardedFundingStep(
  step: FundingStep,
  context: {
    connected: boolean;
    correctNetwork: boolean;
    registered: boolean;
    agent: string;
  },
): FundingStep {
  if (
    step === "home" ||
    step === "line" ||
    step === "purchase" ||
    step === "wallet"
  )
    return step;
  if (!context.connected || !context.correctNetwork) return "wallet";
  if (step === "register") return step;
  if (!context.registered) return "register";
  if ((step === "budget" || step === "fund") && !validAgent(context.agent))
    return "agent";
  return step;
}
export function budgetIssue(
  form: CandidateOpenInput,
  window?: { minimumRepaymentWindow: bigint; maximumRepaymentWindow: bigint },
): string | null {
  const amounts = [
    "reserve",
    "lineSpendCap",
    "dailySpendCap",
    "providerPerSpendCap",
    "providerDailyCap",
  ] as const;
  for (const key of amounts) {
    if (!/^\d+(\.\d{1,6})?$/.test(form[key]) || parseUnits(form[key], 6) <= 0n)
      return "Enter a positive USDC amount with at most six decimal places in every budget field.";
  }
  const per = parseUnits(form.providerPerSpendCap, 6);
  if (
    per > parseUnits(form.reserve, 6) ||
    per > parseUnits(form.lineSpendCap, 6) ||
    per > parseUnits(form.dailySpendCap, 6) ||
    per > parseUnits(form.providerDailyCap, 6)
  )
    return "The maximum purchase must fit within the reserve and every spending limit.";
  if (
    !/^\d+$/.test(form.expiryDays) ||
    !/^\d+$/.test(form.repaymentHours) ||
    Number(form.expiryDays) < 1 ||
    Number(form.repaymentHours) < 1
  )
    return "Enter a whole number of at least one day and one repayment hour.";
  if (BigInt(form.expiryDays) > 7n)
    return "Choose a funding duration between one and seven days.";
  const hours = BigInt(form.repaymentHours);
  const minimum =
    ((window?.minimumRepaymentWindow ?? 3600n) + 900n + 3599n) / 3600n;
  const maximum = (window?.maximumRepaymentWindow ?? 604800n) / 3600n;
  if (hours < minimum || hours > maximum)
    return `Choose a repayment window between ${minimum} and ${maximum} whole hours.`;
  return null;
}
const draftKeys = [
  "agent",
  "reserve",
  "lineSpendCap",
  "dailySpendCap",
  "providerPerSpendCap",
  "providerDailyCap",
  "expiryDays",
  "repaymentHours",
] as const;
export function readFundingDraft(
  raw: string | null,
  defaults: CandidateOpenInput,
): CandidateOpenInput {
  try {
    if (!raw || raw.length > 4096) return defaults;
    const value = JSON.parse(raw);
    if (value.version !== 1 || !value.form || typeof value.form !== "object")
      return defaults;
    const form = { ...defaults };
    for (const key of draftKeys)
      if (typeof value.form[key] === "string" && value.form[key].length <= 100)
        form[key] = value.form[key];
    return form;
  } catch {
    return defaults;
  }
}
export function writeFundingDraft(form: CandidateOpenInput): string {
  return JSON.stringify({
    version: 1,
    form: Object.fromEntries(
      draftKeys.map((key) => [key, form[key].slice(0, 100)]),
    ),
  });
}
export function restoreWalletDraft(
  read: () => string | null,
  defaults: CandidateOpenInput,
  invitation: string | null,
) {
  let form: CandidateOpenInput;
  let persisted = true;
  try {
    form = readFundingDraft(read(), { ...defaults });
  } catch {
    form = { ...defaults };
    persisted = false;
  }
  if (invitation !== null) form.agent = invitation;
  return { form, persisted };
}

// /start is the public Arc testnet journey. Mainnet retains its own route and currency.
export function usesTestnetFundingJourney(deployment: { chainId: number; selfRegistration?: boolean }, hasService: boolean): boolean {
  return hasService && deployment.chainId === 5042002 && deployment.selfRegistration === true
}
