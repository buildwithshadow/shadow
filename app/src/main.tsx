import { arcTestnetRpcUrl, arcTestnetWalletParameters } from "../arcTestnetNetwork.mjs";
import routeMetadata from "../routeMetadata.json" with { type: "json" };
import { useEffect, useMemo, useState } from "react";
import { CircleWalletDiagnostic } from "./CircleWalletDiagnostic";
import { GUARDED_MAINNET, GUARDED_MAINNET_SERVICE } from "./guardedMainnet";
import { GUARDED_TESTNET, GUARDED_TESTNET_SERVICE } from "./guardedTestnet";
import { PUBLIC_TESTNET, PUBLIC_TEST_SERVICE } from "./publicTestnet";
import { HomePage } from "./HomePage";
import { CandidateFundingDesk } from "./CandidateFundingDesk";
import { BuildersPage } from "./BuildersPage";
import { RoadmapPage } from "./RoadmapPage";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  createWalletClient,
  custom,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  parseUnits,
  stringToBytes,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  getUserOperationGasPrice,
  type WebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { createPublicClient as createClient, encodeFunctionData, http, type PublicClient } from "viem";
import {
  addresses,
  arcTestnet,
  erc20Abi,
  fetchLeptonState,
  fetchLeptonV4Readiness,
  formatAsset,
  formatUSDC,
  isLeptonConfigured,
  leptonAddresses,
  mandateRegistryAbi,
  publicClient,
  routerAbi,
  shortAddress,
  arcExplorerUrl,
  txUrl,
  v4StyleArcAdapterAbi,
  type LeptonState,
  type ReceiptLog,
  type ShadowState,
  type SourceAgent,
} from "./chain";
import {
  LEPTON_M1_DEPLOYMENTS,
  runLeptonWalletAction,
  type LeptonV4Readiness,
} from "../leptonM1Config.js";
import {
  FLOAT_V2_CONTRACT,
  FLOAT_V2_ACTIVITY_CHECKPOINT,
  FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE,
  FLOAT_V2_DEPLOY_BLOCK,
  FLOAT_V2_SHADOW_CONTROLLED_SPONSORS,
  FLOAT_V2_STATUS_NAMES,
  FLOAT_V2_OPERATIONAL_ONLY_AGENTS,
  FLOAT_V2_TRACKED_AGENTS,
  FLOAT_V2_VERIFIED_POST_RECLAIM_STATE,
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS,
  countFloatV2VerifiedReturningAgents,
  countFloatV2VerifiedReturningSponsors,
  floatV2Abi,
  floatV2IntentConsumedEvent,
  floatV2ReceiptEvent,
} from "../floatV2Config.js";
import {
  buildFloatV2OperationalHealth,
  type FloatV2OperationalHealth,
} from "../floatV2Operations.js";
import { SHADOW_ORIGIN } from "../shadowUrls.js";
import "./styles.css";

type PresetKey = "conservative" | "balanced" | "aggressive";



const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const SHADOW_CONTROLLED_SPONSOR_KEYS = new Set(
  FLOAT_V2_SHADOW_CONTROLLED_SPONSORS.map((address: string) => getAddress(address).toLowerCase()),
);
const VERIFIED_EXTERNAL_SPONSOR_KEYS = new Set(
  FLOAT_V2_VERIFIED_EXTERNAL_SPONSORS.map((address: string) => getAddress(address).toLowerCase()),
);
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const FLOAT_V2_USDC = getAddress(
  (addresses.usdc || "0x3600000000000000000000000000000000000000") as `0x${string}`,
);
const FLOAT_V2_DEFAULT_PROVIDER = getAddress(
  (import.meta.env.VITE_FLOAT_PROVIDER ||
    import.meta.env.FLOAT_PROVIDER ||
    "0x8ddf06fE8985988d3e0883F945E891BD57084937") as `0x${string}`,
);
const FLOAT_V2_DEFAULT_ENDPOINT_HASH =
  (import.meta.env.VITE_FLOAT_ENDPOINT_HASH ||
    import.meta.env.FLOAT_ENDPOINT_HASH ||
    "0x54f180bcd31ab4c3401b23bc78cb3eeb89f85d42a3b43e3d06a692b91d941160") as `0x${string}`;
const FLOAT_SPEND_INTENT_TYPES = {
  FloatSpendIntent: [
    { name: "agent", type: "address" },
    { name: "provider", type: "address" },
    { name: "endpointHash", type: "bytes32" },
    { name: "amountUSDC", type: "uint256" },
    { name: "maxDebtUSDC", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "executor", type: "address" },
    { name: "reason", type: "string" },
  ],
} as const;

type BuilderIntentTypedData = {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: {
    FloatSpendIntent: {
      name: string;
      type: string;
    }[];
  };
  primaryType: "FloatSpendIntent";
  message: {
    agent: Address;
    provider: Address;
    endpointHash: `0x${string}`;
    amountUSDC: string;
    maxDebtUSDC: string;
    nonce: string;
    expiry: string;
    executor: Address;
    reason: string;
  };
};

type BuilderSignedIntentPacket = {
  intent: {
    agent: Address;
    provider: Address;
    endpointHash: `0x${string}`;
    amountUSDC: string;
    maxDebtUSDC: string;
    nonce: string;
    expiry: string;
    executor: Address;
    reason: string;
    float: Address;
    chainId: number;
  };
  typedData: BuilderIntentTypedData;
  signature?: string;
  digest: `0x${string}`;
  requestHash: `0x${string}`;
};

type BuilderFlowStatus = {
  label: string;
  detail?: string;
  error?: string;
  txs?: { label: string; hash: Hash }[];
};

type SponsorPreflight = {
  agent: Address;
  sponsor: Address;
  existingSponsor: Address;
  existingReserveUSDC: bigint;
  lineWallet: Address;
  activeDebtUSDC: bigint;
  lineExpiry: bigint;
  providerExpiry: bigint;
  providerMandateActive: boolean;
  reserveUSDC: bigint;
  balanceUSDC: bigint;
  allowanceUSDC: bigint;
  nativeBalance: bigint;
  checkedAt: number;
};

type ExternalSignedLabel = { kind: "obol" | "builder"; eyebrow: string; title: string };

const OBOL_SIGNER = "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3".toLowerCase();
const EXTERNAL_SIGNER_LABELS: Record<string, ExternalSignedLabel> = {
  [OBOL_SIGNER]: { kind: "obol", eyebrow: "arms length buyer agent", title: "Obol signed Float intent" },
  ["0x13585c6004fbA9D7D49219a6435B68348fD30770".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Forum agent",
    title: "Forum signed Float V2 intent",
  },
  ["0x5389688243328c26a92b301faEEAb5fbf9AFf105".toLowerCase()]: {
    kind: "builder",
    eyebrow: "CitePay agent",
    title: "CitePay signed Float V2 intent",
  },
  ["0x236652EAd43fbb0948173fC4dDF23BC0971B274d".toLowerCase()]: {
    kind: "builder",
    eyebrow: "CitePay renewed agent",
    title: "CitePay renewed Float V2 line",
  },
  ["0x9972fF27a2EADBDB8414072736395236E0BF0092".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Crux agent",
    title: "Crux signed Float V2 intent",
  },
  ["0x5c0b33b209f510868E07792Edc46c3792B0b92EC".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Alpha",
    title: "Argus signed Float V2 intent",
  },
  ["0x7d4897489bfc663b90baaf5b0803d18ae0ca817c".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Beta",
    title: "Argus Beta V2 line",
  },
  ["0x43e0630025fd0339be1fa04d3d75daf355f50c89".toLowerCase()]: {
    kind: "builder",
    eyebrow: "Argus Agent Gamma",
    title: "Argus Gamma V2 line",
  },
};

const FLOAT_V2_PROOF = {
  sourcify: "https://sourcify.dev/server/v2/contract/5042002/0x20dcA96B0C487D94De885c726c956ffaF38b12C2",
  directSpendTx: "0xf2615a12b11d42d6509bc2baaafbc81fd31e4d5b54751c3686c55458252d9b03" as Hash,
  blockedSpendTx: "0x81d02cba62577eaff7f6b4bbf6233111d3372ee7cc6bc074d04030d0b41f0314" as Hash,
  repayTx: "0x854380129df5c5ca590a5d5a06a4120aa8b5190cc3053901b83da5c83963f126" as Hash,
  directRequestHash: "0xd53dbce76814360802c36fb03e5165759c1b383e5dfbdfb7e3f02d2426b6ccff",
  blockedRequestHash: "0x03c1655ba18fd886d6b4bcaa2b190fb47dfb5df79528bad58490da93a892e0f5",
  cruxSpendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d" as Hash,
  cruxRepayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
  obolSpendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
  argusAlphaBorrowTx: "0x50831fd00ef83a2c5fdb5bd5829ac6800c783aa34ec2149eb92c1bb38553aa2c" as Hash,
  argusAlphaRepayTx: "0x4ae5922841cb91b090e2785e26b94789a9c4028340bea5c162106657280bf896" as Hash,
  argusBetaBorrowTx: "0x03d67f3f911abda8e862700787f33d5ad7002e49a6fd989172dfbca5d6aa9ba9" as Hash,
  argusBetaRepayTx: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679" as Hash,
  argusGammaBorrowTx: "0x49aceee516b7eb037c9b475cdf9f238335eea9975c2102731b05826c6a0dc33e" as Hash,
  argusGammaRepayTx: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682" as Hash,
  argusCitePaySpendTx: "0x552c7e32e34d9f06e03ca185f705637f9c66002d709d7d14c24d11edefdbc322" as Hash,
  argusCitePayRepayTx: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699" as Hash,
  argusCitePayQueryId: "6e6d9c2c-b988-438a-9930-0d6d40ff78b5",
  dripletCitePayDeliveryTx: "0x68e9bb81fbd84496656cc9fc41907d17e3fbbbed67cf75d681933a0ac43fd469" as Hash,
  dripletCitePayDeliveryHash: "0x85f1bdda605cf08c5b4a4f9938aacf25f64782d64906971f16257fab8fda7329",
  citePaySponsorApproveTx: "0xa23a69aa34d4d3532ad1cc15718ca9a8537a9d085a9312937a2596ba319ad2af" as Hash,
  citePaySponsorOpenTx: "0xf2dabb1ce651330a389acd4d6cacee1a859dc4fc12f18459143dc0f60ee53540" as Hash,
  citePaySponsorSpendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae" as Hash,
  citePaySponsorRepayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe" as Hash,
  citePaySponsorCloseTx: "0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d" as Hash,
  citePayRenewedApproveTx: "0xb6bb9f2aba106a3e4384107c32a34f45b97e33d23c22dab75d314553a35bafe2" as Hash,
  citePayRenewedOpenTx: "0x4e3d8318cb8bed6b71afd716dc0f792a77cf04ceefa6986c436132a307470243" as Hash,
  citePayRenewedSpendTx: "0x9007d0e8f66c0bc641caaa305266d50aeb5e2e969ff3edbbd8122542ed08eae4" as Hash,
  citePayRenewedRepayApproveTx: "0x7ddf5e6379849d366d2c26d527df843185a5de346196e7a4c4c331fd3314be03" as Hash,
  citePayRenewedRepayTx: "0x52ef42211858713601721a9ae6935604c43c04a832fd7d7c5aef6c7c8156a911" as Hash,
  citePayClearSpendTx: "0x74c1fa0782dd8c70586bd8a87cb014a1bda6080df794250766720d527fe57927" as Hash,
  citePayClearRepayTx: "0x1e0279903aba3e728385825e983bc840f9db804142e6314662df33afec54527f" as Hash,
  citePayRenewedCloseTx: "0x515a8a3106fbc22fd36c75fe2a626e5e2273db58d8acf10679e44c7e90b52c09" as Hash,
  forumSponsorOpenTx: "0x8f9759660161819cf924314abcaf2feefb55d973a845c6ed0921d14e560c79df" as Hash,
  forumSponsorSpendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f" as Hash,
  forumSponsorRepayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172" as Hash,
  forumSponsorCloseTx: "0xba995c10f06f14b876a6b4c19ad69cbfe023d878784961f6eaebb62a3aa16463" as Hash,
  forumSponsorReopenTx: "0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6" as Hash,
  cctpBurnTx: "0x05c3731ef37af9748a9e1a700902cddda717c4e85016c2fbabdc3e07f3f74c69" as Hash,
  cctpMintTx: "0xca5825f86fc178cb2cd21d41bc4ace4e958eaad0f0a363c7715007b577a18a82" as Hash,
  cctpOpenLineTx: "0x8c3a5781517c8c0f8c8d0c2e88791e17fca509fecaf78fb8cbcfb6cf013631fe" as Hash,
  cctpDrawTx: "0xa5dee9bb7424e0f2f4eccf13a0a2a2f32a617a227b18c1a242307bbdd92fba24" as Hash,
  cctpRepayTx: "0x41e203d38209441761647f9c81ed1660eff7d4a6467089a7aaac58259a79f99c" as Hash,
  citePayProviderQueryTxs: [
    "0x3c74ba902d9494c7762f440affa0065ef4a2478b6e9cb4cb228e11cd689a9929",
    "0xc8ee30e0c2ab5943f472baf819fb17af8b39571665ba4ac408b9fe8d9343532a",
    "0xb1b6727138218b79ec829cd221db65bd4abe47b5a9b7afee8bdd42b14e1f48bd",
    "0x88ef62f2ab2b13cbea658ca9f4d26ebd38c6e86aa8e0704dd7e51a676beadef8",
    "0x85aea6dfce5b589fa5a1e5526889d31ca9126385217614b42d0ad34656261311",
  ] as readonly Hash[],
};

const FORUM_FEEROUTER_CANARY = {
  finalBlock: 52_468_594,
  splitId: 205,
  forumShareAtomicUSDC: 7,
  protocolShareAtomicUSDC: 3,
  totalFeeAtomicUSDC: 10,
  addresses: {
    forum: "0x13585c6004fbA9D7D49219a6435B68348fD30770" as Address,
    router: "0xC86C5e032A2e81E6Df7B0A60BC6cC830F52d939A" as Address,
    splitter: "0xE901a54dDE4243940EEceD8C57F29fef5eC6eaca" as Address,
    feeRouter: "0xeFf9bc359e8f2a5eabce55af3f1bb24F98eaBF59" as Address,
  },
  txs: {
    publish: "0xccbd877f593099d75e6ac5004dd9c102c075c0ee64ea64f1b90f37c719b80b16" as Hash,
    routingDisabled: "0xe1fcd5045676c2159cf6f9c97264d53299550a62d2c0a55c7faa03acc876e855" as Hash,
    forumClaim: "0x58acbe0ba50e58e77c83a088a6320a1696b5363cbecf3b0a0b94998ea3f99c21" as Hash,
    protocolClaim: "0x80f29de9c8b4dae23c805763c90901618ffe07756bfee77117b8bcc4ab16bf37" as Hash,
  },
} as const;

const FLOAT_V2_LOG_CHUNK_SIZE = FLOAT_V2_DEFAULT_LOG_CHUNK_SIZE;

type FloatV2LineRead = readonly [Address, number, bigint, bigint, bigint, number, bigint, `0x${string}`, bigint, bigint];
type FloatV2SponsorLineRead = readonly [Address, bigint];
type FloatV2ProviderMandateRead = readonly [`0x${string}`, bigint, bigint, bigint, boolean];
type FloatV2BehaviorStatsRead = readonly [number, number, number, number, number, number];
type FloatV2AutonomousScoreRead = readonly [number, bigint, bigint];

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

type ActionState = {
  label: string;
  tx?: `0x${string}`;
  error?: string;
};





type PilotSlice = {
  sourceAddress: string;
  name: string;
  weightBps: number;
  preset: PresetKey;
  amountUSDC: string;
  reason: string;
};

type PilotPlan = {
  model: string;
  fellBack: boolean;
  fellBackReason?: string;
  headline: string;
  confidenceBps: number;
  rationale: string;
  watchSignals: string[];
  allocation: PilotSlice[];
  generatedAt: number;
  decisionHash: string;
};

type PilotRisk = "low" | "balanced" | "high";









type FloatV2AgentState = {
  label: string;
  category: "external" | "system" | "self-test";
  agent: Address;
  agentOwner?: Address;
  agentProvenance?: "verified-external-signer" | "shadow-controlled-signer" | "unverified";
  wallet: Address;
  score: number;
  creditLimitUSDC: string;
  availableCreditUSDC: string;
  activeDebtUSDC: string;
  status: number;
  statusName: string;
  lastReview?: string;
  lastReviewISO?: string | null;
  lineExpiry?: string;
  lineExpiryISO?: string | null;
  scoredByContract?: boolean;
  behavior?: {
    paidBound: number;
    signedExternalPaid: number;
    repaid: number;
    blocked: number;
    denied: number;
    errorCount: number;
  };
  behaviorStateReset?: boolean;
  autonomousScore?: {
    score: number;
    recommendedLimitUSDC: string;
    cappedLimitUSDC: string;
  };
  sponsor: Address;
  verifiedSponsor?: Address;
  sponsorProvenance?: "verified-external" | "shadow-controlled" | "unverified" | "none";
  sponsorReserveUSDC: string;
  sponsorState?:
    | "active-reserve"
    | "expired-reserve-reclaimable"
    | "expired-debt-open"
    | "closed-reserve-reclaimed"
    | "none";
  signedIntents: number;
  providerPaidCount: number;
  repaidCount: number;
  blockedCount: number;
  providerPaidUSDC: string;
  repaidUSDC: string;
  blockedUSDC: string;
  spendTx?: Hash;
  repayTx?: Hash;
  latestTxHash?: Hash;
};

type FloatV2ActivityState = {
  ok?: boolean;
  source?: "live" | "live-rpc" | "verified-snapshot" | "verified-checkpoint";
  degraded?: boolean;
  fallbackReason?: string;
  mode?: string;
  checkedAt?: string;
  servedAt?: string;
  chainId?: number;
  float?: Address;
  latestBlock?: string;
  treasuryBalanceUSDC?: string;
  totalAvailableCreditUSDC?: string;
  totalSponsoredReserveUSDC?: string;
  summary?: {
    trackedExternalAgentLines: number;
    externallySponsoredLines: number;
    operatorSponsoredLines: number;
    signedIntents: number;
    paidSpends: number;
    repaidLifecycles: number;
    openDebtAgents: number;
    returningAgents: number;
    returningSponsors: number;
    providerPaidUSDC: string;
    repaidUSDC: string;
    activeDebtUSDC: string;
    blockedUSDC: string;
  };
  operations?: FloatV2OperationalHealth;
  agents?: FloatV2AgentState[];
  selfTestAgents?: FloatV2AgentState[];
  logFetch?: {
    fromBlock?: string;
    toBlock?: string;
    complete?: boolean;
    warnings?: string[];
  };
  error?: string;
};

function isFloatV2CheckpointState(state: FloatV2ActivityState | null): boolean {
  return Boolean(
    state?.degraded || state?.source === "verified-checkpoint" || state?.source === "verified-snapshot",
  );
}

type FloatDeskEntry = {
  ok?: boolean | null;
  live?: boolean;
  cycle?: string;
  ts?: string;
  source?: string;
  decision?: {
    action?: "PAY" | "SKIP" | "REPAY" | "HOLD" | string;
    provider?: string;
    amountAtomic?: string;
    rationale?: string;
    wasClamped?: boolean;
    clampReasons?: string[];
  };
  bookNote?: string;
  assessment?: string;
  txs?: {
    spend?: {
      txHash?: Hash;
      requestHash?: Hash;
      rationaleDigest?: Hash;
      amountUSDC?: string;
      provider?: string;
      providerPaid?: boolean;
      providerDeltaUSDC?: string;
    };
    repay?: {
      txHash?: Hash;
      approve?: Hash;
      requestHash?: Hash;
      amountUSDC?: string;
    };
    settle?: {
      txHash?: Hash;
      approve?: Hash;
      requestHash?: Hash;
      amountUSDC?: string;
    };
    ask?: {
      ok?: boolean;
      status?: number;
      queryId?: string | null;
    };
  };
  reviews?: Array<{
    agent?: Address;
    txHash?: Hash;
    scoreBefore?: number;
    scoreAfter?: number;
    limitBeforeUSDC?: string;
    limitAfterUSDC?: string;
    skipped?: string;
    error?: string;
  }>;
  error?: string;
};

type FloatDeskLabLine = {
  agent?: Address;
  label?: string;
  score?: number;
  creditLimitUSDC?: string;
  availableCreditUSDC?: string;
  activeDebtUSDC?: string;
  statusName?: string;
  sponsor?: Address;
  sponsorReserveUSDC?: string;
  recommendedLimitUSDC?: string;
  cappedLimitUSDC?: string;
  scoredByContract?: boolean;
};

type FloatDeskState = {
  ok?: boolean;
  mode?: string;
  checkedAt?: string;
  labLine?: FloatDeskLabLine | null;
  entries?: FloatDeskEntry[];
  counts?: {
    cycles: number;
    pays: number;
    skips: number;
    holds: number;
    repays: number;
    settles?: number;
    clamps: number;
  };
  missing?: string[];
  error?: string;
};

const FLOAT_V2_VERIFIED_SNAPSHOT_BASE: FloatV2ActivityState = {
  ok: true,
  source: "verified-checkpoint",
  degraded: true,
  mode: "shadow-float-v2-activity",
  checkedAt: FLOAT_V2_ACTIVITY_CHECKPOINT.checkedAt,
  chainId: arcTestnet.id,
  float: FLOAT_V2_CONTRACT,
  latestBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
  treasuryBalanceUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.treasuryBalanceUSDC,
  totalAvailableCreditUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.totalAvailableCreditUSDC,
  totalSponsoredReserveUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.totalSponsoredReserveUSDC,
  summary: {
    trackedExternalAgentLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.trackedExternalAgentLines,
    externallySponsoredLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.externallySponsoredLines,
    operatorSponsoredLines: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.operatorSponsoredLines,
    signedIntents: 14,
    paidSpends: 14,
    repaidLifecycles: 13,
    openDebtAgents: 1,
    returningAgents: 1,
    returningSponsors: 1,
    providerPaidUSDC: "108000",
    repaidUSDC: "98000",
    activeDebtUSDC: "10000",
    blockedUSDC: "0",
  },
  agents: [
    {
      label: "Argus Alpha",
      category: "external",
      agent: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" as Address,
      wallet: "0x5c0b33b209f510868E07792Edc46c3792B0b92EC" as Address,
      score: 9000,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200309",
      lastReviewISO: "2026-07-16T11:11:49.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 2, repaid: 2, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 9000, recommendedLimitUSDC: "1000000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      latestTxHash: "0x0f50d4c2b6eac8b2cdee64ac484eaf425453f9db13ad92c2db19e2a867ff3699" as Hash,
    },
    {
      label: "Argus Beta",
      category: "external",
      agent: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c" as Address,
      wallet: "0x7D4897489BFC663b90BaAF5B0803d18ae0ca817c" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200317",
      lastReviewISO: "2026-07-16T11:11:57.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xac1b0d231b0d19ebcb8e18877e7fcffbb2cbf990f204f648c288053bb597d679" as Hash,
    },
    {
      label: "Argus Gamma",
      category: "external",
      agent: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89" as Address,
      wallet: "0x43e0630025FD0339bE1fA04d3d75Daf355F50c89" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200325",
      lastReviewISO: "2026-07-16T11:12:05.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xad8301ca4edbbed18bc7204d8da9be53492116649a326728ad0ca5bc19bb1682" as Hash,
    },
    {
      label: "CitePay",
      category: "external",
      agent: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      wallet: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200279",
      lastReviewISO: "2026-07-16T11:11:19.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0x0090b55caa8553540e38b886e09e5b88fdda051254305eb36676e9dd8f842ad2" as Hash,
    },
    {
      label: "Crux",
      category: "external",
      agent: "0x9972fF27a2EADBDB8414072736395236E0BF0092" as Address,
      wallet: "0x9972fF27a2EADBDB8414072736395236E0BF0092" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200287",
      lastReviewISO: "2026-07-16T11:11:27.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0x6fd0e59360decc8fdecd56c8bf1a448569d72e6e5706d862e50c816d50b29a7d" as Hash,
      repayTx: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
      latestTxHash: "0xd7744d749c02fa7f1f458d391ceca16929a49410e86bed5ce46e745b0064c368" as Hash,
    },
    {
      label: "CitePay sponsor (retired line)",
      category: "external",
      agent: "0xdfDEA2015f0b176e89a79cb8b4D5ef22bE6e044f" as Address,
      wallet: ZERO_ADDRESS,
      score: 0,
      creditLimitUSDC: "0",
      availableCreditUSDC: "0",
      activeDebtUSDC: "0",
      status: 4,
      statusName: "REVOKED",
      lastReview: "1784399293",
      lastReviewISO: "2026-07-18T18:28:13.000Z",
      lineExpiry: "0",
      lineExpiryISO: null,
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 0, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      behaviorStateReset: true,
      autonomousScore: { score: 0, recommendedLimitUSDC: "0", cappedLimitUSDC: "0" },
      sponsor: ZERO_ADDRESS,
      verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      sponsorReserveUSDC: "0",
      sponsorState: "closed-reserve-reclaimed",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0xeeb2f3b31215a00ef5becbd7c0388f28ec943efc383af5cc7f83f86c044d6dae" as Hash,
      repayTx: "0x2e2ecb060340f04173d945bd45dc64119309c7e692ec7ad8d4e295413a8d06fe" as Hash,
      latestTxHash: "0x2d91c37cc23ff8f342614bb9070e82efb37d0d588b15a43a3685c92786074e0d" as Hash,
    },
    {
      label: "CitePay sponsor (renewed line)",
      category: "external",
      agent: "0x236652EAd43fbb0948173fC4dDF23BC0971B274d" as Address,
      wallet: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.wallet,
      score: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.score,
      creditLimitUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.creditLimitUSDC,
      availableCreditUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.availableCreditUSDC,
      activeDebtUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.activeDebtUSDC,
      status: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.status,
      statusName: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.statusName,
      lastReview: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.lastReview,
      lastReviewISO: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.checkedAt,
      lineExpiry: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.lineExpiry,
      lineExpiryISO: null,
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 0, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      behaviorStateReset: true,
      autonomousScore: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.autonomousScore,
      sponsor: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.sponsor,
      verifiedSponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105" as Address,
      sponsorProvenance: "none",
      sponsorReserveUSDC: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.sponsorReserveUSDC,
      sponsorState: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.sponsorState as "closed-reserve-reclaimed",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "6000",
      repaidUSDC: "6000",
      blockedUSDC: "0",
      spendTx: FLOAT_V2_PROOF.citePayRenewedSpendTx,
      repayTx: FLOAT_V2_PROOF.citePayRenewedRepayTx,
      latestTxHash: FLOAT_V2_VERIFIED_POST_RECLAIM_STATE.citePayRenewedLine.closeTxHash,
    },
    {
      label: "Forum Tollgate sponsor",
      category: "external",
      agent: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C" as Address,
      wallet: "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C" as Address,
      score: 7500,
      creditLimitUSDC: "25000",
      availableCreditUSDC: "25000",
      activeDebtUSDC: "0",
      status: 1,
      statusName: "ELIGIBLE",
      lastReview: "1784200302",
      lastReviewISO: "2026-07-16T11:11:42.000Z",
      lineExpiry: "1783785148",
      lineExpiryISO: "2026-07-11T15:52:28.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 0, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 7500, recommendedLimitUSDC: "25000", cappedLimitUSDC: "25000" },
      sponsor: "0x12F25B721Cc21c38495e33A4c8524dd0B647ba03" as Address,
      sponsorReserveUSDC: "50000",
      sponsorState: "expired-reserve-reclaimable",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      spendTx: "0x0bd8271279c6fcde28cc4de51b5f54be4842a8c1e3ed304a221c6281db20f75f" as Hash,
      repayTx: "0x48a81e86ccc7c49814929e44dca93d2f44f82322abff587903419a64e8302172" as Hash,
      latestTxHash: "0xc8694da66f078d81c4199df813e8ee7b69941a14b6aef4531f6c35ca771da2e6" as Hash,
    },
    {
      label: "Driplet",
      category: "external",
      agent: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" as Address,
      wallet: "0xb8C0297Bc883a5626424FFFf9ad1F860E0f64CCf" as Address,
      score: 9000,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200340",
      lastReviewISO: "2026-07-16T11:12:20.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 2, repaid: 2, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 9000, recommendedLimitUSDC: "1000000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 2,
      providerPaidCount: 2,
      repaidCount: 2,
      blockedCount: 0,
      providerPaidUSDC: "11000",
      repaidUSDC: "11000",
      blockedUSDC: "0",
      spendTx: "0x2ea8a96245a427e8c307e89ae4abda055e172121789d1c0e30f41a400e1ba409" as Hash,
      repayTx: "0x5ace712f258220aa891d3c786458ede15ba8a5e281173e66571807a3a93aa13e" as Hash,
      latestTxHash: "0x5ace712f258220aa891d3c786458ede15ba8a5e281173e66571807a3a93aa13e" as Hash,
    },
    {
      label: "Forum",
      category: "external",
      agent: "0x13585c6004fbA9D7D49219a6435B68348fD30770" as Address,
      wallet: "0x13585c6004fbA9D7D49219a6435B68348fD30770" as Address,
      score: 8250,
      creditLimitUSDC: "50000",
      availableCreditUSDC: "50000",
      activeDebtUSDC: "0",
      status: 5,
      statusName: "REPAID",
      lastReview: "1784200272",
      lastReviewISO: "2026-07-16T11:11:12.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 1, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 8250, recommendedLimitUSDC: "50000", cappedLimitUSDC: "50000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 1,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "10000",
      blockedUSDC: "0",
      latestTxHash: "0xfba85515afe3fa1c9bae84b244bb874657756bd1656612d8b71b0686f412892e" as Hash,
    },
    {
      label: "Obol",
      category: "external",
      agent: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3" as Address,
      wallet: "0xd39AcD18d4aB66f31e3f1931953374d4a546ABA3" as Address,
      score: 7850,
      creditLimitUSDC: "25000",
      availableCreditUSDC: "15000",
      activeDebtUSDC: "10000",
      status: 2,
      statusName: "LIMITED",
      lastReview: "1784200332",
      lastReviewISO: "2026-07-16T11:12:12.000Z",
      scoredByContract: true,
      behavior: { paidBound: 0, signedExternalPaid: 1, repaid: 0, blocked: 0, denied: 0, errorCount: 0 },
      autonomousScore: { score: 7850, recommendedLimitUSDC: "25000", cappedLimitUSDC: "25000" },
      sponsor: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
      sponsorReserveUSDC: "50000",
      signedIntents: 1,
      providerPaidCount: 1,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: "10000",
      repaidUSDC: "0",
      blockedUSDC: "0",
      spendTx: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
      latestTxHash: "0x78567fc68238c6b309aa26916bbf3f456d4da20de27ecb4e9e6a7d3a245acc8a" as Hash,
    },
  ],
  selfTestAgents: [],
  logFetch: {
    fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
    toBlock: FLOAT_V2_ACTIVITY_CHECKPOINT.blockNumber.toString(),
    complete: true,
    warnings: [],
  },
};

