import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, stringToBytes } from "viem";
import { migrateShadowUrl, resolveShadowProvider } from "../shadowUrls.js";

const legacyProvider = "https://shadow-arc.vercel.app/api/reasoning-x402";
const currentProvider = "https://www.shadowbuild.xyz/api/reasoning-x402";
const hash = (label) => keccak256(stringToBytes(label));

test("default and migrated provider settings retain the existing mandate hash", () => {
  for (const configured of [undefined, legacyProvider]) {
    const provider = resolveShadowProvider(configured);
    assert.equal(provider.url, currentProvider);
    assert.equal(hash(provider.endpointLabel), hash(legacyProvider));
  }
});

test("explicit labels and custom provider identities survive transport migration", () => {
  const oldCustom = "https://shadow-arc.vercel.app/api/custom?version=2";
  const provider = resolveShadowProvider(oldCustom);
  assert.equal(provider.url, "https://www.shadowbuild.xyz/api/custom?version=2");
  assert.equal(hash(provider.endpointLabel), hash(oldCustom));
  const explicit = "paid-resource://builder/custom-v3";
  assert.equal(resolveShadowProvider(legacyProvider, explicit).endpointLabel, explicit);
  const external = "https://provider.example/paid?version=2";
  assert.deepEqual(resolveShadowProvider(external), { url: external, endpointLabel: external });
  assert.deepEqual(resolveShadowProvider(currentProvider), { url: currentProvider, endpointLabel: currentProvider });
});

test("only retired Shadow hosts migrate, preserving paths and queries", () => {
  for (const host of ["shadow-arc.vercel.app", "shadow-two-opal.vercel.app"]) {
    assert.equal(migrateShadowUrl(`https://${host}/api/float?mode=v2&limit=3#record`),
      "https://www.shadowbuild.xyz/api/float?mode=v2&limit=3#record");
  }
  for (const value of ["https://shadow-arc.vercel.app.example/api", "https://provider.example/api", "/api/float", "not a url"]) {
    assert.equal(migrateShadowUrl(value), value);
  }
});
