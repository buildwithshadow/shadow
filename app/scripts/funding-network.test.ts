import assert from "node:assert/strict";
import test from "node:test";
import { selectedFundingNetwork, fundingNetworkDestination } from "../src/fundingNetwork.ts";

test("home advertises mainnet only when that release is enabled", () => {
  assert.equal(selectedFundingNetwork("/", "", true), "mainnet");
  assert.equal(selectedFundingNetwork("/", "?network=testnet", true), "testnet");
  assert.equal(selectedFundingNetwork("/", "?network=mainnet", false), "testnet");
});

test("existing shared testnet links remain testnet regardless of a network query", () => {
  for (const path of ["/start", "/start/", "/start/fund", "/start/purchase", "/funding", "/guarded-testnet"]) {
    assert.equal(selectedFundingNetwork(path, "?network=mainnet&line=0xabc", true), "testnet");
  }
  assert.equal(selectedFundingNetwork("/mainnet", "?network=testnet", true), "mainnet");
});

test("changing networks starts a separate flow without a carried line or authorization", () => {
  assert.equal(fundingNetworkDestination("mainnet"), "/mainnet");
  assert.equal(fundingNetworkDestination("testnet"), "/start");
  assert.equal(fundingNetworkDestination("testnet", true), "/?network=testnet");
});