const FLOAT_V2_VERIFIED_SNAPSHOT: FloatV2ActivityState = {
  ...FLOAT_V2_VERIFIED_SNAPSHOT_BASE,
  operations: buildFloatV2OperationalHealth({
    source: "verified-checkpoint",
    degraded: true,
    treasuryBalanceUSDC: FLOAT_V2_VERIFIED_SNAPSHOT_BASE.treasuryBalanceUSDC ?? "0",
    totalSponsoredReserveUSDC: FLOAT_V2_VERIFIED_SNAPSHOT_BASE.totalSponsoredReserveUSDC ?? "0",
    agents: [
      ...(FLOAT_V2_VERIFIED_SNAPSHOT_BASE.agents ?? []),
      {
        label: "CCTP-funded system line",
        agent: "0xec28bfA6f4BcFf23933E21B7AbfB6D53287976A8",
        activeDebtUSDC: "0",
        sponsorReserveUSDC: "900000",
        statusName: "REPAID",
      },
      {
        label: "Float Desk system line",
        agent: "0x43553CaeE153496200d37644cE28775B2b2b522E",
        activeDebtUSDC: "0",
        sponsorReserveUSDC: "50000",
        statusName: "REPAID",
      },
      {
        label: "V2 verifier system line",
        agent: "0x5773dd87b1A2b57697f773F0dcdFa65f405662a0",
        activeDebtUSDC: "0",
        sponsorReserveUSDC: "50000",
        statusName: "REPAID",
      },
    ],
  }),
};

type TreasuryCheck = {
  check: string;
  status: "PASS" | "FAIL";
  ok: boolean;
  detail: string;
};

type TreasuryState = {
  ok: boolean;
  checkedAt?: string;
  mode?: string;
  chainId?: number;
  operator?: Address;
  requestHash?: Hash;
  txs?: {
    createMandate?: Hash;
    allowedAllocation?: Hash;
    blockedAllocation?: Hash;
    x402Settlement?: Hash;
    floatBind?: Hash;
  };
  amounts?: {
    allowedAllocationUSDC?: string;
    blockedAttemptUSDC?: string;
    x402PaidUSDC?: string;
    floatFeeUSDC?: string;
  };
  checks?: TreasuryCheck[];
  currentV4?: LeptonV4Readiness;
  error?: string;
};

const TREASURY_PROOF = {
  operator: "0x26bA923FbbB4404395E61f94Ca4b39823A1763c5" as Address,
  float: "0xF305647bA0ff7f1E2d4bE5f37F2EF9f930531057" as Address,
  mandateRegistry: "0xe3cf1a4d54f627f599255142cef4bf9b8c361a4c" as Address,
  mandateAttestor: "0x9b5afc6c442364d4397763917ebbc659d85ee86d" as Address,
  bondedEnforcer: "0x1825f447c0aa8e64dd2d290cdce85d82993d0e1e" as Address,
  morphoAdapter: "0xba9f134f7b13dadd45dcf16b09c5121a7555e2c5" as Address,
  vaultSink: "0x110f79c5617797b199d3d6e2abb855c34fbc5e58" as Address,
  amountAllocatedUSDC: "100000",
  amountBlockedUSDC: "300000",
  amountX402USDC: "1000",
  feeUSDC: "10",
  txs: {
    createMandate: "0x5f511e1bf49fadf998b7a94f5e34598510e9479fab15f5a5fb713636c158a411" as Hash,
    allocation: "0x9836e74ee95907847fac464f3a65554cf314adab9efe7141f4644022b3e09c17" as Hash,
    blocked: "0x7d3dddd89dc50ea5b410564c7f1134ce1350fd3687e8cefec74192d9e9b4bd23" as Hash,
    x402Settlement: "0x516d95ed55d61663c491f2cccb45d1d16d83967bdcc6fc66899d05426fea80ab" as Hash,
    floatBind: "0x7fe14e70081f682017d5804250f9db6b0dc7416fe1eb100f7135c6e34007d103" as Hash,
  },
  hashes: {
    floatRequest: "0xbcb5bbbcdd270198a5c4258d34ac1c0625c8b807f8fe8dde8912ac12feda910b",
    allowedAction: "0x7b0f276c844b63db15c82995ba154ffb136dab19aa7481a853ce95eedff16205",
    blockedAction: "0xe93a7933e6ce39a04dcb0bf8561c838930f8333b6d4eeb4f60db4d2a366b7523",
  },
};

async function fetchFloatV2Activity(): Promise<FloatV2ActivityState> {
  try {
    const res = await fetch("/api/float?mode=v2");
    const data = await res.json();
    if (res.ok && data?.ok && data?.logFetch?.complete !== false) return data as FloatV2ActivityState;
    if (res.ok && data?.ok && data?.logFetch?.complete === false) {
      throw new Error("V2 API returned an incomplete log read");
    }
    throw new Error(data?.error || `V2 API returned ${res.status}`);
  } catch (error) {
    console.warn("Falling back to the verified V2 checkpoint", error);
    return {
      ...FLOAT_V2_VERIFIED_SNAPSHOT,
      servedAt: new Date().toISOString(),
      fallbackReason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchFloatDeskJournal(): Promise<FloatDeskState> {
  const res = await fetch(`/api/float?mode=desk&ts=${Date.now()}`, { cache: "no-store" });
  const data = (await res.json()) as FloatDeskState;
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `desk read failed with ${res.status}`);
  return data;
}

async function fetchFloatV2ActivityFromRpc(): Promise<FloatV2ActivityState> {
  const client = createClient({
    chain: arcTestnet,
    transport: http(arcTestnetRpcUrl(import.meta.env.VITE_ARC_RPC_URL)),
  });
  const latestBlock = BigInt(await client.getBlockNumber());
  const float = getAddress(FLOAT_V2_CONTRACT);
  const [intentLogs, receiptLogs] = await Promise.all([
    getFloatV2Logs(client, float, floatV2IntentConsumedEvent, FLOAT_V2_DEPLOY_BLOCK, latestBlock),
    getFloatV2Logs(client, float, floatV2ReceiptEvent, FLOAT_V2_DEPLOY_BLOCK, latestBlock),
  ]);
  const [treasuryBalance, totalAvailableCredit, totalSponsoredReserve] = await Promise.all([
    readFloatV2Uint(client, "treasuryBalanceUSDC", latestBlock),
    readFloatV2Uint(client, "totalAvailableCreditUSDC", latestBlock),
    readFloatV2Uint(client, "totalSponsoredReserveUSDC", latestBlock),
  ]);

  type AgentStats = {
    label: string;
    category: "external" | "system" | "self-test";
    agent: Address;
    agentOwner: Address;
    agentProvenance: "verified-external-signer" | "shadow-controlled-signer" | "unverified";
    verifiedSponsor?: Address;
    retired?: boolean;
    spendTx?: Hash;
    repayTx?: Hash;
    latestTxHash?: Hash;
    signedIntents: number;
    providerPaidCount: number;
    repaidCount: number;
    blockedCount: number;
    providerPaidUSDC: bigint;
    repaidUSDC: bigint;
    blockedUSDC: bigint;
  };

  const tracked = new Map(
    [...FLOAT_V2_TRACKED_AGENTS, ...FLOAT_V2_OPERATIONAL_ONLY_AGENTS].map((entry) => [
      getAddress(entry.agent).toLowerCase(),
      entry,
    ]),
  );
  const statsByAgent = new Map<string, AgentStats>();
  const ensureStats = (address: Address): AgentStats => {
    const agent = getAddress(address);
    const key = agent.toLowerCase();
    const existing = statsByAgent.get(key);
    if (existing) return existing;
    const trackedEntry = tracked.get(key);
    const stats: AgentStats = {
      label: trackedEntry?.label || "V2 proof agent",
      category: trackedEntry?.category ?? "self-test",
      agent,
      agentOwner: agent,
      agentProvenance: trackedEntry?.agentProvenance ?? "unverified",
      verifiedSponsor: trackedEntry?.verifiedSponsor,
      retired: trackedEntry?.retired,
      spendTx: trackedEntry?.spendTx,
      repayTx: trackedEntry?.repayTx,
      signedIntents: 0,
      providerPaidCount: 0,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: 0n,
      repaidUSDC: 0n,
      blockedUSDC: 0n,
    };
    statsByAgent.set(key, stats);
    return stats;
  };

  for (const entry of FLOAT_V2_TRACKED_AGENTS) {
    ensureStats(entry.agent);
  }

  for (const log of intentLogs) {
    const stats = ensureStats(getAddress(String((log as any).args.agent)));
    stats.signedIntents += 1;
    stats.latestTxHash = (log as any).transactionHash;
  }

  for (const log of receiptLogs) {
    const args = (log as any).args;
    const stats = ensureStats(getAddress(String(args.agent)));
    const receiptType = Number(args.receiptType);
    const amount = BigInt(args.amountUSDC || 0);
    if (receiptType === 3) {
      stats.blockedCount += 1;
      stats.blockedUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
    if (receiptType === 4) {
      stats.providerPaidCount += 1;
      stats.providerPaidUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
    if (receiptType === 6) {
      stats.repaidCount += 1;
      stats.repaidUSDC += amount;
      stats.latestTxHash = (log as any).transactionHash;
    }
  }

  const stateEntries: AgentStats[] = [
    ...statsByAgent.values(),
    ...FLOAT_V2_OPERATIONAL_ONLY_AGENTS.filter(
      (entry) => !statsByAgent.has(getAddress(entry.agent).toLowerCase()),
    ).map((entry) => ({
      ...entry,
      agent: getAddress(entry.agent),
      agentOwner: getAddress(entry.agent),
      signedIntents: 0,
      providerPaidCount: 0,
      repaidCount: 0,
      blockedCount: 0,
      providerPaidUSDC: 0n,
      repaidUSDC: 0n,
      blockedUSDC: 0n,
    })),
  ];

  const agents = await Promise.all(
    stateEntries.map(async (stats): Promise<FloatV2AgentState> => {
      const [line, sponsorLine, lineExpiry, behaviorStats, autonomousScore] = await Promise.all([
        readFloatV2Line(client, stats.agent, latestBlock),
        readFloatV2SponsorLine(client, stats.agent, latestBlock),
        readFloatV2LineExpiry(client, stats.agent, latestBlock),
        readFloatV2BehaviorStats(client, stats.agent, latestBlock),
        readFloatV2AutonomousScore(client, stats.agent, latestBlock),
      ]);
      const status = Number(line[5]);
      const sponsorReserveUSDC = sponsorLine[1].toString();
      const sponsorState = classifyFloatV2SponsorState(sponsorLine[1], lineExpiry, line[4], stats.repaidCount);
      return {
        label: stats.label,
        category: stats.category,
        agent: stats.agent,
        agentOwner: stats.agentOwner,
        agentProvenance: stats.agentProvenance,
        wallet: line[0],
        score: Number(line[1]),
        creditLimitUSDC: line[2].toString(),
        availableCreditUSDC: line[3].toString(),
        activeDebtUSDC: line[4].toString(),
        status,
        statusName: FLOAT_V2_STATUS_NAMES[status] || "UNKNOWN",
        lastReview: line[6].toString(),
        lastReviewISO: line[6] > 0n ? new Date(Number(line[6]) * 1000).toISOString() : null,
        lineExpiry: lineExpiry.toString(),
        lineExpiryISO: lineExpiry > 0n ? new Date(Number(lineExpiry) * 1000).toISOString() : null,
        scoredByContract: true,
        behavior: {
          paidBound: Number(behaviorStats[0]),
          signedExternalPaid: Number(behaviorStats[1]),
          repaid: Number(behaviorStats[2]),
          blocked: Number(behaviorStats[3]),
          denied: Number(behaviorStats[4]),
          errorCount: Number(behaviorStats[5]),
        },
        behaviorStateReset: Boolean(stats.retired) || sponsorState === "closed-reserve-reclaimed",
        autonomousScore: {
          score: Number(autonomousScore[0]),
          recommendedLimitUSDC: autonomousScore[1].toString(),
          cappedLimitUSDC: autonomousScore[2].toString(),
        },
        sponsor: sponsorLine[0],
        verifiedSponsor: stats.verifiedSponsor,
        sponsorProvenance: classifyFloatV2SponsorProvenance(sponsorLine[0]),
        sponsorReserveUSDC,
        sponsorState,
        signedIntents: stats.signedIntents,
        providerPaidCount: stats.providerPaidCount,
        repaidCount: stats.repaidCount,
        blockedCount: stats.blockedCount,
        providerPaidUSDC: stats.providerPaidUSDC.toString(),
        repaidUSDC: stats.repaidUSDC.toString(),
        blockedUSDC: stats.blockedUSDC.toString(),
        spendTx: stats.spendTx,
        repayTx: stats.repayTx,
        latestTxHash: stats.latestTxHash,
      };
    }),
  );

  const visibleAgents = agents
    .filter((agent) => agent.category === "external")
    .sort((a, b) => {
      const aDebt = BigInt(a.activeDebtUSDC) > 0n ? 1 : 0;
      const bDebt = BigInt(b.activeDebtUSDC) > 0n ? 1 : 0;
      if (a.statusName === "REPAID" && b.statusName !== "REPAID") return -1;
      if (b.statusName === "REPAID" && a.statusName !== "REPAID") return 1;
      if (aDebt !== bDebt) return bDebt - aDebt;
      return a.label.localeCompare(b.label);
    });
  const provenance = summarizeFloatV2PilotProvenance(visibleAgents);
  const summary = {
    trackedExternalAgentLines: provenance.trackedExternalAgentLines,
    externallySponsoredLines: provenance.externallySponsoredLines,
    operatorSponsoredLines: provenance.operatorSponsoredLines,
    signedIntents: visibleAgents.reduce((sum, agent) => sum + agent.signedIntents, 0),
    paidSpends: visibleAgents.reduce((sum, agent) => sum + agent.providerPaidCount, 0),
    repaidLifecycles: visibleAgents.reduce((sum, agent) => sum + agent.repaidCount, 0),
    openDebtAgents: visibleAgents.filter((agent) => BigInt(agent.activeDebtUSDC) > 0n).length,
    returningAgents: provenance.returningAgents,
    returningSponsors: provenance.returningSponsors,
    providerPaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.providerPaidUSDC), 0n).toString(),
    repaidUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.repaidUSDC), 0n).toString(),
    activeDebtUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.activeDebtUSDC), 0n).toString(),
    blockedUSDC: visibleAgents.reduce((sum, agent) => sum + BigInt(agent.blockedUSDC), 0n).toString(),
  };
  const operations = buildFloatV2OperationalHealth({
    source: "live-rpc",
    degraded: false,
    treasuryBalanceUSDC: treasuryBalance.toString(),
    totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
    agents,
  });

  return {
    ok: true,
    mode: "shadow-float-v2-activity",
    checkedAt: new Date().toISOString(),
    chainId: arcTestnet.id,
    float,
    latestBlock: latestBlock.toString(),
    treasuryBalanceUSDC: treasuryBalance.toString(),
    totalAvailableCreditUSDC: totalAvailableCredit.toString(),
    totalSponsoredReserveUSDC: totalSponsoredReserve.toString(),
    summary,
    operations,
    agents: visibleAgents,
    selfTestAgents: agents.filter((agent) => agent.category === "self-test"),
    logFetch: {
      fromBlock: FLOAT_V2_DEPLOY_BLOCK.toString(),
      toBlock: latestBlock.toString(),
      complete: true,
      warnings: [],
    },
  };
}

async function getFloatV2Logs(client: PublicClient, address: Address, event: ReturnType<typeof parseAbiItem>, fromBlock: bigint, toBlock: bigint) {
  const logs: Array<{
    args: Record<string, unknown>;
    transactionHash: Hash;
  }> = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const chunkEnd = cursor + FLOAT_V2_LOG_CHUNK_SIZE - 1n > toBlock ? toBlock : cursor + FLOAT_V2_LOG_CHUNK_SIZE - 1n;
    logs.push(...((await client.getLogs({ address, event: event as any, fromBlock: cursor, toBlock: chunkEnd })) as typeof logs));
    cursor = chunkEnd + 1n;
  }
  return logs;
}

async function readFloatV2Uint(
  client: PublicClient,
  functionName: "treasuryBalanceUSDC" | "totalAvailableCreditUSDC" | "totalSponsoredReserveUSDC",
  blockNumber: bigint,
) {
  return client.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName, blockNumber }) as Promise<bigint>;
}

async function readFloatV2Line(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "lines",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2LineRead>;
}

async function readFloatV2SponsorLine(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "lineSponsors",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2SponsorLineRead>;
}

async function readFloatV2LineExpiry(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "lineExpiries",
    args: [agent],
    blockNumber,
  }) as Promise<bigint>;
}

async function readFloatV2BehaviorStats(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "behaviorStats",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2BehaviorStatsRead>;
}

async function readFloatV2AutonomousScore(client: PublicClient, agent: Address, blockNumber: bigint) {
  return client.readContract({
    address: FLOAT_V2_CONTRACT,
    abi: floatV2Abi,
    functionName: "autonomousLineScore",
    args: [agent],
    blockNumber,
  }) as Promise<FloatV2AutonomousScoreRead>;
}

function classifyFloatV2SponsorProvenance(sponsor: Address): NonNullable<FloatV2AgentState["sponsorProvenance"]> {
  const key = getAddress(sponsor).toLowerCase();
  if (key === ZERO_ADDRESS.toLowerCase()) return "none";
  if (SHADOW_CONTROLLED_SPONSOR_KEYS.has(key)) return "shadow-controlled";
  if (VERIFIED_EXTERNAL_SPONSOR_KEYS.has(key)) return "verified-external";
  return "unverified";
}

function floatV2SponsorProvenance(agent: FloatV2AgentState): NonNullable<FloatV2AgentState["sponsorProvenance"]> {
  return agent.sponsorProvenance || classifyFloatV2SponsorProvenance(agent.sponsor);
}

function floatV2SponsorProvenanceLabel(agent: FloatV2AgentState): string {
  const provenance = floatV2SponsorProvenance(agent);
  if (provenance === "verified-external") return "verified external sponsor";
  if (provenance === "shadow-controlled") return "Shadow operator sponsor";
  if (provenance === "none") return "no active sponsor";
  return "unverified sponsor";
}

function classifyFloatV2SponsorState(
  reserveUSDC: bigint,
  lineExpiry: bigint,
  activeDebtUSDC: bigint,
  repaidCount: number,
): NonNullable<FloatV2AgentState["sponsorState"]> {
  if (reserveUSDC > 0n) {
    const expired = lineExpiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) > lineExpiry;
    if (expired) return activeDebtUSDC > 0n ? "expired-debt-open" : "expired-reserve-reclaimable";
    return "active-reserve";
  }
  return repaidCount > 0 && activeDebtUSDC === 0n ? "closed-reserve-reclaimed" : "none";
}

function summarizeFloatV2PilotProvenance(agents: FloatV2AgentState[]) {
  const trackedExternalAgents = agents.filter(
    (agent) =>
      agent.category === "external" &&
      (agent.agentProvenance || "verified-external-signer") === "verified-external-signer" &&
      BigInt(agent.sponsorReserveUSDC) > 0n,
  );
  const externallySponsoredAgents = trackedExternalAgents.filter(
    (agent) => floatV2SponsorProvenance(agent) === "verified-external",
  );
  const operatorSponsoredAgents = trackedExternalAgents.filter(
    (agent) => floatV2SponsorProvenance(agent) === "shadow-controlled",
  );
  return {
    trackedExternalAgentLines: trackedExternalAgents.length,
    externallySponsoredLines: externallySponsoredAgents.length,
    operatorSponsoredLines: operatorSponsoredAgents.length,
    returningAgents: countFloatV2VerifiedReturningAgents(),
    returningSponsors: countFloatV2VerifiedReturningSponsors(),
  };
}

