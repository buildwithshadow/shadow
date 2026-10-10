import assert from "node:assert/strict";
import test from "node:test";
import {
  fundingStep,
  guardedFundingStep,
  validAgent,
  budgetIssue,
  readFundingDraft,
  writeFundingDraft,
} from "../src/fundingJourney.ts";
import type { CandidateOpenInput } from "../src/candidateFunding.ts";
const agent = "0x2222222222222222222222222222222222222222";
const form: CandidateOpenInput = {
  agent,
  provider: "0x3333333333333333333333333333333333333333",
  endpoint: "https://example.com/service",
  reserve: "0.10",
  lineSpendCap: "0.15",
  dailySpendCap: "0.10",
  providerPerSpendCap: "0.05",
  providerDailyCap: "0.10",
  expiryDays: "7",
  repaymentHours: "24",
};

test("old shared agent and line links open the appropriate journey", () => {
  assert.equal(fundingStep("/start", ""), "home");
  assert.equal(fundingStep("/start", `?agent=${agent}`), "wallet");
  assert.equal(fundingStep("/start", "?role=agent"), "line");
  assert.equal(fundingStep("/start", "?line=0xabc"), "line");
  assert.equal(fundingStep("/start/budget/", `?agent=${agent}`), "budget");
  assert.equal(fundingStep("/start/unknown", ""), "home");
});

test("deep funding links cannot skip connection, network, registration or agent selection", () => {
  const ready = {
    connected: true,
    correctNetwork: true,
    registered: true,
    agent,
  };
  assert.equal(
    guardedFundingStep("fund", { ...ready, connected: false }),
    "wallet",
  );
  assert.equal(
    guardedFundingStep("fund", { ...ready, correctNetwork: false }),
    "wallet",
  );
  assert.equal(
    guardedFundingStep("fund", { ...ready, registered: false }),
    "register",
  );
  assert.equal(guardedFundingStep("fund", { ...ready, agent: "" }), "agent");
  assert.equal(guardedFundingStep("fund", ready), "fund");
  assert.equal(
    guardedFundingStep("line", { ...ready, connected: false }),
    "line",
  );
  assert.equal(
    guardedFundingStep("purchase", { ...ready, registered: false }),
    "purchase",
    "an agent does not have to register as a sponsor",
  );
});

test("a same-wallet rehearsal is valid and a zero address is not", () => {
  assert.equal(validAgent(agent), true);
  assert.equal(validAgent("0x0000000000000000000000000000000000000000"), false);
  assert.equal(validAgent("an agent name"), false);
});

test("budget precision and one purchase fitting all configured limits are enforced", () => {
  assert.equal(budgetIssue(form), null);
  for (const reserve of ["0", "-1", "1e3", "0.0000001", "NaN"])
    assert.ok(budgetIssue({ ...form, reserve }));
  for (const key of [
    "reserve",
    "lineSpendCap",
    "dailySpendCap",
    "providerDailyCap",
  ])
    assert.match(budgetIssue({ ...form, [key]: "0.01" })!, /fit/);
  assert.ok(budgetIssue({ ...form, expiryDays: "1.5" }));
  assert.ok(budgetIssue({ ...form, repaymentHours: "0" }));
  assert.ok(budgetIssue({ ...form, repaymentHours: "1" }));
  assert.ok(budgetIssue({ ...form, expiryDays: "8" }));
  assert.match(
    budgetIssue(
      { ...form, repaymentHours: "24" },
      { minimumRepaymentWindow: 3600n, maximumRepaymentWindow: 7200n },
    )!,
    /between 2 and 2/,
  );
});

test("draft round trip restores input only, never approval, provider config or transaction state", () => {
  const saved = JSON.parse(writeFundingDraft(form));
  saved.form.provider = "0x4444444444444444444444444444444444444444";
  saved.form.endpoint = "https://untrusted.invalid";
  saved.form.providerAgreed = true;
  saved.form.pending = { kind: "open" };
  const restored = readFundingDraft(JSON.stringify(saved), form);
  assert.deepEqual(restored, form);
  const serialized = writeFundingDraft(form);
  assert.doesNotMatch(serialized, /providerAgreed|endpoint|pending|signature/);
});

test("corrupt, oversized and wrong-version drafts cannot replace deployment defaults", () => {
  for (const raw of [
    null,
    "broken json",
    "{}",
    JSON.stringify({ version: 2, form }),
    "x".repeat(4097),
  ])
    assert.deepEqual(readFundingDraft(raw, form), form);
  assert.equal(
    readFundingDraft(
      JSON.stringify({
        version: 1,
        form: { reserve: 12, agent: "x".repeat(101) },
      }),
      form,
    ).agent,
    agent,
  );
});