function startVisiblePolling(task: () => void | Promise<void>, intervalMs: number) {
  let disposed = false;
  let running = false;

  const run = async () => {
    if (disposed || running || document.visibilityState !== "visible") return;
    running = true;
    try {
      await task();
    } catch {
      // Individual refresh functions expose their own degraded state.
    } finally {
      running = false;
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void run();
  };

  void run();
  const interval = window.setInterval(() => void run(), intervalMs);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    disposed = true;
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

const ROUTE_TITLES: Record<string, string> = routeMetadata.routeTitles;
const ROUTE_DESCRIPTIONS: Record<string, string> = routeMetadata.socialDescriptions;
const ROUTE_IMAGES: Record<string, { image: string; alt: string }> = routeMetadata.socialImages;

function EvidenceRedirect({ fallbackHash = "" }: { fallbackHash?: string }) {
  const hash = useLocation().hash;
  return <Navigate to={`/evidence${hash || fallbackHash}`} replace />;
}

function App() {
  const { pathname } = useLocation();
  const route = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  const isEvidenceRoute = route === "/evidence";
  const usesFloatV2State = isEvidenceRoute || route === "/builders/v2";
  const isGuardedMainnetRoute = route === "/mainnet" && import.meta.env.VITE_SHADOW_GUARDED_MAINNET_CANDIDATE === "true";
  const isGuardedTestnetRoute = route === "/guarded-testnet" && import.meta.env.VITE_SHADOW_GUARDED_TESTNET_CANDIDATE === "true";
  const isFundingDeskRoute = route === "/funding" || (route === "/start" || route.startsWith("/start/")) || route === "/mainnet" || isGuardedTestnetRoute;
  const [account, setAccount] = useState<Address>();
  const [action, setAction] = useState<ActionState>({ label: "ready" });
  const [selectedSource, setSelectedSource] = useState<Address | null>(null);
  const [leptonState, setLeptonState] = useState<LeptonState | null>(null);
  const [leptonLoading, setLeptonLoading] = useState(false);
  const [leptonError, setLeptonError] = useState<string | null>(null);
  const [floatV2State, setFloatV2State] = useState<FloatV2ActivityState | null>(FLOAT_V2_VERIFIED_SNAPSHOT);
  const [floatV2Loading, setFloatV2Loading] = useState(false);
  const [floatV2Error, setFloatV2Error] = useState<string | null>(null);
  const [floatDeskState, setFloatDeskState] = useState<FloatDeskState | null>(null);
  const [floatDeskLoading, setFloatDeskLoading] = useState(false);
  const [floatDeskError, setFloatDeskError] = useState<string | null>(null);
  const [treasuryState, setTreasuryState] = useState<TreasuryState | null>(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);

  useEffect(() => {
    const metadataKey = route.startsWith("/start/") ? "/start" : route;
    const metadataRoute = ROUTE_TITLES[metadataKey] && ROUTE_DESCRIPTIONS[metadataKey] ? metadataKey : "/";
    const title = ROUTE_TITLES[metadataRoute];
    const description = ROUTE_DESCRIPTIONS[metadataRoute];
    const url = `${SHADOW_ORIGIN}${metadataRoute}`;
    const socialImage = ROUTE_IMAGES[metadataRoute] ?? ROUTE_IMAGES["/"];
    document.title = title;
    document.head.querySelector<HTMLMetaElement>('meta[name="description"]')!.content = description;
    document.head.querySelector<HTMLMetaElement>('meta[property="og:title"]')!.content = title;
    document.head.querySelector<HTMLMetaElement>('meta[property="og:description"]')!.content = description;
    document.head.querySelector<HTMLMetaElement>('meta[property="og:url"]')!.content = url;
    document.head.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')!.content = title;
    document.head.querySelector<HTMLMetaElement>('meta[name="twitter:description"]')!.content = description;
    document.head.querySelector<HTMLMetaElement>('meta[property="og:image"]')!.content = `${SHADOW_ORIGIN}${socialImage.image}`;
    document.head.querySelector<HTMLMetaElement>('meta[property="og:image:alt"]')!.content = socialImage.alt;
    document.head.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')!.content = `${SHADOW_ORIGIN}${socialImage.image}`;
    document.head.querySelector<HTMLMetaElement>('meta[name="twitter:image:alt"]')!.content = socialImage.alt;
    let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.append(canonical);
    }
    canonical.href = url;
  }, [route]);




  async function refreshLepton() {
    setLeptonLoading(true);
    try {
      setLeptonState(await fetchLeptonState());
      setLeptonError(null);
    } catch (error) {
      setLeptonError(error instanceof Error ? error.message : String(error));
    } finally {
      setLeptonLoading(false);
    }
  }

  useEffect(() => {
    if (!isEvidenceRoute) return;
    return startVisiblePolling(refreshLepton, 10 * 60_000);
  }, [isEvidenceRoute]);



  async function refreshFloatV2() {
    setFloatV2Loading(true);
    try {
      const data = await fetchFloatV2Activity();
      setFloatV2State(data);
      setFloatV2Error(null);
    } catch (error) {
      setFloatV2State(FLOAT_V2_VERIFIED_SNAPSHOT);
      setFloatV2Error(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatV2Loading(false);
    }
  }

  useEffect(() => {
    if (!usesFloatV2State) return;
    return startVisiblePolling(refreshFloatV2, 5 * 60_000);
  }, [usesFloatV2State]);

  async function refreshFloatDesk() {
    setFloatDeskLoading(true);
    try {
      setFloatDeskState(await fetchFloatDeskJournal());
      setFloatDeskError(null);
    } catch (error) {
      setFloatDeskError(error instanceof Error ? error.message : String(error));
    } finally {
      setFloatDeskLoading(false);
    }
  }

  useEffect(() => {
    if (!isEvidenceRoute) return;
    return startVisiblePolling(refreshFloatDesk, 5 * 60_000);
  }, [isEvidenceRoute]);

  async function refreshTreasury() {
    setTreasuryLoading(true);
    try {
      const response = await fetch("/api/treasury");
      const data = (await response.json()) as TreasuryState;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Treasury read failed with ${response.status}`);
      }
      setTreasuryState(data);
      setTreasuryError(null);
    } catch (error) {
      setTreasuryError(error instanceof Error ? error.message : String(error));
    } finally {
      setTreasuryLoading(false);
    }
  }

  useEffect(() => {
    if (!isEvidenceRoute) return;
    return startVisiblePolling(refreshTreasury, 10 * 60_000);
  }, [isEvidenceRoute]);





  async function connectWallet() {
    if (!window.ethereum) {
      setAction({ label: "wallet missing", error: "Install a browser wallet to write transactions." });
      return;
    }
    try {
      setAction({ label: "connecting wallet" });
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[];
      setAccount(accounts[0]);
      await switchToArc();
      setAction({ label: "wallet connected on Arc Testnet" });
    } catch (error) {
      setAction({ label: "wallet connect failed", error: error instanceof Error ? error.message : String(error) });
    }
  }







  const navigate = useNavigate();

  const followFromAgents = (addr: Address) => {
    setSelectedSource(addr);
    navigate("/follow");
  };

  const evidencePage = (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">public records</p>
        <h1 className="pageTitle">Evidence</h1>
        <p className="pageLede">This page brings the Float board and supporting records together.</p>
      </section>
      <section className="evidenceGroup" id="float" aria-labelledby="evidenceFloatTitle">
        <div className="treasurySectionHeader">
          <h2 id="evidenceFloatTitle">Float activity</h2>
          <p>The Float activity panel shows the current board and desk journal.</p>
        </div>
      <FloatV2CurrentPanel
        state={floatV2State}
        loading={floatV2Loading}
        error={floatV2Error}
        deskState={floatDeskState}
        deskLoading={floatDeskLoading}
        deskError={floatDeskError}
      />
      </section>
      <section className="evidenceGroup" id="records" aria-labelledby="evidenceRecordsTitle">
        <div className="treasurySectionHeader">
          <h2 id="evidenceRecordsTitle">Supporting records</h2>
          <p>These panels show mandate checks, settlement records, and linked onchain evidence.</p>
        </div>
        <TreasuryHero treasuryState={treasuryState} />
        <TreasuryEvidenceStrip treasuryState={treasuryState} />
        <ForumFeeRouterCanaryProof />
        <TreasuryRailSplit leptonState={leptonState} />
        <TreasuryLiveVerifierPanel state={treasuryState} loading={treasuryLoading} error={treasuryError} />
        <TreasuryOnchainLinks />
        <TreasuryValidationPanel />
      </section>
    </div>
  );

  const buildersPage = <BuildersPage />;
  const floatV2ToolsPage = (
    <div className="routePage">
      <section className="pageHead">
        <p className="pageEyebrow">builders · agent access</p>
        <h1 className="pageTitle">Give your agent sponsor-backed capacity without pre-funding it first.</h1>
        <p className="pageLede">
          These tools are for the earlier Float V2 contract; the current public testnet browser flow starts at /start.
        </p>
        <p className="pageLede">
          Shadow Float is for buyer agents that need paid data, compute, or API calls under strict policy. The agent signs
          a bounded intent; V2 verifies it onchain, pays the named provider from sponsor reserve, and records the debt trail.
        </p>
      </section>
      <FloatBuilderPilot
        account={account}
        state={floatV2State}
        loading={floatV2Loading}
        onAccountChange={setAccount}
        onRefresh={refreshFloatV2}
      />
      <FloatPilotOperations state={floatV2State} loading={floatV2Loading} />
      <section className="builderFlowGrid" aria-label="Builder integration flow">
        <article className="builderFlowCard">
          <span>1</span>
          <strong>Request a line</strong>
          <p>Share the Arc testnet wallet your agent actually controls. A sponsor reserves bounded USDC capacity for that signer.</p>
        </article>
        <article className="builderFlowCard">
          <span>2</span>
          <strong>Sign an intent</strong>
          <p>Sign typed data locally. The key stays on your machine; only the intent JSON and signature are shared.</p>
        </article>
        <article className="builderFlowCard">
          <span>3</span>
          <strong>Contract pays provider</strong>
          <p>ShadowFloat verifies the intent onchain, pays the named provider from sponsor reserve, and opens debt against the line.</p>
        </article>
        <article className="builderFlowCard">
          <span>4</span>
          <strong>Repay when ready</strong>
          <p>Your agent can repay from its own wallet to close the spend, debt, and repayment loop.</p>
        </article>
      </section>
      <section className="builderReferenceGrid" aria-label="Builder references">
        <article className="builderReferenceCard">
          <span>line state lookup</span>
          <code>/api/float-tools?action=agent&amp;address=0x...</code>
          <p>Read the current line limit, available capacity, active debt, and status for a registered agent.</p>
        </article>
        <article className="builderReferenceCard">
          <span>typed-data intent</span>
          <code>/api/float-tools?action=intent&amp;agent=0x...&amp;reason=...</code>
          <p>Returns the exact EIP-712 payload a builder can sign with their own wallet tooling. No Shadow script or secret env is required.</p>
        </article>
        <article className="builderReferenceCard">
          <span>intent verifier</span>
          <code>/api/float-tools?action=verify&amp;hash=0x...</code>
          <p>Verify signer, request hash, onchain receipt, V2 direct provider payment, and nonce use.</p>
        </article>
        <article className="builderReferenceCard">
          <span>local scripts</span>
          <code>float-builder-sign.mjs · float-builder-repay.mjs</code>
          <p>Reference helpers for local signing and repayment. Builders can also construct calls with their own signer.</p>
        </article>
        <a
          className="builderReferenceCard"
          href="https://github.com/buildwithshadow/shadow/blob/main/docs/PILOT_RECRUITMENT.md"
          target="_blank"
          rel="noreferrer noopener"
        >
          <span>pilot handoff</span>
          <strong>Run three unassisted cycles</strong>
          <p>Participant roles, safe defaults, proof requirements, repeat-use target, and reserve-reclaim finish line.</p>
        </a>
      </section>
    </div>
  );
  const roadmapPage = <RoadmapPage />;
  return (
    <main className={isFundingDeskRoute ? "shell candidateShell" : "shell"}>
      <nav className="nav">
        <Link className="brand" to="/" aria-label="Shadow">
          <ShadowMark />
          <span>Shadow</span>
        </Link>
        <div className="navLinks">
          <Link to="/#how" className="navLink">
            How it works
          </Link>
          <NavLink to="/evidence" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Evidence
          </NavLink>
          <NavLink to="/builders" className={({ isActive }) => (isActive ? "navLink active" : "navLink")}>
            Builders
          </NavLink>
        </div>
        <div className="navActions">
          {!isFundingDeskRoute && <button
            className={account ? "navWallet connected" : "navWallet"}
            onClick={connectWallet}
            type="button"
            aria-label={account ? `Connected wallet ${account}` : "Connect wallet"}
          >
            <span className="navWalletDot" />
            {account ? shortAddress(account) : "Wallet"}
          </button>}
          <Link to={isGuardedMainnetRoute ? "/mainnet" : isGuardedTestnetRoute ? "/guarded-testnet" : "/start"} className="navCta">
            Fund an agent
          </Link>
        </div>
      </nav>

      <RouteScroll />

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/evidence" element={evidencePage} />
        <Route path="/agents" element={<EvidenceRedirect />} />
        <Route path="/follow" element={<Navigate to="/builders/v2" replace />} />
        <Route path="/receipts" element={<EvidenceRedirect />} />
        <Route path="/lepton" element={<EvidenceRedirect fallbackHash="#records" />} />
        <Route path="/treasury" element={<EvidenceRedirect fallbackHash="#records" />} />
        <Route path="/records" element={<EvidenceRedirect fallbackHash="#records" />} />
        <Route path="/float" element={<EvidenceRedirect />} />
        <Route path="/proof" element={<EvidenceRedirect />} />
        <Route path="/builders" element={buildersPage} />
        <Route path="/builders/v2" element={floatV2ToolsPage} />
        <Route path="/funding" element={<CandidateFundingDesk key="legacy-candidate" />} />
        {import.meta.env.VITE_SHADOW_GUARDED_MAINNET_CANDIDATE === "true" && <Route path="/mainnet" element={<CandidateFundingDesk key="guarded-mainnet" deployment={GUARDED_MAINNET} service={GUARDED_MAINNET_SERVICE} />} />}
        {import.meta.env.VITE_SHADOW_GUARDED_TESTNET_CANDIDATE === "true" && <Route path="/guarded-testnet" element={<CandidateFundingDesk key="guarded-testnet" deployment={GUARDED_TESTNET} service={GUARDED_TESTNET_SERVICE} />} />}
        <Route path="/start/*" element={<CandidateFundingDesk key="public-testnet" deployment={PUBLIC_TESTNET} service={PUBLIC_TEST_SERVICE} />} />
        <Route path="/roadmap" element={roadmapPage} />
        <Route path="/archive" element={<EvidenceRedirect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <SiteFooter />
    </main>
  );
}

function FloatBuilderPilot({
  account,
  state,
  loading,
  onAccountChange,
  onRefresh,
}: {
  account?: Address;
  state: FloatV2ActivityState | null;
  loading: boolean;
  onAccountChange: (account: Address) => void;
  onRefresh: () => Promise<void>;
}) {
  const [agentAddress, setAgentAddress] = useState("");
  const [providerAddress, setProviderAddress] = useState<string>(FLOAT_V2_DEFAULT_PROVIDER);
  const [endpointHash, setEndpointHash] = useState<string>(FLOAT_V2_DEFAULT_ENDPOINT_HASH);
  const [reserveAmount, setReserveAmount] = useState("0.05");
  const [maxPerRequest, setMaxPerRequest] = useState("0.01");
  const [dailyLimit, setDailyLimit] = useState("0.05");
  const [lineDays, setLineDays] = useState("7");
  const [providerDays, setProviderDays] = useState("7");
  const [mandateLabel, setMandateLabel] = useState("builder-pilot");
  const [sponsorPreflight, setSponsorPreflight] = useState<SponsorPreflight | null>(null);
  const [sponsorBusy, setSponsorBusy] = useState(false);
  const [sponsorStatus, setSponsorStatus] = useState<BuilderFlowStatus>({
    label: "Preflight required",
    detail: "Connect the sponsor wallet and check the line before approving USDC.",
  });
  const [closeRecipient, setCloseRecipient] = useState("");
  const [closeConfirmed, setCloseConfirmed] = useState(false);

  const [intentProvider, setIntentProvider] = useState<string>(FLOAT_V2_DEFAULT_PROVIDER);
  const [intentEndpointHash, setIntentEndpointHash] = useState<string>(FLOAT_V2_DEFAULT_ENDPOINT_HASH);
  const [intentAmount, setIntentAmount] = useState("0.01");
  const [intentMaxDebt, setIntentMaxDebt] = useState("");
  const [intentHours, setIntentHours] = useState("24");
  const [intentExecutor, setIntentExecutor] = useState("");
  const [intentReason, setIntentReason] = useState("My agent buys one approved provider response for its current task.");
  const [intentPacket, setIntentPacket] = useState<BuilderSignedIntentPacket | null>(null);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentStatus, setIntentStatus] = useState<BuilderFlowStatus>({
    label: "Agent signature required",
    detail: "Switch the connected wallet to the agent address before creating the intent.",
  });

  const [repayDebt, setRepayDebt] = useState<bigint | null>(null);
  const [repayBalance, setRepayBalance] = useState<bigint | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  const [repayBusy, setRepayBusy] = useState(false);
  const [repayStatus, setRepayStatus] = useState<BuilderFlowStatus>({
    label: "Debt not loaded",
    detail: "Connect the agent wallet to read and repay its current line debt.",
  });

  const returningAgents = state?.summary?.returningAgents;
  const returningSponsors = state?.summary?.returningSponsors;
  const metricValue = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const sponsorAction = sponsorPreflight ? sponsorPreflightAction(sponsorPreflight) : "open";

  function sponsorInputs() {
    const agent = parseBuilderAddress(agentAddress, "Agent");
    const provider = parseBuilderAddress(providerAddress, "Provider");
    const endpoint = parseBuilderBytes32(endpointHash, "Endpoint hash");
    const reserveUSDC = parseBuilderUSDC(reserveAmount, "Reserve");
    const maxPerRequestUSDC = parseBuilderUSDC(maxPerRequest, "Maximum per request");
    const dailyLimitUSDC = parseBuilderUSDC(dailyLimit, "Daily limit");
    if (maxPerRequestUSDC > reserveUSDC) throw new Error("Maximum per request cannot exceed the reserve.");
    if (dailyLimitUSDC > reserveUSDC) throw new Error("Daily limit cannot exceed the reserve.");
    if (maxPerRequestUSDC > dailyLimitUSDC) throw new Error("Maximum per request cannot exceed the daily limit.");
    const lineTtlDays = parseBuilderInteger(lineDays, "Line duration", 1, 30);
    const providerTtlDays = parseBuilderInteger(providerDays, "Provider duration", 1, lineTtlDays);
    if (mandateLabel.trim().length < 3) throw new Error("Mandate label must be at least three characters.");
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      agent,
      provider,
      endpointHash: endpoint,
      reserveUSDC,
      maxPerRequestUSDC,
      dailyLimitUSDC,
      lineExpiry: now + BigInt(lineTtlDays * 86_400),
      providerExpiry: now + BigInt(providerTtlDays * 86_400),
      mandateId: keccak256(stringToBytes(`shadow-float:pilot:${mandateLabel.trim()}:${agent}`)),
    };
  }

  async function inspectSponsor(config: ReturnType<typeof sponsorInputs>, sponsor: Address): Promise<SponsorPreflight> {
    const [lineSponsor, line, lineExpiry, providerMandate, balanceUSDC, allowanceUSDC, nativeBalance] = await Promise.all([
      publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineSponsors", args: [config.agent] }),
      publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [config.agent] }),
      publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineExpiries", args: [config.agent] }),
      publicClient.readContract({
        address: FLOAT_V2_CONTRACT,
        abi: floatV2Abi,
        functionName: "lineProviderMandates",
        args: [config.agent, config.provider],
      }),
      publicClient.readContract({ address: FLOAT_V2_USDC, abi: erc20Abi, functionName: "balanceOf", args: [sponsor] }),
      publicClient.readContract({ address: FLOAT_V2_USDC, abi: erc20Abi, functionName: "allowance", args: [sponsor, FLOAT_V2_CONTRACT] }),
      publicClient.getBalance({ address: sponsor }),
    ]);
    const sponsorLine = lineSponsor as FloatV2SponsorLineRead;
    const agentLine = line as FloatV2LineRead;
    const mandate = providerMandate as FloatV2ProviderMandateRead;
    return {
      agent: config.agent,
      sponsor,
      existingSponsor: getAddress(sponsorLine[0]),
      existingReserveUSDC: sponsorLine[1],
      lineWallet: getAddress(agentLine[0]),
      activeDebtUSDC: agentLine[4],
      lineExpiry: lineExpiry as bigint,
      providerExpiry: mandate[3],
      providerMandateActive: mandate[4],
      reserveUSDC: config.reserveUSDC,
      balanceUSDC: balanceUSDC as bigint,
      allowanceUSDC: allowanceUSDC as bigint,
      nativeBalance,
      checkedAt: Date.now(),
    };
  }

  function sponsorPreflightAction(preflight: SponsorPreflight): "open" | "refresh" | "renew" | "blocked" {
    const hasSponsor = preflight.existingSponsor !== ZERO_ADDRESS;
    const hasLine = preflight.lineWallet !== ZERO_ADDRESS;
    if (!hasSponsor && !hasLine) return "open";
    if (preflight.existingSponsor !== preflight.sponsor || preflight.lineWallet !== preflight.agent) return "blocked";
    const now = BigInt(Math.floor(Date.now() / 1000));
    return preflight.lineExpiry !== 0n && now > preflight.lineExpiry ? "renew" : "refresh";
  }

  function sponsorReadinessError(preflight: SponsorPreflight): string | null {
    const action = sponsorPreflightAction(preflight);
    if (action === "blocked") {
      return `Agent already has a line controlled by ${
        preflight.existingSponsor !== ZERO_ADDRESS ? `sponsor ${shortAddress(preflight.existingSponsor)}` : "a non-sponsored owner"
      }.`;
    }
    if (action === "renew" && preflight.activeDebtUSDC > 0n) {
      return `Expired line still has ${formatFloatUSDC(preflight.activeDebtUSDC)} USDC debt. Repay it before renewing.`;
    }
    if (action !== "refresh") {
      const usableBalance = preflight.balanceUSDC + (action === "renew" ? preflight.existingReserveUSDC : 0n);
      if (usableBalance < preflight.reserveUSDC) {
        return `Sponsor will have ${formatFloatUSDC(usableBalance)} USDC available; ${formatFloatUSDC(preflight.reserveUSDC)} USDC is required.`;
      }
    }
    if (preflight.nativeBalance === 0n) return "Sponsor wallet has no Arc testnet gas balance.";
    return null;
  }

  async function runSponsorPreflight() {
    setSponsorBusy(true);
    setSponsorStatus({ label: "Checking sponsor setup" });
    try {
      const config = sponsorInputs();
      const { account: sponsor } = await connectBuilderWallet(onAccountChange);
      const preflight = await inspectSponsor(config, sponsor);
      setSponsorPreflight(preflight);
      const blocked = sponsorReadinessError(preflight);
      if (blocked) throw new Error(blocked);
      const action = sponsorPreflightAction(preflight);
      if (action === "refresh") {
        setSponsorStatus({
          label: "Ready to refresh",
          detail: `The existing ${formatFloatUSDC(preflight.existingReserveUSDC)} USDC reserve stays in place; only the provider mandate changes.`,
        });
        return;
      }
      const actionLabel = action === "renew" ? "renew" : "open";
      setSponsorStatus({
        label: preflight.allowanceUSDC >= config.reserveUSDC ? `Ready to ${actionLabel}` : "Approval required",
        detail:
          preflight.allowanceUSDC >= config.reserveUSDC
            ? action === "renew"
              ? "Renewal will reclaim the expired reserve, then reopen the line with fresh expiries."
              : "Reserve allowance and wallet balances are sufficient."
            : `Approve ${formatFloatUSDC(config.reserveUSDC)} USDC to ShadowFloat before ${actionLabel}ing the line.`,
      });
    } catch (error) {
      setSponsorStatus({ label: "Preflight blocked", error: errorMessage(error) });
    } finally {
      setSponsorBusy(false);
    }
  }

  async function approveSponsorReserve() {
    setSponsorBusy(true);
    setSponsorStatus({ label: "Checking reserve approval" });
    try {
      const config = sponsorInputs();
      const { account: sponsor, wallet } = await connectBuilderWallet(onAccountChange);
      const preflight = await inspectSponsor(config, sponsor);
      setSponsorPreflight(preflight);
      const blocked = sponsorReadinessError(preflight);
      if (blocked) throw new Error(blocked);
      const action = sponsorPreflightAction(preflight);
      if (action === "refresh") {
        setSponsorStatus({ label: "No approval needed", detail: "Refreshing a provider mandate does not move or add reserve USDC." });
        return;
      }
      if (preflight.allowanceUSDC >= config.reserveUSDC) {
        setSponsorStatus({ label: "Already approved", detail: "Current allowance covers the requested reserve." });
        return;
      }
      const hash = await wallet.writeContract({
        account: sponsor,
        address: FLOAT_V2_USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [FLOAT_V2_CONTRACT, config.reserveUSDC],
        chain: arcTestnet,
      });
      await waitForBuilderTransaction(hash, "Reserve approval");
      setSponsorPreflight({ ...preflight, allowanceUSDC: config.reserveUSDC, checkedAt: Date.now() });
      setSponsorStatus({
        label: "Reserve approved",
        detail:
          action === "renew"
            ? "The next action reclaims the expired reserve, then reopens the line with fresh bounds."
            : "The next transaction opens the line and transfers the bounded reserve into ShadowFloat.",
        txs: [{ label: "approval", hash }],
      });
    } catch (error) {
      setSponsorStatus({ label: "Approval failed", error: errorMessage(error) });
    } finally {
      setSponsorBusy(false);
    }
  }

  async function openOrRefreshSponsorLine() {
    setSponsorBusy(true);
    setSponsorStatus({ label: "Rechecking sponsored line" });
    try {
      const config = sponsorInputs();
      const { account: sponsor, wallet } = await connectBuilderWallet(onAccountChange);
      const preflight = await inspectSponsor(config, sponsor);
      setSponsorPreflight(preflight);
      const blocked = sponsorReadinessError(preflight);
      if (blocked) throw new Error(blocked);
      const action = sponsorPreflightAction(preflight);
      if (action === "refresh") {
        const hash = await wallet.writeContract({
          account: sponsor,
          address: FLOAT_V2_CONTRACT,
          abi: floatV2Abi,
          functionName: "setSponsoredProviderMandate",
          args: [
            config.agent,
            config.provider,
            config.endpointHash,
            config.maxPerRequestUSDC,
            config.dailyLimitUSDC,
            config.providerExpiry,
            true,
          ],
          chain: arcTestnet,
        });
        await waitForBuilderTransaction(hash, "Provider mandate refresh");
        setSponsorStatus({
          label: "Provider mandate refreshed",
          detail: "The existing sponsor reserve is unchanged and the provider bounds have a fresh expiry.",
          txs: [{ label: "refresh mandate", hash }],
        });
        await onRefresh();
        return;
      }
      if (preflight.allowanceUSDC < config.reserveUSDC) {
        throw new Error(`Approve the reserve before ${action === "renew" ? "renewing" : "opening"} the line.`);
      }
      const txs: { label: string; hash: Hash }[] = [];
      if (action === "renew") {
        const requestHash = keccak256(
          stringToBytes(
            JSON.stringify({
              v: 1,
              domain: "shadow-float:builder-renew",
              sponsor,
              agent: config.agent,
              nonce: createBuilderNonce(),
            }),
          ),
        );
        const closeHash = await wallet.writeContract({
          account: sponsor,
          address: FLOAT_V2_CONTRACT,
          abi: floatV2Abi,
          functionName: "closeSponsoredLine",
          args: [config.agent, sponsor, requestHash],
          chain: arcTestnet,
        });
        await waitForBuilderTransaction(closeHash, "Expired line reclaim");
        txs.push({ label: "reclaim expired line", hash: closeHash });
      }
      const hash = await wallet.writeContract({
        account: sponsor,
        address: FLOAT_V2_CONTRACT,
        abi: floatV2Abi,
        functionName: "openSponsoredLine",
        args: [
          config.agent,
          config.reserveUSDC,
          config.mandateId,
          config.lineExpiry,
          config.provider,
          config.endpointHash,
          config.maxPerRequestUSDC,
          config.dailyLimitUSDC,
          config.providerExpiry,
        ],
        chain: arcTestnet,
      });
      await waitForBuilderTransaction(hash, action === "renew" ? "Sponsored line renewal" : "Sponsored line opening");
      txs.push({ label: action === "renew" ? "reopen line" : "open line", hash });
      setSponsorStatus({
        label: action === "renew" ? "Sponsored line renewed" : "Sponsored line opened",
        detail: `${formatFloatUSDC(config.reserveUSDC)} USDC is reserved for ${shortAddress(config.agent)} under fresh provider bounds.`,
        txs,
      });
      await onRefresh();
    } catch (error) {
      setSponsorStatus({ label: "Line opening failed", error: errorMessage(error) });
    } finally {
      setSponsorBusy(false);
    }
  }

  async function closeSponsorLine() {
    setSponsorBusy(true);
    setSponsorStatus({ label: "Rechecking reserve reclaim" });
    try {
      if (!closeConfirmed) throw new Error("Confirm that closing immediately revokes the line.");
      const agent = parseBuilderAddress(agentAddress, "Agent");
      const { account: sponsor, wallet } = await connectBuilderWallet(onAccountChange);
      const recipient = closeRecipient.trim()
        ? parseBuilderAddress(closeRecipient, "Reserve recipient")
        : sponsor;
      const [lineSponsor, line] = await Promise.all([
        publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lineSponsors", args: [agent] }),
        publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [agent] }),
      ]);
      const currentSponsor = lineSponsor as FloatV2SponsorLineRead;
      const currentLine = line as FloatV2LineRead;
      if (getAddress(currentSponsor[0]) !== sponsor) {
        throw new Error(`Connected wallet is not this line's sponsor (${shortAddress(currentSponsor[0])}).`);
      }
      if (currentSponsor[1] === 0n) throw new Error("This line has no sponsor reserve to reclaim.");
      if (currentLine[4] !== 0n) {
        throw new Error(`${formatFloatUSDC(currentLine[4])} USDC debt remains. The contract will not release the reserve.`);
      }
      const requestHash = keccak256(
        stringToBytes(
          JSON.stringify({
            v: 1,
            domain: "shadow-float:builder-close",
            sponsor,
            agent,
            recipient,
            nonce: createBuilderNonce(),
          }),
        ),
      );
      const hash = await wallet.writeContract({
        account: sponsor,
        address: FLOAT_V2_CONTRACT,
        abi: floatV2Abi,
        functionName: "closeSponsoredLine",
        args: [agent, recipient, requestHash],
        chain: arcTestnet,
      });
      await waitForBuilderTransaction(hash, "Sponsored reserve reclaim");
      setSponsorPreflight(null);
      setCloseConfirmed(false);
      setSponsorStatus({
        label: "Reserve reclaimed",
        detail: `The line is revoked and its remaining reserve was sent to ${shortAddress(recipient)}.`,
        txs: [{ label: "close and reclaim", hash }],
      });
      await onRefresh();
    } catch (error) {
      setSponsorStatus({ label: "Reserve reclaim blocked", error: errorMessage(error) });
    } finally {
      setSponsorBusy(false);
    }
  }

  async function createAndSignIntent() {
    setIntentBusy(true);
    setIntentStatus({ label: "Building typed data" });
    try {
      const provider = parseBuilderAddress(intentProvider, "Provider");
      const endpoint = parseBuilderBytes32(intentEndpointHash, "Endpoint hash");
      const amountUSDC = parseBuilderUSDC(intentAmount, "Spend amount");
      const ttlHours = parseBuilderInteger(intentHours, "Intent lifetime", 1, 168);
      const reason = intentReason.trim();
      if (reason.length < 12) throw new Error("Give the agent a truthful reason of at least 12 characters.");
      const { account: agent, wallet } = await connectBuilderWallet(onAccountChange);
      const params = new URLSearchParams({
        action: "intent",
        agent,
        provider,
        endpointHash: endpoint,
        amountUSDC: amountUSDC.toString(),
        nonce: createBuilderNonce(),
        ttl: String(ttlHours * 3_600),
        reason,
      });
      if (intentMaxDebt.trim()) params.set("maxDebtUSDC", parseBuilderUSDC(intentMaxDebt, "Maximum debt").toString());
      if (intentExecutor.trim()) params.set("executor", parseBuilderAddress(intentExecutor, "Executor"));
      const response = await fetch(`/api/float-tools?${params.toString()}`);
      const packet = (await response.json()) as BuilderSignedIntentPacket & { error?: string };
      if (!response.ok || packet.error) throw new Error(packet.error || `Intent request failed with ${response.status}.`);
      if (getAddress(packet.intent.agent) !== agent) throw new Error("Intent API returned a different agent address.");
      if (getAddress(packet.intent.float) !== FLOAT_V2_CONTRACT || packet.intent.chainId !== arcTestnet.id) {
        throw new Error("Intent API returned the wrong contract or chain.");
      }
      if (packet.digest.toLowerCase() !== packet.requestHash.toLowerCase()) throw new Error("Intent digest and request hash differ.");
      const message = {
        agent: getAddress(packet.typedData.message.agent),
        provider: getAddress(packet.typedData.message.provider),
        endpointHash: parseBuilderBytes32(packet.typedData.message.endpointHash, "Signed endpoint hash"),
        amountUSDC: BigInt(packet.typedData.message.amountUSDC),
        maxDebtUSDC: BigInt(packet.typedData.message.maxDebtUSDC),
        nonce: BigInt(packet.typedData.message.nonce),
        expiry: BigInt(packet.typedData.message.expiry),
        executor: getAddress(packet.typedData.message.executor),
        reason: packet.typedData.message.reason,
      };
      const localDigest = hashTypedData({
        domain: packet.typedData.domain,
        types: FLOAT_SPEND_INTENT_TYPES,
        primaryType: "FloatSpendIntent",
        message,
      });
      if (localDigest.toLowerCase() !== packet.digest.toLowerCase()) {
        throw new Error("Intent API digest does not match the locally reconstructed EIP-712 payload.");
      }
      const signature = await wallet.signTypedData({
        account: agent,
        domain: packet.typedData.domain,
        types: FLOAT_SPEND_INTENT_TYPES,
        primaryType: "FloatSpendIntent",
        message,
      });
      setIntentPacket({ ...packet, signature });
      setIntentStatus({
        label: "Intent signed locally",
        detail: "No transaction or provider payment has happened yet. Submit the signed packet in the next step.",
      });
    } catch (error) {
      setIntentPacket(null);
      setIntentStatus({ label: "Intent signing failed", error: errorMessage(error) });
    } finally {
      setIntentBusy(false);
    }
  }

  async function submitSignedIntent() {
    if (!intentPacket?.signature) {
      setIntentStatus({ label: "Submission blocked", error: "Create and sign an intent first." });
      return;
    }
    setIntentBusy(true);
    setIntentStatus({ label: "Submitting signed intent" });
    try {
      const { account: executor, wallet } = await connectBuilderWallet(onAccountChange);
      const intent = intentPacket.intent;
      if (getAddress(intent.executor) !== ZERO_ADDRESS && getAddress(intent.executor) !== executor) {
        throw new Error(`This intent is restricted to executor ${intent.executor}.`);
      }
      const hash = await wallet.writeContract({
        account: executor,
        address: FLOAT_V2_CONTRACT,
        abi: floatV2Abi,
        functionName: "requestSignedSpend",
        args: [
          {
            agent: getAddress(intent.agent),
            provider: getAddress(intent.provider),
            endpointHash: parseBuilderBytes32(intent.endpointHash, "Endpoint hash"),
            amountUSDC: BigInt(intent.amountUSDC),
            maxDebtUSDC: BigInt(intent.maxDebtUSDC),
            nonce: BigInt(intent.nonce),
            expiry: BigInt(intent.expiry),
            executor: getAddress(intent.executor),
            reason: intent.reason,
          },
          intentPacket.signature as Hex,
        ],
        chain: arcTestnet,
      });
      await waitForBuilderTransaction(hash, "Signed spend submission");
      setIntentStatus({
        label: "Signed intent confirmed",
        detail: "The V2 receipt records whether policy allowed payment or blocked it before funds moved.",
        txs: [{ label: "signed spend", hash }],
      });
      await onRefresh();
    } catch (error) {
      setIntentStatus({ label: "Intent submission failed", error: errorMessage(error) });
    } finally {
      setIntentBusy(false);
    }
  }

  async function copyIntentPacket() {
    if (!intentPacket) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(intentPacket, null, 2));
      setIntentStatus({ label: "Signed packet copied", detail: "A relayer can submit this packet without receiving the agent key." });
    } catch (error) {
      setIntentStatus({ label: "Copy failed", error: errorMessage(error) });
    }
  }

  async function loadAgentDebt() {
    setRepayBusy(true);
    setRepayStatus({ label: "Reading agent debt" });
    try {
      const { account: agent } = await connectBuilderWallet(onAccountChange);
      const [line, balance] = await Promise.all([
        publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [agent] }),
        publicClient.readContract({ address: FLOAT_V2_USDC, abi: erc20Abi, functionName: "balanceOf", args: [agent] }),
      ]);
      const currentLine = line as FloatV2LineRead;
      if (getAddress(currentLine[0]) !== agent) throw new Error("Connected wallet is not the wallet assigned to this Float line.");
      const debt = currentLine[4];
      setRepayDebt(debt);
      setRepayBalance(balance as bigint);
      setRepayAmount(debt > 0n ? formatFloatUSDC(debt) : "");
      setRepayStatus({
        label: debt > 0n ? "Debt loaded" : "No active debt",
        detail: debt > 0n ? `${formatFloatUSDC(debt)} USDC is open; wallet balance is ${formatFloatUSDC(balance as bigint)} USDC.` : "This line has no debt to repay.",
      });
    } catch (error) {
      setRepayStatus({ label: "Debt read failed", error: errorMessage(error) });
    } finally {
      setRepayBusy(false);
    }
  }

  async function repayAgentDebt() {
    setRepayBusy(true);
    setRepayStatus({ label: "Rechecking repayment" });
    try {
      const amountUSDC = parseBuilderUSDC(repayAmount, "Repayment amount");
      const { account: agent, wallet } = await connectBuilderWallet(onAccountChange);
      const [line, balance, allowance] = await Promise.all([
        publicClient.readContract({ address: FLOAT_V2_CONTRACT, abi: floatV2Abi, functionName: "lines", args: [agent] }),
        publicClient.readContract({ address: FLOAT_V2_USDC, abi: erc20Abi, functionName: "balanceOf", args: [agent] }),
        publicClient.readContract({ address: FLOAT_V2_USDC, abi: erc20Abi, functionName: "allowance", args: [agent, FLOAT_V2_CONTRACT] }),
      ]);
      const currentLine = line as FloatV2LineRead;
      const debt = currentLine[4];
      if (getAddress(currentLine[0]) !== agent) throw new Error("Connected wallet is not the wallet assigned to this Float line.");
      if (debt === 0n) throw new Error("This line has no active debt.");
      if (amountUSDC > debt) throw new Error(`Repayment cannot exceed the ${formatFloatUSDC(debt)} USDC debt.`);
      if ((balance as bigint) < amountUSDC) throw new Error(`Agent wallet needs ${formatFloatUSDC(amountUSDC)} USDC to repay.`);
      const txs: { label: string; hash: Hash }[] = [];
      if ((allowance as bigint) < amountUSDC) {
        const approvalHash = await wallet.writeContract({
          account: agent,
          address: FLOAT_V2_USDC,
          abi: erc20Abi,
          functionName: "approve",
          args: [FLOAT_V2_CONTRACT, amountUSDC],
          chain: arcTestnet,
        });
        await waitForBuilderTransaction(approvalHash, "Repayment approval");
        txs.push({ label: "repay approval", hash: approvalHash });
      }
      const requestHash = keccak256(
        stringToBytes(
          JSON.stringify({
            v: 1,
            domain: "shadow-float:builder-repay",
            agent,
            amountUSDC: amountUSDC.toString(),
            nonce: createBuilderNonce(),
          }),
        ),
      );
      const repayHash = await wallet.writeContract({
        account: agent,
        address: FLOAT_V2_CONTRACT,
        abi: floatV2Abi,
        functionName: "repay",
        args: [agent, amountUSDC, requestHash],
        chain: arcTestnet,
      });
      await waitForBuilderTransaction(repayHash, "Float repayment");
      txs.push({ label: "repayment", hash: repayHash });
      setRepayDebt(debt - amountUSDC);
      setRepayBalance((balance as bigint) - amountUSDC);
      setRepayAmount("");
      setRepayStatus({
        label: debt === amountUSDC ? "Debt cleared" : "Partial repayment confirmed",
        detail: debt === amountUSDC ? "Capacity is restored and the lifecycle is closed." : `${formatFloatUSDC(debt - amountUSDC)} USDC debt remains.`,
        txs,
      });
      await onRefresh();
    } catch (error) {
      setRepayStatus({ label: "Repayment failed", error: errorMessage(error) });
    } finally {
      setRepayBusy(false);
    }
  }

  return (
    <section className="builderPilot" id="self-serve-float" aria-label="Self-serve Shadow Float pilot">
      <div className="builderPilotHeader">
        <div>
          <p className="pageEyebrow">self-serve pilot · Arc testnet</p>
          <h2>Open, use, and repay a real sponsor-backed line.</h2>
          <p>Every write targets the deployed V2 contract. Wallet prompts stay explicit, and no agent or sponsor key is collected by Shadow.</p>
        </div>
        <div className="builderWalletState">
          <span>connected wallet</span>
          <strong>{account ? shortAddress(account) : "not connected"}</strong>
          <small>Switch accounts between the sponsor and agent stages.</small>
        </div>
      </div>

      <div className="builderPilotMetrics" aria-label="Chain-derived pilot metrics">
        <FloatFact label="reserve-backed external lines" value={metricValue(state?.summary?.trackedExternalAgentLines)} />
        <FloatFact label="external-sponsor reserve lines" value={metricValue(state?.summary?.externallySponsoredLines)} />
        <FloatFact label="operator-sponsored lines" value={metricValue(state?.summary?.operatorSponsoredLines)} />
        <FloatFact label="historical returning agents" value={metricValue(returningAgents)} />
        <FloatFact label="returning external sponsors" value={metricValue(returningSponsors)} />
      </div>

      <div className="builderPilotGrid">
        <article
          className="builderWorkbench builderWorkbenchSponsor"
          aria-busy={sponsorBusy}
          aria-describedby="sponsor-flow-status"
        >
          <header>
            <span>01 · sponsor</span>
            <h3>Open, refresh, or renew the line</h3>
            <p>Preflight reads ownership, expiry, debt, balance, and allowance before any transaction.</p>
          </header>
          <div className="builderFieldGrid">
            <label className="builderField builderFieldWide">
              <span>Agent address</span>
              <input value={agentAddress} onChange={(event) => setAgentAddress(event.target.value)} placeholder="0x agent wallet" spellCheck={false} />
            </label>
            <label className="builderField builderFieldWide">
              <span>Provider address</span>
              <input value={providerAddress} onChange={(event) => setProviderAddress(event.target.value)} spellCheck={false} />
            </label>
            <label className="builderField builderFieldWide">
              <span>Endpoint hash</span>
              <input value={endpointHash} onChange={(event) => setEndpointHash(event.target.value)} spellCheck={false} />
            </label>
            <label className="builderField">
              <span>Reserve USDC</span>
              <input inputMode="decimal" value={reserveAmount} onChange={(event) => setReserveAmount(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Max / request</span>
              <input inputMode="decimal" value={maxPerRequest} onChange={(event) => setMaxPerRequest(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Daily limit</span>
              <input inputMode="decimal" value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Line days</span>
              <input inputMode="numeric" value={lineDays} onChange={(event) => setLineDays(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Provider days</span>
              <input inputMode="numeric" value={providerDays} onChange={(event) => setProviderDays(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Mandate label</span>
              <input value={mandateLabel} onChange={(event) => setMandateLabel(event.target.value)} />
            </label>
          </div>
          {sponsorPreflight && (
            <div className="builderReadout">
              <span>action {sponsorAction}</span>
              <span>balance {formatFloatUSDC(sponsorPreflight.balanceUSDC)} USDC</span>
              <span>allowance {formatFloatUSDC(sponsorPreflight.allowanceUSDC)} USDC</span>
              {sponsorPreflight.existingSponsor !== ZERO_ADDRESS && (
                <span>held reserve {formatFloatUSDC(sponsorPreflight.existingReserveUSDC)} USDC</span>
              )}
              <span>checked {new Date(sponsorPreflight.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          )}
          <div className="builderActionRow">
            <button type="button" onClick={runSponsorPreflight} disabled={sponsorBusy}>1. Preflight</button>
            <button type="button" onClick={approveSponsorReserve} disabled={sponsorBusy}>2. Approve reserve</button>
            <button type="button" className="primary" onClick={openOrRefreshSponsorLine} disabled={sponsorBusy}>
              3. {sponsorAction === "refresh" ? "Refresh mandate" : sponsorAction === "renew" ? "Renew line" : "Open line"}
            </button>
          </div>
          <div className="builderCloseControl">
            <div>
              <strong>Close a debt-free line</strong>
              <span>Optional. This revokes capacity immediately and returns the full remaining reserve.</span>
            </div>
            <label className="builderField">
              <span>Reserve recipient, optional</span>
              <input
                value={closeRecipient}
                onChange={(event) => setCloseRecipient(event.target.value)}
                placeholder="defaults to sponsor wallet"
                spellCheck={false}
              />
            </label>
            <label className="builderConfirm">
              <input
                type="checkbox"
                checked={closeConfirmed}
                onChange={(event) => setCloseConfirmed(event.target.checked)}
              />
              <span>I understand this closes the line now and cannot run while debt is open.</span>
            </label>
            <button type="button" className="danger" onClick={closeSponsorLine} disabled={sponsorBusy || !closeConfirmed}>
              Close and reclaim reserve
            </button>
          </div>
          <BuilderStatus id="sponsor-flow-status" status={sponsorStatus} />
        </article>

        <article className="builderWorkbench" aria-busy={intentBusy} aria-describedby="intent-flow-status">
          <header>
            <span>02 · agent</span>
            <h3>Sign and submit a bounded spend</h3>
            <p>The connected agent signs EIP-712 typed data. The private key stays inside its wallet.</p>
          </header>
          <div className="builderFieldGrid">
            <label className="builderField builderFieldWide">
              <span>Provider address</span>
              <input value={intentProvider} onChange={(event) => setIntentProvider(event.target.value)} spellCheck={false} />
            </label>
            <label className="builderField builderFieldWide">
              <span>Endpoint hash</span>
              <input value={intentEndpointHash} onChange={(event) => setIntentEndpointHash(event.target.value)} spellCheck={false} />
            </label>
            <label className="builderField">
              <span>Spend USDC</span>
              <input inputMode="decimal" value={intentAmount} onChange={(event) => setIntentAmount(event.target.value)} />
            </label>
            <label className="builderField">
              <span>Max debt USDC</span>
              <input inputMode="decimal" value={intentMaxDebt} onChange={(event) => setIntentMaxDebt(event.target.value)} placeholder="auto" />
            </label>
            <label className="builderField">
              <span>Lifetime hours</span>
              <input inputMode="numeric" value={intentHours} onChange={(event) => setIntentHours(event.target.value)} />
            </label>
            <label className="builderField builderFieldWide">
              <span>Executor, optional</span>
              <input value={intentExecutor} onChange={(event) => setIntentExecutor(event.target.value)} placeholder="open to any relayer" spellCheck={false} />
            </label>
            <label className="builderField builderFieldWide">
              <span>Truthful reason</span>
              <textarea value={intentReason} onChange={(event) => setIntentReason(event.target.value)} rows={3} />
            </label>
          </div>
          {intentPacket && (
            <div className="builderIntentReceipt">
              <span>signed request hash</span>
              <code>{intentPacket.requestHash}</code>
              <small>expires {new Date(Number(intentPacket.intent.expiry) * 1000).toLocaleString()}</small>
            </div>
          )}
          <div className="builderActionRow">
            <button type="button" onClick={createAndSignIntent} disabled={intentBusy}>1. Create + sign</button>
            <button type="button" onClick={copyIntentPacket} disabled={!intentPacket || intentBusy}>Copy packet</button>
            <button type="button" className="primary" onClick={submitSignedIntent} disabled={!intentPacket || intentBusy}>2. Submit V2 spend</button>
          </div>
          <BuilderStatus id="intent-flow-status" status={intentStatus} />
        </article>

        <article
          className="builderWorkbench builderWorkbenchRepay"
          aria-busy={repayBusy}
          aria-describedby="repay-flow-status"
        >
          <header>
            <span>03 · repay</span>
            <h3>Restore the agent line</h3>
            <p>Use the agent wallet holding repayment USDC. The flow approves only the requested amount, then records repayment on V2.</p>
          </header>
          <div className="builderRepaySnapshot">
            <FloatFact label="active debt" value={repayDebt === null ? "not loaded" : `${formatFloatUSDC(repayDebt)} USDC`} />
            <FloatFact label="agent balance" value={repayBalance === null ? "not loaded" : `${formatFloatUSDC(repayBalance)} USDC`} />
          </div>
          <label className="builderField">
            <span>Repay USDC</span>
            <input inputMode="decimal" value={repayAmount} onChange={(event) => setRepayAmount(event.target.value)} placeholder="load full debt" />
          </label>
          <div className="builderActionRow">
            <button type="button" onClick={loadAgentDebt} disabled={repayBusy}>1. Load debt</button>
            <button type="button" className="primary" onClick={repayAgentDebt} disabled={repayBusy || !repayAmount}>2. Approve + repay</button>
          </div>
          <BuilderStatus id="repay-flow-status" status={repayStatus} />
        </article>
      </div>
    </section>
  );
}

function FloatPilotOperations({
  state,
  loading,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
}) {
  const operations = state?.operations;
  const status = operations?.status || (loading ? "loading" : "unavailable");
  const formatAtomic = (value?: string) => (value === undefined ? "unavailable" : `${formatFloatUSDC(value)} USDC`);

  return (
    <section className={`pilotOperations pilotOperations-${status}`} aria-label="Shadow Float pilot operations">
      <div className="pilotOperationsHead">
        <div>
          <p className="pageEyebrow">pilot operations · chain-derived</p>
          <h2>Exposure stays visible before the next transaction.</h2>
          <p>
            This monitor is read-only. A checkpoint fallback is evidence, not fresh authorization; every wallet action still
            re-reads the deployed contract before it prompts for a signature. Reserve health includes Shadow-controlled system
            lines; external traction metrics exclude them.
          </p>
        </div>
        <div className="pilotOperationsVerdict">
          <span>current posture</span>
          <strong>{status}</strong>
          <small>{operations?.source || "waiting for chain state"}</small>
        </div>
      </div>
      <div className="pilotOperationsMetrics">
        <FloatFact label="treasury custody" value={formatAtomic(operations?.reserve.treasuryBalanceUSDC)} />
        <FloatFact label="sponsor reserve · contract" value={formatAtomic(operations?.reserve.sponsoredReserveUSDC)} />
        <FloatFact label="sponsor reserve · tracked" value={formatAtomic(operations?.reserve.observedSponsoredReserveUSDC)} />
        <FloatFact label="tracked reserve deployed" value={formatAtomic(operations?.reserve.sponsoredDebtDeployedUSDC)} />
        <FloatFact label="tracked custody floor" value={formatAtomic(operations?.reserve.custodialReserveFloorUSDC)} />
        <FloatFact label="tracked custody surplus" value={formatAtomic(operations?.reserve.surplusUSDC)} />
        <FloatFact label="open debt lines" value={operations ? String(operations.counts.openDebt) : "unavailable"} />
        <FloatFact label="reclaimable reserves" value={operations ? String(operations.counts.reclaimable) : "unavailable"} />
      </div>
      <div className="pilotOperationsAlerts" aria-live="polite">
        {!operations ? (
          <article className="pilotOperationAlert pending">
            <span>pending</span>
            <strong>Operational state not loaded</strong>
            <p>Wait for a live RPC result or an explicitly labeled verified checkpoint before interpreting the pilot posture.</p>
          </article>
        ) : operations.alerts.length ? operations.alerts.map((alert) => (
          <article key={alert.code} className={`pilotOperationAlert ${alert.severity}`}>
            <span>{alert.severity}</span>
            <strong>{alert.title}</strong>
            <p>{alert.detail}</p>
            {alert.agents.length > 0 && (
              <small>{alert.agents.map((agent) => `${agent.label} ${shortAddress(agent.agent)}`).join(" · ")}</small>
            )}
          </article>
        )) : (
          <article className="pilotOperationAlert clear">
            <span>clear</span>
            <strong>No operational exception detected</strong>
            <p>Contract-wide reserve scope is reconciled, custody covers the resulting floor, and no tracked line is expired with debt or defaulted.</p>
          </article>
        )}
      </div>
      <a className="pilotOperationsRunbook" href="https://github.com/buildwithshadow/shadow/blob/main/docs/PILOT_OPERATIONS.md" target="_blank" rel="noreferrer noopener">
        Open the reconcile-first incident runbook
      </a>
    </section>
  );
}

function BuilderStatus({ id, status }: { id: string; status: BuilderFlowStatus }) {
  return (
    <div id={id} className={`builderStatus${status.error ? " error" : ""}`} role="status" aria-live="polite">
      <strong>{status.label}</strong>
      {status.detail && <span>{status.detail}</span>}
      {status.txs?.length ? (
        <div>
          {status.txs.map((tx) => (
            <a key={`${tx.label}-${tx.hash}`} href={txUrl(tx.hash)} target="_blank" rel="noreferrer noopener">
              {tx.label} · {shortAddress(tx.hash)}
            </a>
          ))}
        </div>
      ) : null}
      {status.error && <span>{status.error}</span>}
    </div>
  );
}

async function connectBuilderWallet(onAccountChange: (account: Address) => void) {
  const ethereum = window.ethereum;
  if (!ethereum) throw new Error("Install a browser wallet to use the self-serve flow.");
  const accounts = (await ethereum.request({ method: "eth_requestAccounts" })) as Address[];
  if (!accounts[0] || !isAddress(accounts[0])) throw new Error("The wallet did not return a valid account.");
  await switchToArc();
  const account = getAddress(accounts[0]);
  onAccountChange(account);
  return {
    account,
    wallet: createWalletClient({ account, chain: arcTestnet, transport: custom(ethereum) }),
  };
}

function parseBuilderAddress(value: string, label: string): Address {
  if (!isAddress(value.trim())) throw new Error(`${label} must be a valid address.`);
  const address = getAddress(value.trim());
  if (address === ZERO_ADDRESS) throw new Error(`${label} cannot be the zero address.`);
  return address;
}

function parseBuilderBytes32(value: string, label: string): Hex {
  const normalized = value.trim();
  if (!BYTES32_PATTERN.test(normalized)) throw new Error(`${label} must be a 32-byte hex value.`);
  return normalized as Hex;
}

function parseBuilderUSDC(value: string, label: string): bigint {
  let amount: bigint;
  try {
    amount = parseUnits(value.trim(), 6);
  } catch {
    throw new Error(`${label} must be a valid USDC amount with at most six decimals.`);
  }
  if (amount <= 0n) throw new Error(`${label} must be greater than zero.`);
  return amount;
}

function parseBuilderInteger(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function createBuilderNonce(): string {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return (BigInt(Date.now()) * 2n ** 64n + (BigInt(random[0]) << 32n) + BigInt(random[1])).toString();
}

async function waitForBuilderTransaction(hash: Hash, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted: ${hash}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function RouteScroll() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ block: "start" });
        else window.scrollTo({ top: 0, behavior: "auto" });
      });
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [pathname, hash, key]);
  return null;
}

function TreasuryHero({ treasuryState }: {
  treasuryState: TreasuryState | null;
}) {
  const currentV4WriteReady = treasuryState?.currentV4?.writeReady;
  const currentV4Action =
    currentV4WriteReady === undefined ? "not verified" : currentV4WriteReady ? "write-ready" : "inactive";
  const railStats = [
    { label: "V2 provider paid", value: "0.01 USDC", tone: "allow" },
    { label: "vault allocated", value: `${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`, tone: "allow" },
    { label: "blocked attempt", value: `${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`, tone: "block" },
    { label: "external V2 lifecycle", value: "Crux repaid", tone: "neutral" },
  ];
  const verifierLabel = treasuryState
    ? treasuryState.ok
      ? `${treasuryState.checks?.filter((check) => check.ok).length || 0}/${treasuryState.checks?.length || 0} record checks`
      : "record verifier red"
    : "record verifier ready";

  return (
    <section className="treasuryHero" aria-label="Shadow supporting records overview">
      <div className="treasuryHeroCopy">
        <p className="eyebrow">supporting records</p>
        <h2>Mandate checks and settlement records sit behind the Float product.</h2>
        <p>
          This page keeps the supporting records visible without making them the main story: approved-adapter checks,
          settlement records, and over-limit blocks that complement Float V2.
        </p>
        <div className="treasuryHeroActions">
          <Link className="treasuryHeroPrimary" to="/evidence#float">
            View Float activity
          </Link>
          <a className="treasuryHeroSecondary" href={FLOAT_V2_PROOF.sourcify} target="_blank" rel="noreferrer">
            View V2 source
          </a>
        </div>
        <div className="treasuryHeroBoundary" aria-label="Verified receipt scope">
          <span>External Float usage live</span>
          <span>mandate adapter record</span>
          <span>current V4 wallet action {currentV4Action}</span>
          <span>{verifierLabel}</span>
        </div>
      </div>

      <aside className="treasuryFlow" aria-label="Shadow supporting records flow">
        <div className="treasuryFlowHeader">
          <span>execution wallet</span>
          <code>{shortAddress(TREASURY_PROOF.operator)}</code>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>Float path</span>
          <strong>Provider paid</strong>
          <a href={txUrl(FLOAT_V2_PROOF.directSpendTx)} target="_blank" rel="noreferrer">
            {shortAddress(FLOAT_V2_PROOF.directSpendTx)}
          </a>
        </div>
        <div className="treasuryFlowBranch allow">
          <span>mandate path</span>
          <strong>Allocates to vault</strong>
          <a href={txUrl(TREASURY_PROOF.txs.allocation)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.allocation)}
          </a>
        </div>
        <div className="treasuryFlowBranch block">
          <span>policy guard</span>
          <strong>Blocks overreach</strong>
          <a href={txUrl(TREASURY_PROOF.txs.blocked)} target="_blank" rel="noreferrer">
            {shortAddress(TREASURY_PROOF.txs.blocked)}
          </a>
        </div>
        <div className="treasuryFlowFooter">
          <span>V2 live verifier</span>
          <code>npm run float:v2-verify-live</code>
        </div>
      </aside>

      <div className="treasuryHeroStats" aria-label="Shadow supporting record amounts">
        {railStats.map((stat) => (
          <div className={`treasuryHeroStat ${stat.tone}`} key={stat.label}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TreasuryEvidenceStrip({ treasuryState }: { treasuryState: TreasuryState | null }) {
  const passed = treasuryState?.checks?.filter((check) => check.ok).length;
  const total = treasuryState?.checks?.length;
  const currentV4WriteReady = treasuryState?.currentV4?.writeReady;
  const currentV4Action =
    currentV4WriteReady === undefined ? "not verified" : currentV4WriteReady ? "write-ready" : "inactive";
  const contractLinks = [
    { label: "Float V2", value: FLOAT_V2_CONTRACT, href: `https://testnet.arcscan.app/address/${FLOAT_V2_CONTRACT}` },
    {
      label: "MandateRegistry",
      value: TREASURY_PROOF.mandateRegistry,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.mandateRegistry}`,
    },
    {
      label: "BondedEnforcer",
      value: TREASURY_PROOF.bondedEnforcer,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.bondedEnforcer}`,
    },
    {
      label: "Morpho adapter",
      value: TREASURY_PROOF.morphoAdapter,
      href: `https://testnet.arcscan.app/address/${TREASURY_PROOF.morphoAdapter}`,
    },
    {
      label: "current read V4 adapter",
      value: LEPTON_M1_DEPLOYMENTS.currentRead.v4StyleAdapter,
      href: `https://testnet.arcscan.app/address/${LEPTON_M1_DEPLOYMENTS.currentRead.v4StyleAdapter}`,
    },
    {
      label: "historical June 19 V4 adapter",
      value: LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.v4StyleAdapter,
      href: `https://testnet.arcscan.app/address/${LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.v4StyleAdapter}`,
    },
  ];
  const txLinks = [
    { label: "V2 provider payment", value: FLOAT_V2_PROOF.directSpendTx, href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
    { label: "V2 blocked spend", value: FLOAT_V2_PROOF.blockedSpendTx, href: txUrl(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "vault allocation", value: TREASURY_PROOF.txs.allocation, href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "blocked allocation", value: TREASURY_PROOF.txs.blocked, href: txUrl(TREASURY_PROOF.txs.blocked) },
    {
      label: "historical June 19 passkey proof",
      value: LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash,
      href: txUrl(LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.txHash),
    },
  ];

  return (
    <section className="treasuryEvidenceStrip" aria-label="Shadow supporting records onchain evidence">
      <div className="treasuryEvidenceIntro">
        <span>onchain evidence</span>
        <strong>{treasuryState?.ok ? `${passed}/${total} live checks pass` : "contracts and txs visible"}</strong>
        <p>Contract addresses and ArcScan transactions are visible from the product surface.</p>
        <p>
          Current V4 reads use <code>{shortAddress(LEPTON_M1_DEPLOYMENTS.currentRead.v4StyleAdapter)}</code>. The June 19
          passkey proof used <code>{shortAddress(LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey.v4StyleAdapter)}</code>.
          The current wallet action is {currentV4Action}.
        </p>
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Record contracts">
        {contractLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
      </div>
      <div className="treasuryEvidenceGroup" aria-label="Record transactions">
        {txLinks.map((item) => (
          <a href={item.href} target="_blank" rel="noreferrer" key={item.label}>
            <span>{item.label}</span>
            <code>{shortAddress(item.value)}</code>
          </a>
        ))}
        <a href="/api/treasury" target="_blank" rel="noreferrer">
          <span>verifier JSON</span>
          <code>/api/treasury</code>
        </a>
      </div>
    </section>
  );
}

function TreasuryRailSplit({
  leptonState,
}: {
  leptonState: LeptonState | null;
}) {
  const railCards = [
    {
      eyebrow: "payment path",
      title: "Float pays the provider from reserved capacity",
      body: "Signed agents authorize a spend, Float pays the approved provider from reserved capacity, debt opens, and repayment restores capacity.",
      stat: "V2 signed intent live",
      href: "/evidence#float",
      cta: "View Float activity",
    },
    {
      eyebrow: "allocation path",
      title: "Mandate adapters gate approved movement",
      body: "The approved adapter authenticates the account, reads the bonded enforcer's ALLOW or BLOCK decision, and only moves vault-style USDC on ALLOW. This guarantee is scoped to approved adapters.",
      stat: leptonState?.morphoDepositedUSDC !== undefined ? `${formatUSDC(leptonState.morphoDepositedUSDC)} USDC allocated` : "0.1 USDC allocated",
      href: "/evidence#records",
      cta: "View records",
    },
    {
      eyebrow: "combined receipts",
      title: "One read-only check follows the transaction path",
      body: "The current product surface separates Float V2 payments from adapter records and settlement evidence, while keeping every anchor public.",
      stat: "Arc tx anchors",
      href: "https://github.com/buildwithshadow/shadow",
      cta: "View repo",
    },
  ];

  return (
    <section className="treasuryRailSection" aria-label="Shadow supporting records path split">
      <div className="treasurySectionHeader">
        <p className="eyebrow">supporting records</p>
        <h2>Payments, adapter movement, and settlement records stay separated and verifiable.</h2>
      </div>
      <div className="treasuryRailGrid">
        {railCards.map((card) => {
          const content = (
            <>
              <span>{card.eyebrow}</span>
              <strong>{card.title}</strong>
              <p>{card.body}</p>
              <em>{card.stat}</em>
              <small>{card.cta} →</small>
            </>
          );
          return card.href.startsWith("http") ? (
            <a className="treasuryRailCard" href={card.href} target="_blank" rel="noreferrer" key={card.eyebrow}>
              {content}
            </a>
          ) : (
            <Link className="treasuryRailCard" to={card.href} key={card.eyebrow}>
              {content}
            </Link>
          );
        })}
      </div>
    </section>
  );
}


function TreasuryReceiptStructurePanel() {
  const receipts = [
    {
      title: "ALLOW receipt",
      subtitle: "vault allocation",
      href: txUrl(TREASURY_PROOF.txs.allocation),
      fields: [
        "decision = ALLOW",
        "reason = NONE",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountAllocatedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        `target = ${shortAddress(TREASURY_PROOF.morphoAdapter)}`,
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.allowedAction as Hash)}`,
      ],
    },
    {
      title: "BLOCK receipt",
      subtitle: "over-limit allocation",
      href: txUrl(TREASURY_PROOF.txs.blocked),
      fields: [
        "decision = BLOCK",
        "reason = AMOUNT_TOO_HIGH",
        `amount = ${formatFloatUSDC(TREASURY_PROOF.amountBlockedUSDC)} USDC`,
        `actor = ${shortAddress(TREASURY_PROOF.operator)}`,
        "vault Transfer = none",
        `actionHash = ${shortAddress(TREASURY_PROOF.hashes.blockedAction as Hash)}`,
      ],
    },
    {
      title: "Float debt receipt",
      subtitle: "historical Float payment",
      href: `/api/float-tools?action=verify&hash=${TREASURY_PROOF.hashes.floatRequest}`,
      fields: [
        "receipt = SPEND_ALLOWED + PROVIDER_PAID + FEE_ACCRUED + DEBT_OPENED",
        `provider paid = ${formatFloatUSDC(TREASURY_PROOF.amountX402USDC)} USDC`,
        `fee = ${formatFloatUSDC(TREASURY_PROOF.feeUSDC)} USDC`,
        `requestHash = ${shortAddress(TREASURY_PROOF.hashes.floatRequest as Hash)}`,
      ],
    },
  ];

  return (
    <section className="treasuryReceiptStructure" aria-label="Treasury receipt structure">
      <div className="treasurySectionHeader">
        <p className="eyebrow">receipt structure · defined fields</p>
        <h2>ALLOW and BLOCK are not labels; they are receipt fields checked by the verifier.</h2>
      </div>
      <div className="treasuryReceiptGrid">
        {receipts.map((receipt) => (
          <a className="treasuryReceiptCard" href={receipt.href} target="_blank" rel="noreferrer" key={receipt.title}>
            <span>{receipt.subtitle}</span>
            <strong>{receipt.title}</strong>
            <ul>
              {receipt.fields.map((field) => (
                <li key={field}>{field}</li>
              ))}
            </ul>
          </a>
        ))}
      </div>
    </section>
  );
}

function TreasuryLiveVerifierPanel({
  state,
  loading,
  error,
}: {
  state: TreasuryState | null;
  loading: boolean;
  error: string | null;
}) {
  const checks = state?.checks || [];
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const visibleChecks = checks.slice(0, 8);
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <section className="treasuryLiveVerifier" aria-label="Live Shadow records verifier">
      <div className="treasuryLiveVerifierHeader">
        <div>
          <p className="eyebrow">live verifier · no private keys</p>
          <h2>This panel reads the live records checks; the CLI provides a reproducible check.</h2>
          <p>
            This endpoint verifies the mandate adapter path from live Arc state. The current Float V2 payment anchors are
            shown in the Float activity section.
          </p>
        </div>
        <a href="/api/treasury" target="_blank" rel="noreferrer" className={`treasuryVerifierBadge ${state?.ok ? "pass" : error ? "fail" : ""}`}>
          {loading && !state ? "syncing" : state?.ok ? "PASS" : error ? "CHECK API" : "loading"}
          {state && <span>{passed}/{checks.length} checks</span>}
        </a>
      </div>

      {error ? (
        <div className="treasuryVerifierError">
          <strong>Verifier read failed</strong>
          <p>{error}</p>
        </div>
      ) : (
        <div className="treasuryVerifierGrid">
          <article className="treasuryVerifierSummary">
            <span>combined path</span>
            <strong>{state?.ok ? "green" : loading ? "syncing" : "pending"}</strong>
            <p>
              {failed
                ? `${failed} check${failed === 1 ? "" : "s"} need attention before relying on this view.`
                : state
                  ? `All ${passed} live checks passed${checkedAt ? ` at ${checkedAt}` : ""}.`
                  : "Waiting for the live records API to return."}
            </p>
            <div>
              <a href="/api/treasury" target="_blank" rel="noreferrer">
                Open JSON
              </a>
              <a href="https://github.com/buildwithshadow/shadow" target="_blank" rel="noreferrer">
                Run CLI
              </a>
            </div>
          </article>
          <div className="treasuryVerifierChecks">
            {visibleChecks.map((check) => (
              <article className={check.ok ? "pass" : "fail"} key={check.check}>
                <span>{check.status}</span>
                <strong>{check.check}</strong>
                <p>{check.detail}</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function TreasuryOnchainLinks() {
  const links = [
    { label: "Source repository", value: "github.com/buildwithshadow/shadow", href: "https://github.com/buildwithshadow/shadow" },
    { label: "V2 provider payment", value: shortAddress(FLOAT_V2_PROOF.directSpendTx), href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
    { label: "V2 blocked spend", value: shortAddress(FLOAT_V2_PROOF.blockedSpendTx), href: txUrl(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "Vault allocation", value: shortAddress(TREASURY_PROOF.txs.allocation), href: txUrl(TREASURY_PROOF.txs.allocation) },
    { label: "Blocked allocation", value: shortAddress(TREASURY_PROOF.txs.blocked), href: txUrl(TREASURY_PROOF.txs.blocked) },
    { label: "V2 source match", value: shortAddress(FLOAT_V2_CONTRACT), href: FLOAT_V2_PROOF.sourcify },
  ];

  return (
    <section className="treasuryJudgePath" aria-label="Shadow Treasury onchain references">
      <div className="treasurySectionHeader">
        <p className="eyebrow">onchain references</p>
        <h2>The same story resolves to public transactions.</h2>
      </div>
      <div className="treasuryJudgeGrid">
        {links.map((link) => (
          <a className="treasuryJudgeLink" href={link.href} target="_blank" rel="noreferrer" key={link.label}>
            <span>{link.label}</span>
            <strong>{link.value}</strong>
          </a>
        ))}
      </div>
    </section>
  );
}

function ForumFeeRouterCanaryProof() {
  const transactions = [
    { label: "Forum published", detail: "one bounded dust intent", hash: FORUM_FEEROUTER_CANARY.txs.publish },
    { label: "Routing disabled", detail: "canary gate returned off", hash: FORUM_FEEROUTER_CANARY.txs.routingDisabled },
    { label: "Forum claimed", detail: "7 atomic USDC", hash: FORUM_FEEROUTER_CANARY.txs.forumClaim },
    { label: "Shadow claimed", detail: "3 atomic USDC", hash: FORUM_FEEROUTER_CANARY.txs.protocolClaim },
  ];
  const contracts = [
    { label: "Canary router", address: FORUM_FEEROUTER_CANARY.addresses.router },
    { label: "Fee splitter", address: FORUM_FEEROUTER_CANARY.addresses.splitter },
    { label: "Forum FeeRouter", address: FORUM_FEEROUTER_CANARY.addresses.feeRouter },
  ];

  return (
    <section className="forumCanaryProof" id="forum-feerouter-canary" aria-label="Forum FeeRouter external integration proof">
      <div className="forumCanaryHeader">
        <div>
          <p className="eyebrow">external integration · isolated Arc testnet canary</p>
          <h2>Forum published one intent; Shadow routed one mirror fee. Every atomic unit reconciled.</h2>
          <p>
            Forum published a single intent from its own wallet. Shadow's isolated canary copied it, routed the mirror fee
            through Forum's FeeRouter, and returned routing to disabled before either recipient claimed.
          </p>
        </div>
        <div className="forumCanaryStatus" aria-label="Canary verification status">
          <span />
          <div>
            <small>final verifier</small>
            <strong>CANARY COMPLETE</strong>
            <code>block {FORUM_FEEROUTER_CANARY.finalBlock.toLocaleString("en-US")}</code>
          </div>
        </div>
      </div>

      <div className="forumCanaryMetrics" aria-label="Forum canary result">
        <div>
          <span>confirmed publishes</span>
          <strong>1</strong>
        </div>
        <div>
          <span>fee routed</span>
          <strong>{FORUM_FEEROUTER_CANARY.totalFeeAtomicUSDC}</strong>
          <small>atomic USDC</small>
        </div>
        <div>
          <span>Forum / Shadow</span>
          <strong>{FORUM_FEEROUTER_CANARY.forumShareAtomicUSDC} / {FORUM_FEEROUTER_CANARY.protocolShareAtomicUSDC}</strong>
          <small>exact 70 / 30</small>
        </div>
        <div>
          <span>outstanding</span>
          <strong>0 / 0</strong>
          <small>both claimed</small>
        </div>
        <div>
          <span>post-condition</span>
          <strong>OFF</strong>
          <small>external routing</small>
        </div>
      </div>

      <div className="forumCanaryTrace">
        <div className="forumCanaryTransactions" aria-label="Forum canary transactions">
          <div className="forumCanarySubhead">
            <span>transaction trace</span>
            <strong>Signer and transfer evidence</strong>
          </div>
          {transactions.map((transaction) => (
            <a href={txUrl(transaction.hash)} target="_blank" rel="noreferrer" key={transaction.label}>
              <span>{transaction.label}</span>
              <small>{transaction.detail}</small>
              <code>{shortAddress(transaction.hash)}</code>
            </a>
          ))}
        </div>

        <div className="forumCanaryReferences" aria-label="Forum canary contracts and evidence">
          <div className="forumCanarySubhead">
            <span>reproduce</span>
            <strong>Contracts and proof artifact</strong>
          </div>
          {contracts.map((contract) => (
            <a
              href={`${arcExplorerUrl}/address/${contract.address}`}
              target="_blank"
              rel="noreferrer"
              key={contract.label}
            >
              <span>{contract.label}</span>
              <code>{shortAddress(contract.address)}</code>
            </a>
          ))}
          <a href="/proofs/forum-feerouter-canary.json" target="_blank" rel="noreferrer">
            <span>Public result JSON</span>
            <code>7 / 3 · zero outstanding</code>
          </a>
          <a
            href="https://github.com/buildwithshadow/shadow/blob/main/docs/FORUM_FEEROUTER_CANARY.md"
            target="_blank"
            rel="noreferrer"
          >
            <span>Verifier runbook</span>
            <code>source and commands</code>
          </a>
        </div>
      </div>

      <p className="forumCanaryBoundary">
        Bounded external-builder integration pilot. The canary used isolated contracts and dust-sized Arc testnet USDC;
        it is not production routing or independent security validation. Final state: split allocation
        7 / 3, outstanding 0 / 0, fallback 0 / 0, temporary allowances 0 / 0, routing disabled.
      </p>
    </section>
  );
}

function TreasuryValidationPanel() {
  const validationRows = [
    {
      label: "Obol",
      status: "verified Float draw",
      detail: "Buyer-side agent signed a current-contract spend intent; the verified snapshot shows an open debt awaiting repayment.",
    },
    {
      label: "Argus",
      status: "V2 intents recorded",
      detail: "Agent Alpha signed Float V2 intents, including a paid CitePay query.",
    },
    {
      label: "CitePay",
      status: "provider and sponsor receipts",
      detail: "CitePay appears on the V2 proof path as a provider paid by Float and as the non-operator sponsor of lines whose reserves have been reclaimed.",
    },
    {
      label: "Forum",
      status: "FeeRouter canary settled",
      detail: "Forum published one intent into an isolated canary. The 10-atomic fee split 7/3, both recipients claimed, and routing returned disabled.",
    },
  ];

  return (
    <section className="treasuryValidationSection" aria-label="External feedback and builder background">
      <div className="treasurySectionHeader">
        <p className="eyebrow">external usage · public receipts</p>
        <h2>External Float usage is live; supporting records stay public.</h2>
      </div>

      <div className="treasuryValidationGrid">
        <article className="treasuryValidationCard treasuryValidationCardPrimary">
          <span>external Float usage</span>
          <strong>V2 signed intents live</strong>
          <p>
            External agents can authorize a bounded Float spend without pre funding the provider payment first. The contract
            verifies the signature and pays the provider from sponsor reserve.
          </p>
          <Link to="/evidence#float">View Float activity →</Link>
        </article>

        <article className="treasuryValidationCard treasuryValidationCardValidated">
          <span>receipt check</span>
          <strong>Use public records, not claims</strong>
          <p>
            The verifier output and Float board expose the provider payment, adapter allow and block records, sponsor
            reserves, repayments, and reserve reclaim transactions.
          </p>
          <a href="/api/treasury" target="_blank" rel="noreferrer">
            Open verifier output →
          </a>
        </article>

        <article className="treasuryValidationCard">
          <span>current usage</span>
          <strong>External agents are signing V2 intents</strong>
          <p>
            Forum, CitePay, Obol, Crux, and Argus-style agents are the relevant surface now: bounded intents, provider
            payment, debt, repayment, and overrun blocks on V2.
          </p>
          <Link to="/evidence#float">View Float activity →</Link>
        </article>
      </div>

      <div className="treasuryValidationList" aria-label="External feedback entries">
        {validationRows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.status}</strong>
            <p>{row.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TreasuryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`treasuryMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}


function FloatV2CurrentPanel({
  state,
  loading,
  error,
  deskState,
  deskLoading,
  deskError,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
  deskState: FloatDeskState | null;
  deskLoading: boolean;
  deskError: string | null;
}) {
  const isCheckpoint = isFloatV2CheckpointState(state);
  const showCount = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const showUSDC = (value?: string | bigint | null) => (value === undefined || value === null ? (loading ? "reading" : "unavailable") : `${formatFloatUSDC(value)} USDC`);
  const statusText = isCheckpoint ? "verified checkpoint" : error ? "V2 read needs review" : loading && !state ? "reading V2" : "V2 active";
  const statusTone = error && !isCheckpoint ? "pending" : "configured";
  const anchors = [
    { label: "V2 contract source", href: FLOAT_V2_PROOF.sourcify, value: shortAddress(FLOAT_V2_CONTRACT) },
    { label: "signed provider payment", href: txUrl(FLOAT_V2_PROOF.directSpendTx), value: shortAddress(FLOAT_V2_PROOF.directSpendTx) },
    { label: "overrun blocked", href: txUrl(FLOAT_V2_PROOF.blockedSpendTx), value: shortAddress(FLOAT_V2_PROOF.blockedSpendTx) },
    { label: "repayment restored line", href: txUrl(FLOAT_V2_PROOF.repayTx), value: shortAddress(FLOAT_V2_PROOF.repayTx) },
    { label: "Crux external lifecycle", href: txUrl(FLOAT_V2_PROOF.cruxRepayTx), value: shortAddress(FLOAT_V2_PROOF.cruxRepayTx) },
    { label: "Argus Alpha closed loop", href: txUrl(FLOAT_V2_PROOF.argusAlphaRepayTx), value: shortAddress(FLOAT_V2_PROOF.argusAlphaRepayTx) },
    { label: "Argus to CitePay loop", href: txUrl(FLOAT_V2_PROOF.argusCitePayRepayTx), value: shortAddress(FLOAT_V2_PROOF.argusCitePayRepayTx) },
    { label: "CitePay provider proof", href: txUrl(FLOAT_V2_PROOF.citePayProviderQueryTxs[0]), value: "5 paid queries" },
    { label: "CitePay delivery receipt", href: txUrl(FLOAT_V2_PROOF.dripletCitePayDeliveryTx), value: shortAddress(FLOAT_V2_PROOF.dripletCitePayDeliveryTx) },
    { label: "CitePay renewed reserve reclaimed", href: txUrl(FLOAT_V2_PROOF.citePayRenewedCloseTx), value: shortAddress(FLOAT_V2_PROOF.citePayRenewedCloseTx) },
    { label: "Forum reserve reclaim", href: txUrl(FLOAT_V2_PROOF.forumSponsorCloseTx), value: shortAddress(FLOAT_V2_PROOF.forumSponsorCloseTx) },
    { label: "Forum reserve reopen proof", href: txUrl(FLOAT_V2_PROOF.forumSponsorReopenTx), value: shortAddress(FLOAT_V2_PROOF.forumSponsorReopenTx) },
    { label: "CCTP-funded reserve", href: txUrl(FLOAT_V2_PROOF.cctpOpenLineTx), value: shortAddress(FLOAT_V2_PROOF.cctpOpenLineTx) },
    { label: "Obol signed spend", href: txUrl(FLOAT_V2_PROOF.obolSpendTx), value: shortAddress(FLOAT_V2_PROOF.obolSpendTx) },
  ];

  return (
    <section className="floatPanel floatPanelV2" id="shadow-float" aria-label="Shadow Float V2 current product">
      <div className="floatHeroShell">
        <div className="floatHeroCopy">
          <p className="eyebrow">Shadow Float V2 · Arc Testnet · chain 5042002</p>
          <h2>Let agents pay providers without pre funding every wallet.</h2>
          <p className="floatLede">
            Shadow Float lets a sponsor reserve Arc USDC for an agent. The agent signs a bounded spend intent, the contract
            pays the named provider from that reserve, and the line is restored when the agent repays.
          </p>
          <div className="floatHeroActions">
            <a className="floatPrimaryAction" href="#v2-activity">
              View activity
            </a>
            <Link className="floatSecondaryAction" to="/builders/v2">
              Add an agent
            </Link>
          </div>
        </div>
        <aside className="floatProofCard" aria-label="Shadow Float V2 live state">
          <div className="floatProofCardHeader">
            <span>current line behavior</span>
            <strong>contract enforced</strong>
          </div>
          <div className="floatProofCardMoment">
            <span>approved request</span>
            <strong>provider paid</strong>
            <small>from sponsor reserve</small>
          </div>
          <div className="floatProofCardMoment blocked">
            <span>oversized request</span>
            <strong>blocked first</strong>
            <small>no provider transfer</small>
          </div>
          <div className="floatProofCardFooter">
            <span>chain 5042002</span>
            <span>Arc USDC</span>
          </div>
        </aside>
      </div>

      <div className="floatStatusRow">
        <div className={`floatStatus ${statusTone}`}>
          <span className="floatStatusDot" />
          {statusText}
        </div>
        <span>sponsor reserve pays providers</span>
        <span>nonce and max debt checked onchain</span>
        <span>external agent histories tracked</span>
      </div>

      <FloatV2ProofCockpit state={state} loading={loading} error={error} />

      <div className="floatMetricGrid">
        <FloatMetric label="tracked agent lines" value={showCount(state?.summary?.trackedExternalAgentLines)} tone="allow" />
        <FloatMetric label="signed intents" value={showCount(state?.summary?.signedIntents)} tone="allow" />
        <FloatMetric label="provider paid" value={showUSDC(state?.summary?.providerPaidUSDC)} tone="allow" />
        <FloatMetric label="closed loops" value={showCount(state?.summary?.repaidLifecycles)} tone="allow" />
        <FloatMetric label="open debt" value={showUSDC(state?.summary?.activeDebtUSDC)} tone={state?.summary?.openDebtAgents ? "block" : "allow"} />
      </div>

      <FloatDeskLabLineCard state={deskState} loading={deskLoading} error={deskError} />
      <FloatDeskJournal state={deskState} loading={deskLoading} error={deskError} />
      <FloatV2ActivityBoard state={state} loading={loading} error={error} />
      <FloatV2SponsorCapitalPanel state={state} />
      <FloatV2WorkflowPanel />
      <FloatV2UseCasePanel />
      <FloatV2VerificationFooter anchors={anchors} />
    </section>
  );
}

function FloatV2UseCasePanel() {
  const items = [
    {
      title: "For buyer agents",
      body: "Call paid APIs or data providers before every agent wallet has to be manually topped up.",
    },
    {
      title: "For sponsors",
      body: "Set bounded capacity per agent, keep reserves capped, and let repayment restore the line.",
    },
    {
      title: "For providers",
      body: "Receive Arc USDC directly from contract custody when the signed request is inside policy.",
    },
  ];

  return (
    <section className="floatV2UseCase" aria-label="Shadow Float V2 users">
      <div>
        <span>why Float exists</span>
        <strong>Autonomous agents need paid services, but pre funding every wallet is hard to manage at scale.</strong>
      </div>
      <div className="floatV2UseCaseGrid">
        {items.map((item) => (
          <article key={item.title}>
            <strong>{item.title}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function FloatV2WorkflowPanel() {
  const steps = [
    {
      label: "Sponsor",
      title: "Reserve capacity",
      body: "A sponsor backs a specific agent line with Arc USDC. The contract will not promise more spendable capacity than the reserve can support.",
    },
    {
      label: "Agent",
      title: "Sign bounded spend",
      body: "The agent signs provider, endpoint, amount, max debt, nonce, expiry, and executor. The key stays with the builder.",
    },
    {
      label: "Provider",
      title: "Get paid directly",
      body: "If the signed intent is valid and inside the line policy, Float pays the named provider from contract custody.",
    },
    {
      label: "Line",
      title: "Repay or block",
      body: "Repayment restores capacity. Oversized attempts are recorded and refused before provider funds move.",
    },
  ];

  return (
    <section className="floatV2Workflow" aria-label="Shadow Float V2 workflow">
      <div className="floatBoxHeader">
        <span>how it works</span>
        <small>sponsor backed capacity</small>
      </div>
      <div className="floatV2WorkflowGrid">
        {steps.map((step, index) => (
          <article key={step.label}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function FloatV2SponsorCapitalPanel({ state }: { state: FloatV2ActivityState | null }) {
  const totalSponsoredReserve = state?.totalSponsoredReserveUSDC
    ? `${formatFloatUSDC(state.totalSponsoredReserveUSDC)} USDC`
    : "reading";
  const stateByAgent = new Map((state?.agents || []).map((agent) => [agent.agent.toLowerCase(), agent]));
  const sponsorPresentation = (agent: string) => {
    const sponsorState = stateByAgent.get(agent.toLowerCase())?.sponsorState;
    if (sponsorState === "active-reserve") return { status: "unexpired reserve", tone: "live" };
    if (sponsorState === "expired-debt-open") return { status: "expired · debt open", tone: "expired" };
    if (sponsorState === "expired-reserve-reclaimable") return { status: "expired · reclaimable", tone: "expired" };
    if (sponsorState === "closed-reserve-reclaimed") return { status: "reserve reclaimed", tone: "reclaimed" };
    return { status: "state unavailable", tone: "" };
  };
  const unexpiredReserveCount = [...stateByAgent.values()].filter(
    (agent) => floatV2SponsorProvenance(agent) === "verified-external" && agent.sponsorState === "active-reserve",
  ).length;
  const citePayAgent = "0x236652EAd43fbb0948173fC4dDF23BC0971B274d";
  const forumAgent = "0x645b8cc3A35A204D0cd025cccbd61618Ab9e139C";
  const sponsorRuns = [
    {
      name: "CitePay",
      ...sponsorPresentation(citePayAgent),
      sponsor: "0x5389688243328c26a92b301faEEAb5fbf9AFf105",
      agent: citePayAgent,
      reserve: "0.05 USDC",
      proofHref: "/proofs/citepay-clear-canary.json",
      body: "CitePay reclaimed its retired line and opened a fresh line for a controlled signer. That agent completed two signed spend-and-repay cycles; the latest required an exact-quote Clear receipt before payment. CitePay then reclaimed the debt-free renewed reserve.",
      steps: [
        { label: "close retired line", tx: FLOAT_V2_PROOF.citePaySponsorCloseTx },
        { label: "open renewed line", tx: FLOAT_V2_PROOF.citePayRenewedOpenTx },
        { label: "renewed spend", tx: FLOAT_V2_PROOF.citePayRenewedSpendTx },
        { label: "renewed repay", tx: FLOAT_V2_PROOF.citePayRenewedRepayTx },
        { label: "Clear-gated spend", tx: FLOAT_V2_PROOF.citePayClearSpendTx },
        { label: "agent repayment", tx: FLOAT_V2_PROOF.citePayClearRepayTx },
        { label: "close renewed line", tx: FLOAT_V2_PROOF.citePayRenewedCloseTx },
      ],
    },
    {
      name: "Forum Tollgate",
      ...sponsorPresentation(forumAgent),
      sponsor: "0x12F25B721Cc21c38495e33A4c8524dd0B647ba03",
      agent: forumAgent,
      reserve: "0.05 USDC",
      proofHref: null,
      body: "Forum Tollgate proved sponsor, spend, repay, reserve reclaim, and reopen. Current reserve status is classified from the recorded reserve and line expiry.",
      steps: [
        { label: "openSponsoredLine", tx: FLOAT_V2_PROOF.forumSponsorOpenTx },
        { label: "spend", tx: FLOAT_V2_PROOF.forumSponsorSpendTx },
        { label: "repay", tx: FLOAT_V2_PROOF.forumSponsorRepayTx },
        { label: "closeSponsoredLine", tx: FLOAT_V2_PROOF.forumSponsorCloseTx },
        { label: "reopen line", tx: FLOAT_V2_PROOF.forumSponsorReopenTx },
      ],
    },
  ];

  return (
    <section className="floatSponsorCapital" id="sponsor-capital" aria-label="External sponsor capital on Shadow Float V2">
      <div className="floatBoxHeader">
        <span>external sponsor capital</span>
        <small>outside wallets, bounded reserves</small>
      </div>
      <div className="floatSponsorCapitalIntro">
        <div>
          <strong>
            Outside wallets can back agent capacity; sponsors can reclaim a debt-free line or only the reserve remainder after default.
          </strong>
          <p>
            These records show non-operator wallets backing agent capacity. Each reserve is bound to one agent line and one
            provider mandate. closeSponsoredLine requires zero active debt; defaultSponsoredLine lets the sponsor write off
            debt and recover only the reserve remainder.
          </p>
        </div>
        <div className="floatSponsorCapitalStats">
          <FloatFact label="sponsor records" value={String(sponsorRuns.length)} />
          <FloatFact label="unexpired reserve lines" value={String(unexpiredReserveCount)} />
          <FloatFact label="reclaim proof" value="Forum" />
          <FloatFact label="reserve held on V2" value={totalSponsoredReserve} />
        </div>
      </div>
      <div className="floatSponsorCapitalGrid">
        {sponsorRuns.map((run) => (
          <article className={`floatSponsorCapitalCard ${run.tone}`} key={run.name}>
            <header>
              <div>
                <span>{run.name}</span>
                <strong>{run.status}</strong>
              </div>
              <em>{run.reserve}</em>
            </header>
            <p>{run.body}</p>
            <dl className="floatSponsorWallets">
              <div>
                <dt>sponsor sender</dt>
                <dd>{shortAddress(run.sponsor)}</dd>
              </div>
              <div>
                <dt>agent line</dt>
                <dd>{shortAddress(run.agent)}</dd>
              </div>
            </dl>
            <div className="floatSponsorSteps" aria-label={`${run.name} sponsor transaction steps`}>
              {run.steps.map((step) => (
                <a href={txUrl(step.tx)} target="_blank" rel="noreferrer" key={step.label}>
                  {step.label}
                  <strong>{shortAddress(step.tx)}</strong>
                </a>
              ))}
            </div>
            {run.proofHref ? (
              <a className="floatSponsorProofLink" href={run.proofHref} target="_blank" rel="noreferrer">
                Open machine-readable proof
              </a>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function FloatV2VerificationFooter({
  anchors,
}: {
  anchors: Array<{ label: string; href: string; value: string }>;
}) {
  return (
    <section className="floatV2VerificationFooter" id="float-verifier" aria-label="Shadow Float V2 verification links">
      <div>
        <span>inspectable records</span>
        <p>Source match, transaction anchors, and the local check command are available for builders who want to inspect the line.</p>
      </div>
      <div className="floatV2VerificationLinks">
        {anchors.map((anchor) => (
          <a href={anchor.href} target="_blank" rel="noreferrer" key={anchor.label}>
            {anchor.label} <strong>{anchor.value}</strong>
          </a>
        ))}
        <a href="https://github.com/buildwithshadow/shadow" target="_blank" rel="noreferrer">
          strict check <strong>float:v2-verify-live</strong>
        </a>
      </div>
    </section>
  );
}

function classifyFloatV2Lifecycle(agent: FloatV2AgentState): {
  label: string;
  detail: string;
  tone: "closed" | "open" | "signed" | "registered" | "blocked";
} {
  const activeDebt = asAtomicUSDC(agent.activeDebtUSDC);
  if (agent.repaidCount > 0 && activeDebt === 0n) {
    if (agent.sponsorState === "expired-reserve-reclaimable") {
      return { label: "closed", detail: "signed, paid, repaid · reserve expired and reclaimable", tone: "closed" };
    }
    if (agent.sponsorState === "closed-reserve-reclaimed" || (asAtomicUSDC(agent.sponsorReserveUSDC) === 0n && asAtomicUSDC(agent.creditLimitUSDC) === 0n)) {
      return { label: "closed", detail: "paid, repaid, reserve reclaimed", tone: "closed" };
    }
    return { label: "closed", detail: "signed, paid, repaid", tone: "closed" };
  }
  if (activeDebt > 0n) {
    const isObol = agent.agent.toLowerCase() === OBOL_SIGNER;
    return {
      label: "open debt",
      detail: isObol
        ? "one open-debt exhibit, repayment pending"
        : agent.sponsorState === "expired-debt-open"
          ? "line expired, debt repayment required"
        : agent.providerPaidCount > 0
          ? "provider paid, repayment pending"
          : "debt open, payment log syncing",
      tone: "open",
    };
  }
  if (agent.blockedCount > 0 && agent.providerPaidCount === 0) {
    return { label: "blocked", detail: "overrun refused", tone: "blocked" };
  }
  if (agent.signedIntents > 0) {
    return { label: "signed", detail: "waiting for provider payment", tone: "signed" };
  }
  return { label: "registered", detail: "line ready", tone: "registered" };
}

function describeFloatV2Behavior(agent: FloatV2AgentState): string {
  const behavior = agent.behavior;
  if (!behavior) {
    if (agent.providerPaidCount > 0 || agent.repaidCount > 0) return `paid ${agent.providerPaidCount} · repaid ${agent.repaidCount}`;
    return "behavior syncing";
  }
  const paid = behavior.signedExternalPaid + behavior.paidBound;
  const repaid = behavior.repaid;
  const parts = [`paid ${paid}`, `repaid ${repaid}`];
  if (behavior.blocked > 0) parts.push(`blocked ${behavior.blocked}`);
  if (behavior.denied > 0) parts.push(`denied ${behavior.denied}`);
  if (behavior.errorCount > 0) parts.push(`errors ${behavior.errorCount}`);
  return parts.join(" · ");
}

function formatFloatV2Review(agent: FloatV2AgentState): string {
  if (!agent.lastReviewISO) return "review syncing";
  const date = new Date(agent.lastReviewISO);
  if (Number.isNaN(date.getTime())) return "review syncing";
  return `reviewed ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function FloatV2ActivityBoard({
  state,
  loading,
  error,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
}) {
  const agents = state?.agents || [];
  const isCheckpoint = isFloatV2CheckpointState(state);
  const checkedAt = state?.checkedAt
    ? new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const statusLabel = isCheckpoint ? "verified checkpoint" : error ? "V2 read needs review" : loading && !state ? "reading V2 activity" : "live V2 activity";
  const closed = state?.summary?.repaidLifecycles ?? 0;
  const openDebt = state?.summary?.openDebtAgents ?? 0;
  const topScore = agents.reduce((max, agent) => Math.max(max, agent.autonomousScore?.score ?? agent.score ?? 0), 0);
  const showCount = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const showUSDC = (value?: string | bigint | null) => (value === undefined || value === null ? (loading ? "reading" : "unavailable") : `${formatFloatUSDC(value)} USDC`);

  return (
    <section className="floatV2ActivityBoard" id="v2-activity" aria-label="Shadow Float V2 external activity">
      <div className="floatBoxHeader">
        <span>external agent board</span>
        <small>{checkedAt ? `${isCheckpoint ? "checkpoint" : "updated"} ${checkedAt}` : statusLabel}</small>
      </div>
      <div className="floatV2ActivityIntro">
        <div>
          <strong>{closed} closed V2 lifecycle{closed === 1 ? "" : "s"} · {openDebt} open debt line{openDebt === 1 ? "" : "s"}</strong>
          <p>
            Closed means the agent signed a V2 intent, ShadowFloat paid the provider from sponsor reserve, and the same line
            was repaid. Open debt means the provider payment is already bound and the agent has not repaid yet.
            Sponsored lines are scored by the contract from behavior stats after paid, blocked, and repaid actions.
            {isCheckpoint ? " Showing the verified checkpoint while the live Arc read recovers." : ""}
          </p>
        </div>
        <a href="/api/float?mode=v2" target="_blank" rel="noreferrer">
          Live API
        </a>
      </div>
      <div className="floatV2BoardGuide" aria-label="How to read the external agent board">
        <div>
          <span>closed</span>
          <strong>signed, paid, repaid</strong>
          <p>The provider was paid from reserve, then the agent restored the line.</p>
        </div>
        <div>
          <span>open debt</span>
          <strong>provider paid, repay pending</strong>
          <p>The service payment happened already. The agent still has debt on its line.</p>
        </div>
        <div>
          <span>blocked</span>
          <strong>no provider transfer</strong>
          <p>Oversized or denied requests are refused before any reserve moves.</p>
        </div>
      </div>

      <div className="floatV2ActivityStats">
        <FloatFact label="reserve-backed external lines" value={showCount(state?.summary?.trackedExternalAgentLines)} />
        <FloatFact label="external-sponsor reserve lines" value={showCount(state?.summary?.externallySponsoredLines)} />
        <FloatFact label="operator-sponsored lines" value={showCount(state?.summary?.operatorSponsoredLines)} />
        <FloatFact label="signed intents" value={showCount(state?.summary?.signedIntents)} />
        <FloatFact label="provider paid" value={showUSDC(state?.summary?.providerPaidUSDC)} />
        <FloatFact label="closed loops" value={showCount(state?.summary?.repaidLifecycles)} />
        <FloatFact label="historical returning agents" value={showCount(state?.summary?.returningAgents)} />
        <FloatFact label="returning external sponsors" value={showCount(state?.summary?.returningSponsors)} />
        <FloatFact label="open debt" value={showUSDC(state?.summary?.activeDebtUSDC)} />
        <FloatFact label="top contract score" value={topScore > 0 ? String(topScore) : loading ? "reading" : "unavailable"} />
      </div>

      {error && !isCheckpoint ? (
        <div className="floatV2ActivityEmpty">
          <strong>V2 activity read failed</strong>
          <span>{error}</span>
        </div>
      ) : agents.length ? (
        <div className="floatV2ActivityRows">
          {agents.map((agent) => {
            const href = agent.latestTxHash || agent.repayTx || agent.spendTx;
            const lifecycle = classifyFloatV2Lifecycle(agent);
            const reserveReclaimed = lifecycle.detail.includes("reserve reclaimed");
            const signerProvenance = agent.agentProvenance ?? FLOAT_V2_TRACKED_AGENTS.find(
              (trackedAgent) => trackedAgent.agent.toLowerCase() === agent.agent.toLowerCase(),
            )?.agentProvenance;
            const signerLabel =
              signerProvenance === "verified-external-signer"
                ? "verified external signer"
                : signerProvenance === "shadow-controlled-signer"
                  ? "Shadow-controlled system signer"
                  : "unverified signer";
            const row = (
              <>
                <div className="floatV2ActivityIdentity">
                  <strong>{agent.label}</strong>
                  <small>agent wallet {shortAddress(agent.agentOwner || agent.agent)} · {signerLabel}</small>
                  <small>{floatV2SponsorProvenanceLabel(agent)} · {shortAddress(agent.sponsor)}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>lifecycle</span>
                  <strong>{lifecycle.label}</strong>
                  <small>{lifecycle.detail}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>contract score</span>
                  <strong>{agent.autonomousScore?.score ?? agent.score}</strong>
                  <small>{formatFloatV2Review(agent)}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>behavior vector</span>
                  <strong>{agent.behaviorStateReset ? "reset on close" : describeFloatV2Behavior(agent)}</strong>
                  <small>{agent.behaviorStateReset ? "current state cleared; event history retained" : "scored by ShadowFloat"}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>line</span>
                  <strong>{reserveReclaimed ? "closed" : formatFloatUSDC(agent.creditLimitUSDC)}</strong>
                  <small>{reserveReclaimed ? "reserve reclaimed" : `cap ${formatFloatUSDC(agent.autonomousScore?.cappedLimitUSDC || agent.creditLimitUSDC)}`}</small>
                </div>
                <div className="floatV2ActivityMetric">
                  <span>debt</span>
                  <strong>{formatFloatUSDC(agent.activeDebtUSDC)}</strong>
                  <small>{formatFloatUSDC(agent.providerPaidUSDC)} paid</small>
                </div>
              </>
            );
            return href ? (
              <a className={`floatV2ActivityRow ${lifecycle.tone}`} href={txUrl(href)} target="_blank" rel="noreferrer" key={agent.agent}>
                {row}
              </a>
            ) : (
              <div className={`floatV2ActivityRow ${lifecycle.tone}`} key={agent.agent}>
                {row}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="floatV2ActivityEmpty">
          <strong>{loading ? "Reading V2 lines" : "No V2 external lines yet"}</strong>
          <span>Rows appear after registered external agents sign or repay on Float V2.</span>
        </div>
      )}
    </section>
  );
}

function FloatDeskLabLineCard({
  state,
  loading,
  error,
}: {
  state: FloatDeskState | null;
  loading: boolean;
  error: string | null;
}) {
  const labLine = state?.labLine || null;
  const latest = state?.entries?.[0];
  const latestSpend = latest?.txs?.spend;
  const latestSettle = latest?.txs?.settle;
  const status = error
    ? "desk line read needs review"
    : loading && !labLine
      ? "reading desk line"
      : labLine
        ? `${labLine.statusName || "UNKNOWN"} · scored by contract`
        : "desk line pending";

  return (
    <section className="floatDeskLineCard" aria-label="Float Desk system line">
      <div className="floatBoxHeader">
        <span>Float Desk system line</span>
        <small>{status}</small>
      </div>
      <div className="floatDeskLineBody">
        <div className="floatDeskLineLead">
          <span>autonomous desk</span>
          <strong>{labLine?.agent ? shortAddress(labLine.agent) : "desk agent"}</strong>
          <p>
            The Desk line is separated from external builder traction. It earns capacity from the same contract-scored
            behavior path used by sponsored external lines.
          </p>
        </div>
        <div className="floatDeskLineStats">
          <FloatFact label="score" value={labLine?.score !== undefined ? String(labLine.score) : loading ? "reading" : "pending"} />
          <FloatFact label="limit" value={labLine?.creditLimitUSDC ? `${formatFloatUSDC(labLine.creditLimitUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="available" value={labLine?.availableCreditUSDC ? `${formatFloatUSDC(labLine.availableCreditUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="debt" value={labLine?.activeDebtUSDC ? `${formatFloatUSDC(labLine.activeDebtUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="reserve" value={labLine?.sponsorReserveUSDC ? `${formatFloatUSDC(labLine.sponsorReserveUSDC)} USDC` : loading ? "reading" : "pending"} />
          <FloatFact label="provider settles" value={state?.counts ? String(state.counts.settles || 0) : loading ? "reading" : "0"} />
        </div>
        <div className="floatDeskLineProofs">
          {latestSpend?.requestHash && (
            <a href={latestSpend.txHash ? txUrl(latestSpend.txHash) : "/api/desk"} target="_blank" rel="noreferrer">
              rationale digest {shortHash(latestSpend.requestHash)}
            </a>
          )}
          {latestSpend?.txHash && (
            <a href={txUrl(latestSpend.txHash)} target="_blank" rel="noreferrer">
              latest spend {shortAddress(latestSpend.txHash)}
            </a>
          )}
          {latestSettle?.txHash && (
            <a href={txUrl(latestSettle.txHash)} target="_blank" rel="noreferrer">
              latest settle {shortAddress(latestSettle.txHash)}
            </a>
          )}
          <a href="/api/desk" target="_blank" rel="noreferrer">
            Desk API
          </a>
        </div>
      </div>
    </section>
  );
}

function FloatDeskJournal({
  state,
  loading,
  error,
}: {
  state: FloatDeskState | null;
  loading: boolean;
  error: string | null;
}) {
  const entries = state?.entries || [];
  const completedEntries = entries.filter((entry) => entry.ok !== false);
  const displayEntries = completedEntries.filter((entry) => {
    const action = String(entry.decision?.action || "").toUpperCase();
    const rationale = `${entry.decision?.rationale || ""} ${entry.assessment || ""}`;
    const recoveryLanguage = /\b(errors?|failed|failure|reverts?|reverted)\b/i.test(rationale);
    if (action === "SKIP" || action === "HOLD") return !recoveryLanguage;
    return true;
  });
  const hiddenRetryEntries = Math.max(0, entries.length - displayEntries.length);
  const latest = displayEntries[0] || completedEntries[0] || entries[0];
  const counts = state?.counts;
  const status = error
    ? "desk read needs review"
    : loading && !state
      ? "reading desk"
      : displayEntries.length
        ? "completed journal"
        : completedEntries.length
          ? "retry journal"
          : "waiting for first cycle";

  return (
    <section className="floatDeskJournal" id="desk-journal" aria-label="Shadow Float Desk journal">
      <div className="floatBoxHeader">
        <span>Float Desk journal</span>
        <small>{status}</small>
      </div>
      <div className="floatDeskIntro">
        <div>
          <strong>Autonomous desk decisions, constrained by contract policy.</strong>
          <p>
            The desk reads the live Float book, proposes pay, skip, hold, or repay actions, and the contract policy decides
            what can execute. This page shows completed decisions first; the raw Desk API keeps the full journal,
            including retries and recoveries. Desk activity is separated from external builder traction.
          </p>
          {hiddenRetryEntries > 0 && (
            <small className="floatDeskRetryNote">
              {hiddenRetryEntries} retry or recovery {hiddenRetryEntries === 1 ? "entry is" : "entries are"} visible in the raw API.
            </small>
          )}
        </div>
        <a href="/api/desk" target="_blank" rel="noreferrer">
          Desk API
        </a>
      </div>
      <div className="floatDeskStats">
        <FloatFact label="cycles" value={counts ? String(counts.cycles) : loading ? "reading" : "0"} />
        <FloatFact label="pays" value={counts ? String(counts.pays) : "0"} />
        <FloatFact label="settles" value={counts ? String(counts.settles || 0) : "0"} />
        <FloatFact label="skips" value={counts ? String(counts.skips + counts.holds) : "0"} />
        <FloatFact label="policy clamps" value={counts ? String(counts.clamps) : "0"} />
        <FloatFact label="latest" value={latest?.ts ? formatDeskTime(latest.ts) : loading ? "reading" : "pending"} />
      </div>
      {error ? (
        <div className="floatDeskEmpty">
          <strong>Desk journal read failed</strong>
          <span>{error}</span>
        </div>
      ) : displayEntries.length ? (
        <div className="floatDeskRows">
          {displayEntries.slice(0, 6).map((entry, index) => (
            <FloatDeskRow entry={entry} key={`${entry.cycle || index}-${entry.ts || "desk"}`} />
          ))}
        </div>
      ) : (
        <div className="floatDeskEmpty">
          <strong>{loading ? "Reading desk journal" : entries.length ? "Only retry entries are in the latest journal" : "Desk cycles have not been published yet"}</strong>
          <span>{entries.length ? "Open the raw Desk API for the full retry trail." : "Scheduled cycles will appear here after the workflow writes to the public journal."}</span>
        </div>
      )}
    </section>
  );
}

function FloatDeskRow({ entry }: { entry: FloatDeskEntry }) {
  const action = entry.decision?.action || "HOLD";
  const spend = entry.txs?.spend;
  const repay = entry.txs?.repay;
  const settle = entry.txs?.settle;
  const txHash = spend?.txHash || repay?.txHash || settle?.txHash;
  const amount = spend?.amountUSDC || repay?.amountUSDC || settle?.amountUSDC || entry.decision?.amountAtomic || "0";
  const reviewed = entry.reviews?.filter((review) => review.txHash).length || 0;
  const clamped = entry.decision?.wasClamped;
  const primaryText =
    action === "REPAY" && entry.assessment
      ? entry.assessment
      : entry.decision?.rationale || entry.bookNote || "Desk cycle recorded.";
  const secondaryText =
    action === "REPAY"
      ? clamped
        ? `policy clamped: ${entry.decision?.clampReasons?.join(", ") || "open debt discipline"}`
        : entry.bookNote || "line debt cleared"
      : entry.assessment ||
        (clamped ? `policy clamped: ${entry.decision?.clampReasons?.join(", ") || "yes"}` : entry.bookNote || "chain policy unchanged");

  return (
    <article className={`floatDeskRow ${String(action).toLowerCase()}${entry.ok === false ? " error" : ""}`}>
      <div className="floatDeskAction">
        <span>{formatDeskTime(entry.ts)}</span>
        <strong>{action}</strong>
        <small>{entry.decision?.provider || "policy"} · {formatFloatUSDC(amount)} USDC</small>
      </div>
      <div className="floatDeskReason">
        <strong>{primaryText}</strong>
        <small>{secondaryText}</small>
      </div>
      <div className="floatDeskProofs">
        {spend?.requestHash && (
          <a href={txHash ? txUrl(txHash) : "/api/desk"} target="_blank" rel="noreferrer">
            digest {shortHash(spend.requestHash)}
          </a>
        )}
        {txHash && (
          <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
            tx {shortAddress(txHash)}
          </a>
        )}
        {settle?.txHash && (
          <a href={txUrl(settle.txHash)} target="_blank" rel="noreferrer">
            settle {shortAddress(settle.txHash)}
          </a>
        )}
        {entry.txs?.ask?.queryId && <span>citepay {entry.txs.ask.queryId.slice(0, 8)}</span>}
        {reviewed > 0 && <span>reviewed {reviewed}</span>}
        {entry.error && <span>{entry.error}</span>}
      </div>
    </article>
  );
}








function asAtomicUSDC(value?: string | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}







function FloatMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`floatMetric${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function FloatFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="floatFact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatFloatUSDC(value?: string | bigint | null): string {
  if (value === undefined || value === null || value === "") return "0";
  try {
    const raw = typeof value === "bigint" ? value : BigInt(value);
    return formatUSDC(raw);
  } catch {
    return "0";
  }
}

function formatDeskTime(value?: string | null): string {
  if (!value) return "pending";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "pending";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shortHash(value?: string | null): string {
  if (!value || value.length < 14) return "pending";
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}



async function switchToArc() {
  if (!window.ethereum) return;
  const arcTestnetParams = arcTestnetWalletParameters();
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: arcTestnetParams.chainId }],
    });
  } catch (error: unknown) {
    const code = (error as { code?: number })?.code;
    const message = String((error as { message?: string })?.message || "").toLowerCase();
    if (code === 4902 || message.includes("unrecognized") || message.includes("add the chain")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [arcTestnetParams],
      });
      return;
    }
    throw error;
  }
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <article className="card">
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function Header({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="sectionHeader">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      num: "01",
      tone: "policy",
      title: "Choose a source agent",
      body: "Browse source reputation from real onchain receipts. CatArb, LobsterRisk, MomentumOtter, each with public copy and block history.",
    },
    {
      num: "02",
      tone: "policy",
      title: "Set delegation policy",
      body: "Deposit USDC into the router. Set max per intent, daily cap, allowed asset, and minimum slippage. Your rules sit onchain, not in a backend.",
    },
    {
      num: "03",
      tone: "outcome",
      title: "Copy or refuse every intent, onchain",
      body: "When the source agent publishes, Shadow either copies the swap or refuses it with an onchain receipt that names the exact policy field. No surprises, no off chain matcher.",
    },
  ];
  return (
    <section className="howItWorks">
      <p className="eyebrow">how Shadow works</p>
      <h2 className="howTitle">Three steps from picking a source to a verifiable receipt.</h2>
      <div className="howSteps">
        {steps.map((step) => (
          <div className={`howStep howStep--${step.tone}`} key={step.num}>
            <span>{step.num}</span>
            <strong>{step.title}</strong>
            <p>{step.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ManagePanel({
  sources,
  userBalance,
  userFollows,
  withdrawAmount,
  onWithdrawChange,
  onWithdraw,
  onUnfollow,
  managing,
}: {
  sources: SourceAgent[];
  userBalance: bigint;
  userFollows: Set<string>;
  withdrawAmount: string;
  onWithdrawChange: (value: string) => void;
  onWithdraw: () => Promise<void>;
  onUnfollow: (source: Address) => Promise<void>;
  managing: boolean;
}) {
  const followedSources = sources.filter((source) => userFollows.has(source.address.toLowerCase()));
  return (
    <section className="managePanel">
      <header className="sectionHeader">
        <p className="eyebrow">manage your follows</p>
        <h2>Withdraw idle balance or stop mirroring a source.</h2>
      </header>

      <div className="manageGrid">
        <div className="manageCard">
          <p className="eyebrow">router balance</p>
          <strong className="manageBalance">{formatUSDC(userBalance)} USDC</strong>
          <p className="manageHint">Pull idle USDC back to your wallet at any time. Mirroring stops only when the source publishes more intents than your balance covers.</p>
          <div className="depositRow">
            <input
              className="depositInput"
              type="text"
              inputMode="decimal"
              value={withdrawAmount}
              onChange={(event) => onWithdrawChange(event.target.value)}
              placeholder={formatUSDC(userBalance)}
              disabled={managing || userBalance === 0n}
            />
            <span className="depositUnit">USDC</span>
          </div>
          <div className="manageActions">
            <button
              className="manageButton"
              type="button"
              onClick={() => onWithdrawChange(formatUSDC(userBalance))}
              disabled={managing || userBalance === 0n}
            >
              max
            </button>
            <button
              className="manageButton primary"
              type="button"
              onClick={onWithdraw}
              disabled={managing || userBalance === 0n}
            >
              {managing ? "submitting…" : "withdraw"}
            </button>
          </div>
        </div>

        <div className="manageCard">
          <p className="eyebrow">followed sources</p>
          <strong className="manageBalance">{followedSources.length} active</strong>
          <p className="manageHint">Unfollow flips the policy to inactive. The router skips that source for any later intent until you follow again.</p>
          <div className="unfollowList">
            {followedSources.length === 0 && <span className="empty">No active policies on this wallet.</span>}
            {followedSources.map((source) => (
              <div className="unfollowRow" key={source.address}>
                <div className="unfollowMeta">
                  <strong>{source.name}</strong>
                  <span>{shortAddress(source.address)}</span>
                </div>
                <button
                  className="manageButton"
                  type="button"
                  onClick={() => onUnfollow(source.address)}
                  disabled={managing}
                >
                  unfollow
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}



function SpotlightCard({
  verdict,
  kind,
  label,
  follower,
  receipt,
  detail,
}: {
  verdict: "BLOCKED" | "COPIED";
  kind: "blocked" | "copied";
  label: string;
  follower: Address;
  receipt: ReceiptLog;
  detail: string;
}) {
  return (
    <article className={`spotlightCard ${kind}`}>
      <div className="spotlightCardStamp">
        <span className="spotlightCardStampMark">{kind === "copied" ? "✓" : "✕"}</span>
        <span className="spotlightCardStampText">{verdict}</span>
      </div>
      <p className="spotlightCardLabel">{label}</p>
      <p className="spotlightCardFollower">{shortAddress(follower)}</p>
      <dl className="spotlightStats">
        <div>
          <dt>amount</dt>
          <dd className="spotlightCardAmount">
            {kind === "copied" ? formatUSDC(receipt.usdcAmount) : "…"}
            {kind === "copied" && <span className="spotlightCardAmountUnit">USDC</span>}
          </dd>
        </div>
        {receipt.status === "copied" && (
          <div>
            <dt>asset out</dt>
            <dd>{formatAsset(receipt.assetAmountOut)} ARCETH</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.mirrorFeeUSDC > 0n && (
          <div>
            <dt>mirror fee</dt>
            <dd>{formatUSDC(receipt.mirrorFeeUSDC)} USDC</dd>
          </div>
        )}
        {receipt.status === "copied" && receipt.gatewaySettlement?.status === "settled" && (
          <div>
            <dt>Gateway</dt>
            <dd>{receipt.gatewaySettlement.feeUSDC} USDC settled</dd>
          </div>
        )}
        {receipt.status === "blocked" && (
          <div>
            <dt>rule fired</dt>
            <dd>{receipt.reason}</dd>
          </div>
        )}
      </dl>
      <p className="spotlightDetail">{detail}</p>
      <a className="spotlightLink" href={txUrl(receipt.transactionHash)} target="_blank" rel="noreferrer noopener">
        on-chain receipt · {shortAddress(receipt.transactionHash)} →
      </a>
    </article>
  );
}

function totalMirrored(receipts: ReceiptLog[]): bigint {
  return receipts.reduce((total, receipt) => total + receipt.usdcAmount, 0n);
}

function totalKickbacks(state: ShadowState | null): bigint {
  return state?.sources.reduce((total, source) => total + source.kickbackUSDC, 0n) || 0n;
}

function BuilderFeesBanner({ state }: { state: ShadowState | null }) {
  const totalFees = totalKickbacks(state);
  const sourceCount = state?.sources.length || 0;
  const topSource = useMemo(() => {
    if (!state) return null;
    return [...state.sources].sort((a, b) =>
      a.kickbackUSDC === b.kickbackUSDC ? 0 : a.kickbackUSDC < b.kickbackUSDC ? 1 : -1,
    )[0];
  }, [state]);
  return (
    <section className="builderFees">
      <div className="builderFeesMain">
        <p className="eyebrow">source fees accrued onchain</p>
        <h2>
          <span className="builderFeesAmount">{formatUSDC(totalFees)}</span>
          <span className="builderFeesUnit">USDC</span>
        </h2>
        <p className="builderFeesCaption">
          70% of every mirror fee accrues to the source agent that routed the flow, settled by{" "}
          <code>MirrorRouter</code> at the receipt event from {sourceCount === 1 ? "one source" : `${sourceCount} sources`}.
          No off-chain accounting.
        </p>
        <p className="builderFeesReference">
          Shadow calls these <strong>mirror fees</strong>: source agents that route useful intent flow earn a share of the routed fee at the same moment followers receive copied or blocked receipts.
        </p>
      </div>
      {topSource && totalFees > 0n && (
        <div className="builderFeesTop">
          <p>top earner</p>
          <strong>{topSource.name}</strong>
          <span>{formatUSDC(topSource.kickbackUSDC)} USDC</span>
        </div>
      )}
    </section>
  );
}

const PILOT_STAGES: Array<{ label: string; at: number }> = [
  { label: "Reading onchain reputation for every source agent", at: 0 },
  { label: "Asking deepseek to allocate your deposit across the best fits", at: 2.5 },
  { label: "Normalizing weights and matching presets to risk", at: 18 },
  { label: "Hashing decision and preparing onchain attestation", at: 22 },
];

function PilotThinking() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed((Date.now() - start) / 1000), 120);
    return () => clearInterval(id);
  }, []);
  const cappedPct = Math.min(95, (elapsed / 25) * 100);
  const activeIdx = PILOT_STAGES.reduce((acc, st, i) => (elapsed >= st.at ? i : acc), 0);
  return (
    <div className="pilotThinking" role="status" aria-live="polite">
      <div className="pilotThinkingHeader">
        <span className="pilotThinkingDot" />
        <strong>Pilot is reasoning</strong>
        <span className="pilotThinkingClock">{elapsed.toFixed(1)}s</span>
      </div>
      <div className="pilotThinkingBar">
        <span style={{ width: `${cappedPct}%` }} />
      </div>
      <ol className="pilotThinkingSteps">
        {PILOT_STAGES.map((st, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <li
              key={st.label}
              className={`pilotThinkingStep ${done ? "done" : ""} ${active ? "active" : ""}`}
            >
              <span className="pilotThinkingMark" aria-hidden>
                {done ? "✓" : active ? "" : ""}
              </span>
              <span>{st.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="pilotThinkingNote">
        Bankr LLM round trips take 20 to 25 seconds for structured allocations. Heuristic fallback runs if the model
        stalls.
      </p>
    </div>
  );
}

function PilotCard({
  amount,
  onAmountChange,
  risk,
  onRiskChange,
  plan,
  loading,
  error,
  executing,
  onRun,
  onExecute,
  sourcesCount,
}: {
  amount: string;
  onAmountChange: (v: string) => void;
  risk: PilotRisk;
  onRiskChange: (v: PilotRisk) => void;
  plan: PilotPlan | null;
  loading: boolean;
  error: string | null;
  executing: boolean;
  onRun: () => Promise<void>;
  onExecute: () => Promise<void>;
  sourcesCount: number;
}) {
  const riskOptions: Array<{ key: PilotRisk; label: string; sub: string }> = [
    { key: "low", label: "Low", sub: "Conservative slices, single source." },
    { key: "balanced", label: "Balanced", sub: "Diversify across 2 sources." },
    { key: "high", label: "High", sub: "Up to 3 sources, aggressive presets." },
  ];
  return (
    <section className="pilot" id="pilot">
      <header className="pilotHeader">
        <p className="eyebrow">AI pilot</p>
        <h2>Tell the AI your size and risk. It picks, weights, and watches.</h2>
        <p className="pilotLede">
          The Pilot reads every source agent's onchain reputation, allocates your USDC across the best fits, and writes
          watch signals you can act on. You stop manually picking and become a depositor with a goal.
        </p>
      </header>

      <div className="pilotControls">
        <label className="pilotField">
          <span>Deposit (USDC)</span>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder="1"
          />
        </label>
        <div className="pilotRiskGroup" role="radiogroup" aria-label="Risk profile">
          {riskOptions.map((opt) => (
            <button
              key={opt.key}
              className={`pilotRiskOption ${risk === opt.key ? "selected" : ""}`}
              onClick={() => onRiskChange(opt.key)}
              type="button"
              role="radio"
              aria-checked={risk === opt.key}
            >
              <strong>{opt.label}</strong>
              <span>{opt.sub}</span>
            </button>
          ))}
        </div>
        <button
          className="pilotRunBtn"
          onClick={onRun}
          disabled={loading || sourcesCount === 0}
          type="button"
        >
          {loading ? "asking the pilot…" : plan ? "regenerate plan" : "generate plan"}
        </button>
      </div>

      {loading && <PilotThinking />}

      {error && <div className="pilotError">pilot error: {error}</div>}

      {plan && (
        <div className="pilotPlan">
          <div className="pilotPlanHeader">
            <p className="pilotHeadline">{plan.headline}</p>
            <div className="pilotMeta">
              <span className="pilotConfidence">
                confidence <strong>{(plan.confidenceBps / 100).toFixed(0)}%</strong>
              </span>
              <span className="pilotModel">
                {plan.fellBack ? "heuristic fallback" : `model · ${plan.model}`}
              </span>
            </div>
          </div>

          <p className="pilotRationale">{plan.rationale}</p>

          <div className="pilotAllocation">
            {plan.allocation.map((slice) => (
              <article className="pilotSlice" key={slice.sourceAddress}>
                <header>
                  <strong>{slice.name}</strong>
                  <span className="pilotSlicePct">{(slice.weightBps / 100).toFixed(0)}%</span>
                </header>
                <div className="pilotSliceBar">
                  <span style={{ width: `${slice.weightBps / 100}%` }} />
                </div>
                <dl>
                  <div>
                    <dt>allocate</dt>
                    <dd>{slice.amountUSDC || "0"} USDC</dd>
                  </div>
                  <div>
                    <dt>preset</dt>
                    <dd className={`pilotPreset pilotPreset--${slice.preset}`}>{slice.preset}</dd>
                  </div>
                </dl>
                {slice.reason && <p className="pilotSliceReason">{slice.reason}</p>}
              </article>
            ))}
          </div>

          {plan.watchSignals.length > 0 && (
            <div className="pilotWatch">
              <p className="eyebrow">watch signals · the pilot will revisit if</p>
              <ul>
                {plan.watchSignals.map((sig, i) => (
                  <li key={i}>{sig}</li>
                ))}
              </ul>
            </div>
          )}

          <footer className="pilotFooter">
            <div className="pilotDecision">
              <span className="eyebrow">decision hash</span>
              <code>{plan.decisionHash}</code>
            </div>
            <button
              className="pilotExecBtn"
              onClick={onExecute}
              disabled={executing || plan.allocation.length === 0}
              type="button"
            >
              {executing ? "executing plan…" : "execute plan onchain"}
            </button>
          </footer>

          {plan.fellBack && plan.fellBackReason && (
            <p className="pilotFallbackNote">
              LLM unavailable ({plan.fellBackReason}); allocation produced by deterministic heuristic. Set
              BANKR_LLM_KEY to enable model reasoning.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type SourceHealth = {
  source: SourceAgent;
  status: "healthy" | "watch" | "stop";
  recentCopies: number;
  recentBlocks: number;
  recentCopyRateBps: number;
  recentPnlAvgBps: number | null;
  signals: string[];
};

const HEALTH_WINDOW = 8;

function assessFollowedSources(
  state: ShadowState,
  account: Address,
  userFollows: Set<string>,
): SourceHealth[] {
  const acct = account.toLowerCase();
  return state.sources
    .filter((src) => userFollows.has(src.address.toLowerCase()))
    .map((source) => {
      const srcKey = source.address.toLowerCase();
      const myReceipts = state.receipts
        .filter((r) => r.sourceAgent.toLowerCase() === srcKey && r.follower.toLowerCase() === acct)
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentCopies = myReceipts.filter((r) => r.status === "copied").length;
      const recentBlocks = myReceipts.filter((r) => r.status === "blocked").length;
      const totalRecent = recentCopies + recentBlocks;
      const recentCopyRateBps = totalRecent === 0 ? 0 : Math.round((recentCopies / totalRecent) * 10_000);

      const myCloses = state.positionCloses.filter(
        (c) => c.sourceAgent.toLowerCase() === srcKey && c.follower.toLowerCase() === acct,
      );
      const recentCloses = myCloses
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        .slice(0, HEALTH_WINDOW);
      const recentPnlAvgBps =
        recentCloses.length === 0
          ? null
          : Number(recentCloses.reduce((sum, c) => sum + c.pnlBps, 0n)) / recentCloses.length;

      const signals: string[] = [];
      let status: SourceHealth["status"] = "healthy";

      if (totalRecent === 0) {
        signals.push(`No recent receipts in the last ${HEALTH_WINDOW} intents for your wallet on this source.`);
      } else if (recentCopyRateBps < 5_000) {
        status = "watch";
        signals.push(
          `Only ${(recentCopyRateBps / 100).toFixed(0)}% of recent intents copied for your policy. Loosen minBpsOut or raise daily cap.`,
        );
      }
      if (recentPnlAvgBps !== null) {
        if (recentPnlAvgBps < -200) {
          status = "stop";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Consider unfollowing.`,
          );
        } else if (recentPnlAvgBps < 0) {
          status = "watch";
          signals.push(
            `Recent realized PnL is ${recentPnlAvgBps.toFixed(0)} bps over ${recentCloses.length} closes. Watch the next close.`,
          );
        }
      }

      return {
        source,
        status,
        recentCopies,
        recentBlocks,
        recentCopyRateBps,
        recentPnlAvgBps,
        signals,
      };
    });
}

function PilotMonitor({
  state,
  account,
  userFollows,
  plan,
  onRerun,
  loading,
}: {
  state: ShadowState;
  account: Address;
  userFollows: Set<string>;
  plan: PilotPlan | null;
  onRerun: () => Promise<void>;
  loading: boolean;
}) {
  const assessments = useMemo(
    () => assessFollowedSources(state, account, userFollows),
    [state, account, userFollows],
  );
  if (assessments.length === 0) return null;
  const anyWatch = assessments.some((a) => a.status !== "healthy");
  const planAge = plan ? Math.max(0, Math.floor(Date.now() / 1000) - plan.generatedAt) : null;
  return (
    <section className="pilotMonitor">
      <header className="pilotMonitorHeader">
        <div>
          <p className="eyebrow">AI monitor · fresh look at your follows</p>
          <h2>The pilot watches every source you follow against live state.</h2>
          <p className="pilotMonitorLede">
            Each card reweighs the last {HEALTH_WINDOW} intents and any closed positions touching your wallet. When a
            slice drifts off plan, the monitor flags it and offers a re evaluation that bakes the latest receipts back
            into the next pilot decision.
          </p>
        </div>
        <button
          className="pilotMonitorRerun"
          onClick={onRerun}
          disabled={loading}
          type="button"
        >
          {loading ? "re-evaluating…" : anyWatch ? "re-evaluate plan" : "ask for a fresh plan"}
        </button>
      </header>

      <div className="pilotMonitorGrid">
        {assessments.map((a) => (
          <article className={`pilotMonitorCard pilotMonitorCard--${a.status}`} key={a.source.address}>
            <header>
              <strong>{a.source.name}</strong>
              <span className={`pilotMonitorBadge pilotMonitorBadge--${a.status}`}>{statusLabel(a.status)}</span>
            </header>
            <dl>
              <div>
                <dt>recent copies</dt>
                <dd>
                  {a.recentCopies}
                  <span className="pilotMonitorMuted"> / {a.recentCopies + a.recentBlocks}</span>
                </dd>
              </div>
              <div>
                <dt>copy rate</dt>
                <dd>{a.recentCopies + a.recentBlocks === 0 ? "…" : `${(a.recentCopyRateBps / 100).toFixed(0)}%`}</dd>
              </div>
              <div>
                <dt>recent PnL avg</dt>
                <dd>{a.recentPnlAvgBps === null ? "…" : `${a.recentPnlAvgBps.toFixed(0)} bps`}</dd>
              </div>
            </dl>
            {a.signals.length > 0 && (
              <ul className="pilotMonitorSignals">
                {a.signals.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </div>

      {plan && planAge !== null && (
        <footer className="pilotMonitorFooter">
          <span>
            anchored plan ·{" "}
            <code>
              {plan.decisionHash.slice(0, 10)}…{plan.decisionHash.slice(-6)}
            </code>{" "}
            · {ageLabel(planAge)} ago · confidence {(plan.confidenceBps / 100).toFixed(0)}%
          </span>
        </footer>
      )}
    </section>
  );
}

function statusLabel(status: SourceHealth["status"]): string {
  if (status === "healthy") return "healthy";
  if (status === "watch") return "watch";
  return "stop";
}

function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function SplitMomentFallback() {
  return (
    <section className="spotlight spotlight--fallback" id="split">
      <p className="eyebrow">adapter one · same intent · two outcomes</p>
      <h2>One source intent lands. Policy decides whether capital moves.</h2>
      <p className="spotlightSummary">
        A source agent on Arc just published a 0.02 USDC intent. Two followers were watching with different rules.
        One had room. One didn&apos;t. This is the original receipt pattern now extended into Float and protocol mandates.
      </p>
      <div className="spotlightGrid">
        <article className="spotlightCard copied spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✓</span>
            <span className="spotlightCardStampText">COPIED</span>
          </div>
          <p className="spotlightCardLabel">Copied follower · policy let it through</p>
          <p className="spotlightCardFollower">0x7A3F…3AcD</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">0.02 <span className="spotlightCardAmountUnit">USDC</span></dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.05 USDC</dd>
            </div>
            <div>
              <dt>slippage rule</dt>
              <dd>≥ 70 bps out</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Within size, slippage, and daily cap. Swap went through, receipt on chain.</p>
        </article>
        <div className="spotlightVs" aria-hidden="true">
          <span className="spotlightVsLine" />
          <span className="spotlightVsLabel">VS</span>
          <span className="spotlightVsLine" />
        </div>
        <article className="spotlightCard blocked spotlightCard--demo">
          <div className="spotlightCardStamp">
            <span className="spotlightCardStampMark">✕</span>
            <span className="spotlightCardStampText">BLOCKED</span>
          </div>
          <p className="spotlightCardLabel">Blocked follower · policy refused</p>
          <p className="spotlightCardFollower">0x495c…8695</p>
          <dl className="spotlightStats">
            <div>
              <dt>amount</dt>
              <dd className="spotlightCardAmount">…</dd>
            </div>
            <div>
              <dt>max per intent</dt>
              <dd>0.01 USDC</dd>
            </div>
            <div>
              <dt>rule fired</dt>
              <dd>amount_too_high</dd>
            </div>
          </dl>
          <p className="spotlightDetail">Block receipt on chain, no debit. Follower stays exactly where they were.</p>
        </article>
      </div>
      <p className="spotlightFootnote">
        Live receipts populate this card once the next cron fires. The block reason on real receipts is whichever rule your
        policy hit first.
      </p>
    </section>
  );
}


function ShadowMark() {
  return (
    <svg className="shadowMark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2" className="shadowMarkBack" />
      <rect x="11" y="11" width="16" height="16" rx="2" className="shadowMarkFront" />
      <rect x="15" y="15" width="8" height="8" className="shadowMarkCore" />
    </svg>
  );
}

function SiteFooter() {
  const sections: Array<{ title: string; links: Array<{ label: string; href: string }> }> = [
    {
      title: "Product",
      links: [
        { label: "Home", href: "/" },
        { label: "Evidence", href: "/evidence" },
        { label: "Records", href: "/evidence#records" },
        { label: "Roadmap", href: "/roadmap" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "V2 source match", href: FLOAT_V2_PROOF.sourcify },
        { label: "V2 spend tx", href: txUrl(FLOAT_V2_PROOF.directSpendTx) },
        { label: "Arc explorer", href: "https://testnet.arcscan.app" },
      ],
    },
    {
      title: "Builders",
      links: [
        { label: "Builder guide", href: "/builders" },
        { label: "V2 live verifier", href: "https://github.com/buildwithshadow/shadow" },
        { label: "Source on GitHub", href: "https://github.com/buildwithshadow/shadow" },
      ],
    },
  ];

  return (
    <footer className="siteFooter">
      <div className="siteFooterTop">
        <div className="siteFooterBrand">
          <Link className="brand brandFooter" to="/" aria-label="Shadow">
            <ShadowMark />
            <span>Shadow</span>
          </Link>
          <p className="siteFooterTagline">
            Sponsor-backed USDC capacity for agents on Arc, with signed intents, provider payment, repayment, and blocked
            overruns.
          </p>
          <div className="siteFooterBadge">
            <span className="heroBadgeDot" />
            Public flow: Arc Testnet, chain 5042002. Controlled mainnet rehearsal is paused, chain 5042.
          </div>
        </div>
        <div className="siteFooterColumns">
          {sections.map((s) => (
            <div className="siteFooterColumn" key={s.title}>
              <span className="siteFooterColumnTitle">{s.title}</span>
              {s.links.map((l) => {
                if (l.href.startsWith("http") || l.href.startsWith("/api")) {
                  return (
                    <a key={l.label} href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  );
                }
                return (
                  <Link key={l.label} to={l.href}>
                    {l.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="siteFooterBottom">
        <span>Shadow Float and Circle USDC · 2026</span>
        <span>Shadow Float · spending lines, controls, and receipts on Arc</span>
      </div>
    </footer>
  );
}

function FloatV2ProofCockpit({
  state,
  loading,
  error,
}: {
  state: FloatV2ActivityState | null;
  loading: boolean;
  error: string | null;
}) {
  const summary = state?.summary;
  const showCount = (value: number | undefined) => (value === undefined ? (loading ? "reading" : "unavailable") : String(value));
  const showUSDC = (value?: string | bigint | null) =>
    value === undefined || value === null ? (loading ? "reading" : "unavailable") : `${formatFloatUSDC(value)} USDC`;
  const cards = [
    {
      label: "reserve",
      value: state?.totalSponsoredReserveUSDC ? `${formatFloatUSDC(state.totalSponsoredReserveUSDC)} USDC` : loading ? "reading" : "unavailable",
      title: "sponsor-backed capacity",
      body: "Reserved Arc USDC backs agent lines before a provider is paid.",
      tone: "copy",
    },
    {
      label: "intent",
      value: showCount(summary?.signedIntents),
      title: "bounded signatures",
      body: "Provider, endpoint, amount, nonce, expiry, executor, and max debt are checked onchain.",
      tone: "signal",
    },
    {
      label: "provider paid",
      value: showUSDC(summary?.providerPaidUSDC),
      title: "contract custody spend",
      body: "Float pays the named provider from reserve after the signed policy passes.",
      tone: "copy",
    },
    {
      label: "debt state",
      value: showUSDC(summary?.activeDebtUSDC),
      title: error ? "read needs review" : "repay or remain limited",
      body: "Closed loops restore capacity; the live open-debt line stays labeled until repayment.",
      tone: summary?.openDebtAgents ? "warn" : "copy",
    },
  ];

  return (
    <section className="floatProofCockpit" aria-label="Shadow Float V2 proof cockpit">
      <div className="floatProofCockpitHeader">
        <div>
          <span>proof cockpit</span>
          <strong>One live path: sponsor reserve → signed spend → provider paid → debt state.</strong>
        </div>
        <code>npm run float:v2-verify-live</code>
      </div>
      <div className="floatProofCockpitGrid">
        {cards.map((card) => (
          <article className={`floatProofCockpitCard ${card.tone}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <h3>{card.title}</h3>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TractionStrip({ state }: { state: ShadowState | null }) {
  const metrics = state?.lifetime;
  const recent = state?.recentWindow;

  const metricsList: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Follower wallets",
      value: metrics?.followerWallets.toLocaleString() ?? "0",
      sub: "since launch, snapshot-anchored",
    },
    {
      label: "USDC mirrored",
      value: metrics ? formatUSDC(metrics.mirroredUsdcAtomic) : "0",
      sub: `${metrics?.copied.toLocaleString() ?? "0"} copied · ${metrics?.blocked.toLocaleString() ?? "0"} blocked`,
    },
    {
      label: "Source agents",
      value: metrics?.sourceAgents.toLocaleString() ?? "0",
      sub: "registered source agents",
    },
    {
      label: "Receipts onchain",
      value: metrics?.receipts.toLocaleString() ?? "0",
      sub: "copy and block, no offchain truth",
    },
    {
      label: "Positions closed",
      value: metrics?.closedPositions.toLocaleString() ?? "0",
      sub: "realized close receipts",
    },
  ];

  const hasAnyTraction = Boolean(metrics && metrics.receipts > 0);

  if (!hasAnyTraction) {
    return null;
  }

  return (
    <section className="traction" aria-label="Live traction">
      <div className="tractionHeader">
        <p className="eyebrow">the full picture · lifetime floor plus live deltas</p>
        <span className="tractionDot" /> <span className="tractionLive">snapshot anchored</span>
      </div>
      <div className="tractionGrid">
        {metricsList.map((m) => (
          <article className="tractionCard" key={m.label}>
            <span className="tractionLabel">{m.label}</span>
            <strong className="tractionValue">{m.value}</strong>
            <span className="tractionSub">{m.sub}</span>
          </article>
        ))}
      </div>
      <p className="tractionFootnote">
        Lifetime totals use the May 24, 2026 submission snapshot as a floor, then add receipts after block{" "}
        {metrics?.snapshotBlock}. The live feed is intentionally recent-window only
        {recent
          ? ` (${recent.receipts.toLocaleString()} receipts from blocks ${recent.fromBlock}-${recent.toBlock}${
              recent.historyTruncated ? ", pruned history hidden" : ""
            })`
          : ""}
        .
      </p>
    </section>
  );
}

function TechnicalPrimitive({ state }: { state: ShadowState | null }) {
  const copiedReceipts = state?.receipts.filter((r) => r.status === "copied").length || 0;
  const blockedReceipts = state?.receipts.filter((r) => r.status === "blocked").length || 0;
  const closedPositions = state?.positionCloses.length || 0;
  const sourcesRegistered = state?.sources.length || 0;
  const cards = [
    {
      eyebrow: "primitive · per follower slippage",
      title: "Two outcomes, one transaction",
      body: "Every follower carries their own minBpsOut policy onchain. The router fans out one source intent and decides copy or block per follower in the same call. No cascade reverts, no off chain matcher.",
      metric: `${copiedReceipts} copied · ${blockedReceipts} blocked`,
      contract: "ShadowRouter.fanOut",
    },
    {
      eyebrow: "primitive · ERC 8004-style source reference",
      title: "Source agents are first class onchain",
      body: "Each source agent registers an onchain identity with a public address, name, and fee split. Reputation is computable from chain state alone, no centralized leaderboard.",
      metric: `${sourcesRegistered} source agent${sourcesRegistered === 1 ? "" : "s"} registered`,
      contract: "ShadowRegistry.registerSource",
    },
    {
      eyebrow: "primitive · canonical receipts",
      title: "MirrorReceipt is the source of truth",
      body: "Both copied and blocked outcomes emit onchain receipts with usdcAmount, minBps applied, and the kickback paid. Every decision is independently verifiable by reading chain state.",
      metric: `${copiedReceipts + blockedReceipts} receipts indexed`,
      contract: "MirrorReceipt event",
    },
    {
      eyebrow: "primitive · onchain PnL",
      title: "PositionClosed carries pnlBps",
      body: "When a follower closes a mirrored position, the router emits PositionClosed with the realized pnlBps. Source agent track records resolve directly from chain logs.",
      metric: `${closedPositions} position${closedPositions === 1 ? "" : "s"} closed`,
      contract: "PositionClosed event",
    },
  ];
  return (
    <section className="primitive" id="technical">
      <header className="primitiveHeader">
        <p className="eyebrow">why Shadow</p>
        <h2>The novelty is the reusable receipt engine, not the adapter.</h2>
        <p className="primitiveLede">
          The original router turns one AI intent into per-follower outcomes, but Shadow 2.0 carries the same pattern into
          float, x402 spend control, and protocol mandates. Every surface below is useful because it creates verifiable
          behavior that later capital can trust.
        </p>
      </header>
      <div className="primitiveGrid">
        {cards.map((card) => (
          <article className="primitiveCard" key={card.title}>
            <p className="eyebrow">{card.eyebrow}</p>
            <h3>{card.title}</h3>
            <p className="primitiveBody">{card.body}</p>
            <footer className="primitiveFooter">
              <span className="primitiveMetric">{card.metric}</span>
              <code className="primitiveContract">{card.contract}</code>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function LeptonM1Panel({
  state,
  loading,
  error,
  compact = false,
}: {
  state: LeptonState | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  const readConfigured = Boolean(isLeptonConfigured && state?.configured);
  const v4WriteReady = Boolean(state?.v4Readiness.writeReady);
  const addressRows = [
    { label: "MandateRegistry", value: leptonAddresses.mandateRegistry },
    { label: "MandateAttestor", value: leptonAddresses.mandateAttestor },
    { label: "BondedEnforcer", value: leptonAddresses.bondedEnforcer },
    { label: "Current read V4StyleArcAdapter", value: leptonAddresses.v4StyleAdapter },
    { label: "Current archival sink", value: state?.liquiditySink },
    { label: "MorphoStyleAdapter", value: leptonAddresses.morphoStyleAdapter },
    { label: "MorphoVaultSink", value: state?.morphoVaultSink },
  ];
  const proofSteps = [
    "Circle wallet is the scoped capital account",
    "MandateRegistry checks USDC, target, size, day cap, risk, expiry, and slippage",
    "MandateAttestor records ALLOW or BLOCK against the action hash",
    "Historical V4StyleArcAdapter proofs moved USDC only after an ALLOW receipt; the current read deployment is inactive for writes",
    "MandateVaultSink records the receipt-linked deposit",
    "The synchronous style adapters do not call commitAction; missing-receipt slashing is not active for these calls",
  ];
  const adapterSurfaces = [
    {
      name: "Uniswap v4-style swaps",
      status: v4WriteReady ? "write-ready" : "inactive",
      detail: state?.v4Readiness.userCopy || "Read configuration is separate from wallet write readiness.",
    },
    {
      name: "Morpho-style vault deposits",
      status: readConfigured && state?.morphoConfigured ? "historical proof readable" : "read pending",
      detail: "Morpho-style testnet proof only; this is not a real Morpho integration or a wallet-ready path.",
    },
  ];
  const circlePasskeyProof = {
    ...LEPTON_M1_DEPLOYMENTS.historicalProofs.circlePasskey,
    smartAccount: "0x6994ebdef63aa0e665e3c781ed54e2e181869a7a" as Address,
    mandateId: "2",
    amount: "0.01 USDC",
  };
  const morphoProof = {
    ...LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle,
    vault: LEPTON_M1_DEPLOYMENTS.historicalProofs.morphoStyle.sink,
    mandateId: "3",
  };
  const updated = state ? new Date(state.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <section className={`leptonPanel${compact ? " leptonPanelCompact" : ""}`} id="lepton-m1">
      <div className="leptonHeader">
        <div>
          <p className="eyebrow">Lepton M1 · protocol mandates</p>
          <h2>Mandates decide before USDC moves.</h2>
          <p className="leptonLede">
            The reusable primitive is simple: register a mandate, evaluate the action before USDC moves, write an ALLOW or
            BLOCK receipt, and keep the enforcer accountable across swap and vault-style adapters.
          </p>
        </div>
        <div className={`leptonStatus ${readConfigured ? "configured" : "pending"}`}>
          <span className="leptonStatusDot" />
          {readConfigured ? (v4WriteReady ? "live reads · write-ready" : "live reads · writes inactive") : "read pending"}
          {loading && <small>syncing</small>}
        </div>
      </div>

      <div className="leptonMetricGrid">
        <LeptonMetric label="mandates" value={readConfigured ? state!.mandateCount.toString() : "pending"} />
        <LeptonMetric label="receipts" value={readConfigured ? state!.receiptCount.toString() : "pending"} />
        <LeptonMetric label="current V4 bond" value={readConfigured ? `${formatUSDC(state!.adapterBondUSDC)} USDC` : "pending"} />
        <LeptonMetric
          label="vault bond"
          value={
            readConfigured && state!.morphoAdapterBondUSDC !== undefined
              ? `${formatUSDC(state!.morphoAdapterBondUSDC)} USDC`
              : "pending"
          }
        />
        <LeptonMetric label="minimum bond" value={readConfigured ? `${formatUSDC(state!.minBondUSDC)} USDC` : "pending"} />
        <LeptonMetric label="current V4 recorded" value={readConfigured ? formatUSDC(state!.executedUSDC) : "0"} tone="allow" />
        <LeptonMetric
          label="vault recorded"
          value={readConfigured && state!.vaultDepositedUSDC !== undefined ? formatUSDC(state!.vaultDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric
          label="morpho allowed"
          value={readConfigured && state!.morphoDepositedUSDC !== undefined ? formatUSDC(state!.morphoDepositedUSDC) : "pending"}
          tone="allow"
        />
        <LeptonMetric label="current V4 blocked" value={readConfigured ? formatUSDC(state!.blockedUSDC) : "0"} tone="block" />
        <LeptonMetric
          label="morpho blocked"
          value={readConfigured && state!.morphoBlockedUSDC !== undefined ? formatUSDC(state!.morphoBlockedUSDC) : "pending"}
          tone="block"
        />
      </div>

      <div className="leptonGrid">
        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>contracts</span>
            {updated && <small>updated {updated}</small>}
          </div>
          <div className="leptonAddressList">
            {addressRows.map((row) => (
              <div className="leptonAddressRow" key={row.label}>
                <span>{row.label}</span>
                <code>{row.value ? shortAddress(row.value) : "not deployed"}</code>
              </div>
            ))}
          </div>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>receipt chain</span>
            <small>{readConfigured ? `next #${state!.nextReceiptId.toString()}` : "waiting for reads"}</small>
          </div>
          <ol className="leptonProofList">
            {proofSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </article>

        <article className="leptonBox">
          <div className="leptonBoxHeader">
            <span>protocol adapters</span>
            <small>one mandate engine</small>
          </div>
          <div className="leptonSurfaceList">
            {adapterSurfaces.map((surface) => (
              <div className="leptonSurfaceRow" key={surface.name}>
                <div>
                  <strong>{surface.name}</strong>
                  <p>{surface.detail}</p>
                </div>
                <code>{surface.status}</code>
              </div>
            ))}
          </div>
        </article>
      </div>

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>{circlePasskeyProof.label}</span>
            <small>{circlePasskeyProof.generation} · sponsored UserOp</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Smart account</span>
              <code title={circlePasskeyProof.smartAccount}>{shortAddress(circlePasskeyProof.smartAccount)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{circlePasskeyProof.mandateId}</strong>
            </div>
            <div>
              <span>Historical adapter</span>
              <code title={circlePasskeyProof.v4StyleAdapter}>{shortAddress(circlePasskeyProof.v4StyleAdapter)}</code>
            </div>
            <div>
              <span>Allowed</span>
              <strong>{circlePasskeyProof.amount}</strong>
            </div>
            <div>
              <span>Tx</span>
              <a href={txUrl(circlePasskeyProof.txHash)} target="_blank" rel="noreferrer">
                {shortAddress(circlePasskeyProof.txHash)}
              </a>
            </div>
          </div>
          <p>
            On June 19, Circle Gas Station sponsored one passkey-owned account to approve USDC, create a Lepton mandate,
            and execute the historical <code>{shortAddress(circlePasskeyProof.v4StyleAdapter)}</code> adapter generation.
            This proof is not the current read deployment and is not reused for writes.
          </p>
        </article>
      )}

      {!compact && (
        <article className="leptonPasskeyProof">
          <div className="leptonBoxHeader">
            <span>{morphoProof.label}</span>
            <small>historical testnet record</small>
          </div>
          <div className="leptonProofFacts">
            <div>
              <span>Adapter</span>
              <code title={morphoProof.adapter}>{shortAddress(morphoProof.adapter)}</code>
            </div>
            <div>
              <span>Mandate</span>
              <strong>#{morphoProof.mandateId}</strong>
            </div>
            <div>
              <span>Allowed / blocked</span>
              <strong>
                {readConfigured && state!.morphoDepositedUSDC !== undefined && state!.morphoBlockedUSDC !== undefined
                  ? `${formatUSDC(state!.morphoDepositedUSDC)} / ${formatUSDC(state!.morphoBlockedUSDC)} USDC`
                  : "0.1 / 0.3 USDC"}
              </strong>
            </div>
            <div>
              <span>Txs</span>
              <a href={txUrl(morphoProof.allowTx)} target="_blank" rel="noreferrer">
                allow
              </a>
              {" / "}
              <a href={txUrl(morphoProof.blockTx)} target="_blank" rel="noreferrer">
                block
              </a>
            </div>
          </div>
          <p>
            This Morpho-style testnet proof used a vault-shaped sink: one deposit-shaped action moved USDC after an ALLOW
            receipt, and one oversized deposit wrote a BLOCK receipt without moving funds. It is not real Morpho.
          </p>
        </article>
      )}

      {error && <div className="leptonError">Lepton read failed: {error}</div>}

      {!compact && (
        <div className="leptonBoundaries">
          <span>v4-style adapter, not a claimed Uniswap hook</span>
          <span>Morpho-style adapter, not a claimed Morpho integration</span>
          <span>synchronous adapters do not call commitAction</span>
          <span>deterministic policy; no LLM override</span>
        </div>
      )}
    </section>
  );
}

function LeptonMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "allow" | "block";
}) {
  return (
    <article className={`leptonMetric${tone ? ` ${tone}` : ""}`}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  );
}

function CircleStackPanel() {
  return (
    <section id="circle-stack" className="circleStackPanel">
      <Header
        eyebrow="arc agentic workflow stack"
        title="Identity, settlement, controls, and the missing capital layer"
      />
      <p className="circleStackCaption">
        Arc&apos;s agentic workflow framing is agents that transact with identity, stablecoin settlement, and programmable
        controls. Shadow fits that lane and adds the capital primitive: sponsor-backed USDC capacity that can be drawn,
        repaid, blocked, and verified from receipts.
      </p>
      <div className="circleStackGrid">
        <article className="circleTierCard primary">
          <span>identity</span>
          <strong>Agent signer · bounded intent</strong>
          <p>The V2 line is bound to the wallet that signs the EIP-712 intent; capacity is visible before a sponsor pays.</p>
        </article>
        <article className="circleTierCard">
          <span>settlement</span>
          <strong>Arc USDC · direct provider pay</strong>
          <p>
            V2 pays the signed provider directly from contract custody. The payment rail is Arc USDC, with x402-style
            provider workflows layered above it.
          </p>
        </article>
        <article className="circleTierCard">
          <span>programmable controls</span>
          <strong>Provider · endpoint · max debt</strong>
          <p>Provider, endpoint hash, amount, max cumulative debt, nonce, expiry, and executor are enforced before funds move.</p>
        </article>
        <article className="circleTierCard">
          <span>capital layer</span>
          <strong>Sponsor reserve · debt · repay</strong>
          <p>Shadow&apos;s delta is reserved capacity: draw against sponsor-backed USDC, open debt, repay, or get blocked.</p>
        </article>
      </div>
    </section>
  );
}

type ModularWalletState =
  | { kind: "idle" }
  | { kind: "configMissing"; reason: string }
  | { kind: "registering" }
  | { kind: "loggingIn" }
  | { kind: "deriving" }
  | { kind: "ready"; address: Address; mode: "Register" | "Login" }
  | { kind: "funding"; address: Address }
  | { kind: "funded"; address: Address; tx?: string; alreadyFunded?: boolean }
  | { kind: "sending"; stage: string; address: Address }
  | { kind: "sent"; address: Address; userOpHash: string; txHash?: string; mode?: "follow" | "lepton"; mandateId?: bigint; amountUSDC?: bigint }
  | { kind: "error"; message: string; address?: Address };

const CREDENTIAL_STORAGE_KEY = "shadow:circleModularCredential";

const SOURCE_AGENTS: ReadonlyArray<{
  address: Address;
  name: string;
  tagline: string;
}> = [
  {
    address: "0xBDb1e0718EC6f6e2817c9cd4e5c5ed25Ac191Fb8" as Address,
    name: "CatArb",
    tagline: "spot arbitrage on USDC / ARCETH",
  },
  {
    address: "0xFF3BDb60E16538333C9A290BB80bE52b3b82D2f3" as Address,
    name: "LobsterRisk",
    tagline: "risk managed copy, tighter slippage",
  },
  {
    address: "0xe2f079d0aBe68a9CA0A9875e254fD976EaC0696B" as Address,
    name: "MomentumOtter",
    tagline: "LLM reasoned momentum, regime read per intent",
  },
];

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const mod = b64.length % 4;
  const padded = mod === 0 ? b64 : b64 + "=".repeat(4 - mod);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ModularWalletCard() {
  const clientKey = (import.meta.env.VITE_CIRCLE_CLIENT_KEY || "").trim();
  const clientUrl = (import.meta.env.VITE_CIRCLE_CLIENT_URL || "").trim();

  const initial: ModularWalletState =
    !clientKey || !clientUrl
      ? {
          kind: "configMissing",
          reason:
            "Set VITE_CIRCLE_CLIENT_KEY and VITE_CIRCLE_CLIENT_URL in your env (Circle Console → Modular Wallets) to enable passkey onboarding + Gas Station.",
        }
      : { kind: "idle" };

  const [state, setState] = useState<ModularWalletState>(initial);
  const [leptonWriteReadiness, setLeptonWriteReadiness] = useState<LeptonV4Readiness | null>(null);
  const [selectedSourceIndex, setSelectedSourceIndex] = useState(0);
  const selectedSource = SOURCE_AGENTS[selectedSourceIndex];

  useEffect(() => {
    let cancelled = false;
    fetchLeptonV4Readiness().then((readiness) => {
      if (!cancelled) setLeptonWriteReadiness(readiness);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [followerPolicy, setFollowerPolicy] = useState<{
    active: boolean;
    maxPerIntent: bigint;
    dailyCap: bigint;
    spentToday: bigint;
  } | null>(null);

  const trackedAddress: Address | undefined = (state as any).address;
  useEffect(() => {
    if (!trackedAddress || !addresses.router) {
      setFollowerPolicy(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const policy = (await publicClient.readContract({
          address: addresses.router!,
          abi: routerAbi,
          functionName: "getPolicy",
          args: [trackedAddress, selectedSource.address],
        })) as readonly [bigint, bigint, Address, number, number, bigint, bigint, boolean];
        if (cancelled) return;
        setFollowerPolicy({
          active: policy[7],
          maxPerIntent: policy[0],
          dailyCap: policy[1],
          spentToday: policy[5],
        });
      } catch {
        if (!cancelled) setFollowerPolicy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trackedAddress, state.kind, selectedSource.address]);

  useEffect(() => {
    if (state.kind !== "ready" || !addresses.usdc) return;
    const addr = state.address;
    let cancelled = false;
    void (async () => {
      try {
        const balance = (await publicClient.readContract({
          address: addresses.usdc!,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [addr],
        })) as bigint;
        if (cancelled) return;
        if (balance >= parseUnits("0.04", 6)) {
          setState({ kind: "funded", address: addr, alreadyFunded: true });
        }
      } catch {
        // leave state as ready; user can still click Fund manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.kind, (state as any).address]);

  async function loadCredential(): Promise<WebAuthnCredential | null> {
    try {
      const raw =
        localStorage.getItem(CREDENTIAL_STORAGE_KEY) ??
        sessionStorage.getItem(CREDENTIAL_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as WebAuthnCredential;
    } catch {
      return null;
    }
  }

  function persistCredential(cred: WebAuthnCredential) {
    try {
      localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
    } catch {
      try {
        sessionStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(cred));
      } catch {
        // Both stores blocked (private mode + quota). Credential reconstructable via Login.
      }
    }
  }

  async function withSmartAccount(cred: WebAuthnCredential) {
    const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createClient({
      chain: arcTestnet,
      transport: modularTransport,
    }) as any;
    const owner = toWebAuthnAccount({ credential: cred, rpId: cred.rpId });
    const smartAccount = await toCircleSmartAccount({ client, owner });
    const bundler = createBundlerClient({
      account: smartAccount,
      chain: arcTestnet,
      transport: modularTransport,
      paymaster: true,
      paymasterContext: {},
      userOperation: {
        estimateFeesPerGas: async () => {
          const prices: any = await getUserOperationGasPrice(client);
          const tier = prices?.medium ?? prices?.high ?? prices?.low;
          return {
            maxFeePerGas: BigInt(tier.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(tier.maxPriorityFeePerGas),
          };
        },
      },
    } as any);
    return { smartAccount, bundler };
  }

  async function onRegister() {
    setState({ kind: "registering" });
    let restoreCreate: (() => void) | null = null;
    try {
      const existing = await loadCredential();
      let excludeId: Uint8Array | null = null;
      if (existing?.id) {
        try {
          excludeId = base64UrlToBytes(existing.id);
        } catch {
          excludeId = null;
        }
      }
      if (excludeId) {
        const originalCreate = navigator.credentials.create.bind(
          navigator.credentials,
        );
        const id = excludeId;
        (navigator.credentials as any).create = async (opts: any) => {
          if (opts?.publicKey) {
            opts.publicKey.excludeCredentials = [
              ...(opts.publicKey.excludeCredentials ?? []),
              { type: "public-key", id },
            ];
          }
          return originalCreate(opts);
        };
        restoreCreate = () => {
          (navigator.credentials as any).create = originalCreate;
        };
      }

      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode: WebAuthnMode.Register,
        username: `shadow-${Date.now()}`,
      });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Register" });
    } catch (err: any) {
      const msg = err?.message || String(err);
      const name = err?.name || "";
      const explicitDuplicate =
        name === "InvalidStateError" ||
        /InvalidStateError|already.*passkey|already.*registered|already.*enrolled/i.test(
          msg,
        );
      const browserDedupCloak =
        name === "NotAllowedError" ||
        /timed out or was not allowed|talking to the credential manager|operation.*not allowed/i.test(
          msg,
        );
      const blockedByExisting =
        restoreCreate !== null && (explicitDuplicate || browserDedupCloak);
      setState({
        kind: "error",
        message: blockedByExisting
          ? "This device already has a Shadow passkey (or the prompt was cancelled). Tap Login to use the existing passkey, or register from a different device for a new account."
          : explicitDuplicate
            ? "This device already has a Shadow passkey. Tap Login to use it, or register from a different device for a new account."
            : msg,
      });
    } finally {
      restoreCreate?.();
    }
  }

  async function onLogin() {
    setState({ kind: "loggingIn" });
    try {
      const stored = await loadCredential();
      const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
      const credential = stored
        ? stored
        : await toWebAuthnCredential({
            transport: passkeyTransport,
            mode: WebAuthnMode.Login,
          });
      persistCredential(credential);
      setState({ kind: "deriving" });
      const { smartAccount } = await withSmartAccount(credential);
      setState({ kind: "ready", address: smartAccount.address, mode: "Login" });
    } catch (err: any) {
      setState({ kind: "error", message: err?.message || String(err) });
    }
  }

  async function onFund() {
    const addr =
      state.kind === "ready" || state.kind === "funded" || state.kind === "sent" || state.kind === "error"
        ? (state as any).address
        : undefined;
    if (!addr) return;
    setState({ kind: "funding", address: addr });
    try {
      const demoCode = ((import.meta as any).env?.VITE_SHADOW_DEMO_CODE as string | undefined) || "";
      const res = await fetch("/api/fund-smart-account", {
        method: "POST",
        headers: { "content-type": "application/json", "x-shadow-demo-code": demoCode },
        body: JSON.stringify({ address: addr, demoCode }),
      });
      const json = (await res.json()) as {
        funded?: boolean;
        skipped?: boolean;
        cached?: boolean;
        tx?: string;
        previousTx?: string;
        error?: string;
      };
      if (!res.ok || json.error) {
        throw new Error(json.error || `fund failed (HTTP ${res.status})`);
      }
      setState({
        kind: "funded",
        address: addr,
        tx: json.tx || json.previousTx,
        alreadyFunded: Boolean(json.skipped || json.cached),
      });
    } catch (err: any) {
      setState({
        kind: "error",
        message: err?.shortMessage || err?.message || "fund failed",
        address: addr,
      });
    }
  }

  async function onSponsoredFollow() {
    if (state.kind !== "ready" && state.kind !== "funded") return;
    const accountAddress = state.address;
    if (!addresses.router || !addresses.usdc || !addresses.arceth) {
      setState({
        kind: "error",
        message: "Shadow router/usdc/arceth env not set; cannot onboard follower.",
        address: accountAddress,
      });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding follow batch", address: accountAddress });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const depositAmount = parseUnits("0.04", 6);
      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9500;
      const maxRiskLevel = 2;

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [addresses.router as Address, depositAmount],
      });
      const depositData = encodeFunctionData({
        abi: routerAbi,
        functionName: "depositUSDC",
        args: [depositAmount],
      });
      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor", address: accountAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: addresses.router as Address, value: 0n, data: depositData },
          { to: addresses.router as Address, value: 0n, data: followData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: accountAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: accountAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "follow",
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      const raw = parts.join(" | ") || String(err);
      console.error("[sponsoredFollow] full error chain", err);
      const insufficient = /transfer amount exceeds balance|insufficient.*balance/i.test(raw);
      setState({
        kind: "error",
        message: insufficient
          ? `Smart account needs USDC first. Click "Fund smart account" (deployer sends 0.05 USDC) and retry.`
          : raw,
        address: accountAddress,
      });
    }
  }

  async function onSponsoredLeptonMandate() {
    const accountAddress = (state as any).address as Address | undefined;
    const mandateRegistry = leptonAddresses.mandateRegistry;
    const v4StyleAdapter = leptonAddresses.v4StyleAdapter;
    if (!accountAddress || state.kind === "funding" || state.kind === "sending") return;
    if (!addresses.usdc || !isLeptonConfigured || !mandateRegistry || !v4StyleAdapter) {
      setState({
        kind: "error",
        message: "Lepton registry/adapter/usdc addresses are not configured.",
        address: accountAddress,
      });
      return;
    }

    setState({ kind: "sending", stage: "loading passkey credential", address: accountAddress });
    try {
      const readiness = await fetchLeptonV4Readiness();
      setLeptonWriteReadiness(readiness);
      await runLeptonWalletAction(readiness, async () => {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      const { smartAccount, bundler } = await withSmartAccount(credential);
      const smartAddress = smartAccount.address as Address;
      const amountUSDC = parseUnits("0.01", 6);
      const dailyCap = parseUnits("0.02", 6);

      setState({ kind: "sending", stage: "checking passkey USDC balance", address: smartAddress });
      const balance = (await publicClient.readContract({
        address: addresses.usdc as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAddress],
      })) as bigint;
      if (balance < amountUSDC) {
        throw new Error(`Smart account needs at least ${formatUSDC(amountUSDC)} USDC. Click "Fund smart account" and retry.`);
      }

      setState({ kind: "sending", stage: "reading next mandate id", address: smartAddress });
      const mandateId = (await publicClient.readContract({
        address: mandateRegistry,
        abi: mandateRegistryAbi,
        functionName: "nextMandateId",
      })) as bigint;
      const now = Math.floor(Date.now() / 1000);

      const approveData = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [v4StyleAdapter, amountUSDC],
      });
      const createMandateData = encodeFunctionData({
        abi: mandateRegistryAbi,
        functionName: "createMandate",
        args: [
          smartAddress,
          addresses.usdc as Address,
          v4StyleAdapter,
          1,
          amountUSDC,
          dailyCap,
          3,
          9_900,
          keccak256(stringToBytes(`shadow-lepton-passkey-${smartAddress}-${now}`)),
        ],
      });
      const actionData = encodeFunctionData({
        abi: v4StyleArcAdapterAbi,
        functionName: "beforeSwapStyleAction",
        args: [
          {
            mandateId,
            actor: smartAddress,
            circleAccount: smartAddress,
            settlementAsset: addresses.usdc as Address,
            target: v4StyleAdapter,
            actionType: 1,
            amountUSDC,
            riskLevel: 2,
            minBpsOut: 9_950,
            expiry: BigInt(now + 86_400),
            intentHash: keccak256(stringToBytes(`shadow-lepton-passkey-allow-${now}`)),
            executionRef: keccak256(stringToBytes("circle-passkey-lepton-allow")),
          },
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor Lepton batch", address: smartAddress });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [
          { to: addresses.usdc as Address, value: 0n, data: approveData },
          { to: mandateRegistry, value: 0n, data: createMandateData },
          { to: v4StyleAdapter, value: 0n, data: actionData },
        ],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for Lepton receipt", address: smartAddress });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({
        kind: "sent",
        address: smartAddress,
        userOpHash,
        txHash: receipt?.receipt?.transactionHash,
        mode: "lepton",
        mandateId,
        amountUSDC,
      });
      });
    } catch (err: any) {
      const parts: string[] = [];
      let current: any = err;
      let depth = 0;
      while (current && depth < 8) {
        const msg = current.shortMessage || current.message;
        if (msg && !parts.includes(msg)) parts.push(msg);
        if (current.details && typeof current.details === "string" && !parts.includes(current.details)) {
          parts.push(current.details);
        }
        if (current.metaMessages && Array.isArray(current.metaMessages)) {
          for (const m of current.metaMessages) {
            if (typeof m === "string" && !parts.includes(m)) parts.push(m);
          }
        }
        current = current.cause;
        depth += 1;
      }
      console.error("[sponsoredLeptonMandate] full error chain", err);
      setState({
        kind: "error",
        message: parts.join(" | ") || String(err),
        address: accountAddress,
      });
    }
  }

  async function onTunePolicy() {
    const addr = (state as any).address as Address | undefined;
    if (!addr) return;
    if (!addresses.router || !addresses.arceth) {
      setState({ kind: "error", message: "router/arceth env not set", address: addr });
      return;
    }
    setState({ kind: "sending", stage: "loading passkey credential", address: addr });
    try {
      const credential = await loadCredential();
      if (!credential) throw new Error("Passkey credential missing. Log in again.");
      setState({ kind: "sending", stage: "encoding looser minBpsOut", address: addr });
      const { smartAccount, bundler } = await withSmartAccount(credential);

      const maxAmountPerIntent = parseUnits("0.02", 6);
      const dailyCap = parseUnits("0.04", 6);
      const minBpsOut = 9000;
      const maxRiskLevel = 2;

      const followData = encodeFunctionData({
        abi: routerAbi,
        functionName: "followSource",
        args: [
          selectedSource.address,
          maxAmountPerIntent,
          dailyCap,
          addresses.arceth as Address,
          maxRiskLevel,
          minBpsOut,
        ],
      });

      setState({ kind: "sending", stage: "asking Circle Gas Station to sponsor tune", address: addr });
      const userOpHash = (await (bundler as any).sendUserOperation({
        account: smartAccount,
        calls: [{ to: addresses.router as Address, value: 0n, data: followData }],
        paymaster: true,
      })) as `0x${string}`;
      setState({ kind: "sending", stage: "waiting for receipt", address: addr });
      const receipt = await (bundler as any).waitForUserOperationReceipt({ hash: userOpHash });
      setState({ kind: "sent", address: addr, userOpHash, txHash: receipt?.receipt?.transactionHash });
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error("[tunePolicy] error", err);
      setState({ kind: "error", message: msg, address: addr });
    }
  }

  return (
    <div className="modularCard">
      <div className="modularHeader">
        <span className="modularBadge">Modular Wallets · MSCA · ERC-4337</span>
        <h3>One click follower onboarding, gas sponsored by Circle</h3>
      </div>
      {followerPolicy && (
        <div className="modularStatusRow">
          <span className={followerPolicy.active ? "modularChipOk" : "modularChipMuted"}>
            Sponsored onboards: {followerPolicy.active ? 1 : 0}
          </span>
          {followerPolicy.active && (
            <>
              <span className="modularChipOk">Following {selectedSource.name}</span>
              <span className="modularChipMuted">0 ETH gas from your wallet</span>
            </>
          )}
        </div>
      )}
      {state.kind === "configMissing" ? (
        <p className="modularEmpty">{(state as any).reason}</p>
      ) : (
        <>
          <p className="modularBody">
            Create a Circle MSCA owned by your device passkey, fund it with 0.05
            USDC (one click below), then approve, deposit, and call{" "}
            <code>followSource</code> on the source agent you pick in a single batched
            UserOp with <code>paymaster: true</code>. The smart account becomes a real
            Shadow follower with its own minBpsOut policy. Circle Gas Station pays the
            gas, so a new follower can start mirroring on Arc without ever holding
            native gas first.
          </p>
          <div className="modularButtons">
            <button
              type="button"
              className="modularBtnPrimary"
              onClick={onRegister}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "registering" ? "Registering…" : "Register passkey"}
            </button>
            <button
              type="button"
              className="modularBtnSecondary"
              onClick={onLogin}
              disabled={state.kind === "registering" || state.kind === "loggingIn" || state.kind === "deriving" || state.kind === "sending"}
            >
              {state.kind === "loggingIn" ? "Logging in…" : "Login with passkey"}
            </button>
          </div>
          {state.kind === "deriving" && <p className="modularInfo">Deriving smart account address…</p>}
          {(state.kind === "ready" ||
            state.kind === "funding" ||
            state.kind === "funded" ||
            state.kind === "sending" ||
            state.kind === "sent" ||
            (state.kind === "error" && (state as any).address)) && (
            <div className="modularAccount">
              <p>
                <span>Smart account</span>{" "}
                <code title={(state as any).address}>{(state as any).address}</code>{" "}
                <button
                  type="button"
                  className="modularCopyBtn"
                  onClick={() => navigator.clipboard?.writeText((state as any).address)}
                  title="Copy address"
                >
                  copy
                </button>
              </p>
              <div className="modularSourcePicker">
                <span className="modularSourcePickerLabel">Source agent:</span>
                {SOURCE_AGENTS.map((src, i) => (
                  <button
                    key={src.address}
                    type="button"
                    className={
                      i === selectedSourceIndex
                        ? "modularBtnPrimary"
                        : "modularBtnSecondary"
                    }
                    onClick={() => setSelectedSourceIndex(i)}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                    title={src.tagline}
                  >
                    {src.name}
                  </button>
                ))}
              </div>
              <div className="modularButtons">
                <button
                  type="button"
                  className="modularBtnSecondary"
                  onClick={onFund}
                  disabled={state.kind === "funding" || state.kind === "sending"}
                >
                  {state.kind === "funding"
                    ? "Funding…"
                    : state.kind === "funded"
                      ? state.alreadyFunded
                        ? "Already funded ✓"
                        : "Funded ✓, re-fund"
                      : "Fund smart account (0.05 USDC)"}
                </button>
                {followerPolicy?.active ? (
                  <span className="modularChipOk modularAlreadyFollowing">
                    Already following {selectedSource.name} ✓
                  </span>
                ) : (
                  <button
                    type="button"
                    className="modularBtnPrimary"
                    onClick={onSponsoredFollow}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Following… ${state.stage}`
                      : `Follow ${selectedSource.name} (approve, deposit, followSource, sponsored)`}
                  </button>
                )}
                {(followerPolicy?.active || state.kind === "sent") && (
                  <button
                    type="button"
                    className="modularBtnSecondary"
                    onClick={onTunePolicy}
                    disabled={state.kind === "sending" || state.kind === "funding"}
                  >
                    {state.kind === "sending"
                      ? `Updating slippage… ${state.stage}`
                      : "Accept up to 10% slippage (was 5%, sponsored)"}
                  </button>
                )}
                <button
                  type="button"
                  className="modularBtnPrimary"
                  onClick={onSponsoredLeptonMandate}
                  disabled={state.kind === "sending" || state.kind === "funding" || !leptonWriteReadiness?.writeReady}
                  title={leptonWriteReadiness?.userCopy || "Checking V4 write readiness. No wallet request will be made until every check passes."}
                >
                  {state.kind === "sending"
                    ? `Lepton… ${state.stage}`
                    : leptonWriteReadiness?.writeReady
                      ? "Run Lepton mandate action (sponsored)"
                      : "V4 wallet action inactive"}
                </button>
              </div>
              {!leptonWriteReadiness?.writeReady && (
                <p className="modularInfo">
                  {leptonWriteReadiness?.userCopy || "Checking V4 readiness. No wallet request will be made."}
                </p>
              )}
              {state.kind === "funded" && state.tx && (
                <p className="modularInfo">
                  Faucet tx{" "}
                  <a href={txUrl(state.tx as `0x${string}`)} target="_blank" rel="noreferrer">
                    {state.tx.slice(0, 10)}…
                  </a>
                  . Now click follow {selectedSource.name}. Circle Gas Station
                  sponsors all three calls in one batched UserOp.
                </p>
              )}
            </div>
          )}
          {state.kind === "sent" && (
            <p className="modularOk">
              <strong>Zero gas paid by your wallet.</strong>{" "}
              {state.mode === "lepton" ? (
                <>
                  Circle Gas Station sponsored the Lepton batch: approve USDC,
                  create mandate #{state.mandateId?.toString()}, then execute{" "}
                  {state.amountUSDC ? formatUSDC(state.amountUSDC) : "0.01"} USDC
                  through the bonded adapter with an ALLOW receipt and vault record.{" "}
                </>
              ) : (
                <>
                  Circle Gas Station sponsored the entire batched UserOp (approve + deposit +
                  followSource). Smart account is now a live {selectedSource.name}{" "}
                  follower with its own minBpsOut policy.{" "}
                </>
              )}
              {state.txHash ? (
                <a href={txUrl(state.txHash as `0x${string}`)} target="_blank" rel="noreferrer">
                  view batched tx
                </a>
              ) : (
                <span>UserOp hash: <code>{state.userOpHash.slice(0, 10)}…</code></span>
              )}
            </p>
          )}
          {state.kind === "error" && <p className="modularErr">{state.message}</p>}
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    {window.location.pathname.replace(/\/$/, "") === "/wallet-check" ? <CircleWalletDiagnostic /> : <App />}
  </BrowserRouter>
);
