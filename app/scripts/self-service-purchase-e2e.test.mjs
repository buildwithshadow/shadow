import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  erc20Abi,
  keccak256,
  stringToHex,
  getAddress,
} from "viem";
import { account, startAnvil, e2eSkip } from "./float-mainnet-e2e.mjs";
import { connectCandidate } from "./float-mainnet-config.mjs";
import { createProviderServer } from "../../examples/float-mainnet-provider-server/server.mjs";
import { createSelfServicePurchase } from "../src/selfServicePurchase.mjs";

for (const fault of ["wallet-response", "delivery-response"]) test(
  `new sponsor: ${fault} lost after payment succeeds; retry delivers once, repays and reclaims`,
  { skip: e2eSkip, timeout: 120000 },
  async (t) => {
    const anvil = await startAnvil(18731);
    const dir = mkdtempSync(join(tmpdir(), "shadow-public-"));
    let server;
    t.after(async () => {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      anvil.stop();
      rmSync(dir, { recursive: true, force: true });
    });
    const chain = defineChain({
      id: 5042002,
      name: "local",
      nativeCurrency: { name: "test", symbol: "test", decimals: 18 },
      rpcUrls: { default: { http: [anvil.rpc] } },
    });
    const client = createPublicClient({ chain, transport: http(anvil.rpc) }),
      wallet = (a) =>
        createWalletClient({ account: a, chain, transport: http(anvil.rpc) });
    const [owner, sponsor, agent, provider] = [0, 6, 7, 9].map(account);
    const artifact = (name) =>
      JSON.parse(
        readFileSync(
          new URL(
            `../../contracts/out/${name}.sol/${name}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    const compiled = artifact("ShadowFloatPublicTestnet"),
      tokenArtifact = artifact("MockAsset");
    const mine = async (hash) => {
      const r = await client.waitForTransactionReceipt({ hash });
      assert.equal(r.status, "success");
      return r;
    };
    const deploy = async (a, args) =>
      getAddress(
        (
          await mine(
            await wallet(owner).deployContract({
              abi: a.abi,
              bytecode: a.bytecode.object,
              args,
            }),
          )
        ).contractAddress,
      );
    const token = await deploy(tokenArtifact, ["USDC", "USDC", 6]);
    const caps = {
      protocolReserve: 20000000n,
      lineReserve: 1000000n,
      lineSpend: 1000000n,
      perSpend: 100000n,
      dailySpend: 1000000n,
    };
    const contract = await deploy(compiled, [
      token,
      caps,
      caps,
      60n,
      86400n,
      86400n,
    ]);
    const write = async (a, address, abi, functionName, args = []) =>
      mine(await wallet(a).writeContract({ address, abi, functionName, args }));
    const read = async (functionName, args = []) => {
      const r = await client.readContract({
        address: contract,
        abi: compiled.abi,
        functionName,
        args,
      });
      return functionName === "lines"
        ? Object.fromEntries(
            compiled.abi
              .find((x) => x.name === functionName)
              .outputs.map((o, i) => [o.name, r[i]]),
          )
        : r;
    };
    await write(owner, token, tokenArtifact.abi, "mint", [
      sponsor.address,
      100000n,
    ]);
    // No owner allowlisting or API enrollment step.
    await write(sponsor, contract, compiled.abi, "registerSponsor");
    await write(sponsor, token, erc20Abi, "approve", [contract, 100000n]);
    const now = (await client.getBlock()).timestamp,
      endpoint = "https://service.example/report";
    await write(sponsor, contract, compiled.abi, "openLine", [
      {
        agent: agent.address,
        reserve: 100000n,
        lineSpendCap: 100000n,
        dailySpendCap: 100000n,
        lineExpiry: now + 86400n,
        maximumRepaymentWindow: 3600n,
        provider: provider.address,
        endpointHash: keccak256(stringToHex(endpoint)),
        providerPerSpendCap: 50000n,
        providerDailyCap: 100000n,
        providerExpiry: now + 86400n,
      },
    ]);
    const lineId = await read("activeLineId", [sponsor.address, agent.address]);
    const runtimeHash = keccak256(await client.getCode({ address: contract }));
    const connection = await connectCandidate({
      rpcUrl: anvil.rpc,
      address: contract,
      expectedChainId: 5042002n,
      runtimeHash,
      deployBlock: 0n,
    });
    let jobs = 0,
      sends = 0;
    server = createProviderServer({
      connection,
      account: provider,
      endpointHash: keccak256(stringToHex(endpoint)),
      price: 50000n,
      storeDir: dir,
      service: async () => {
        jobs++;
        return { result: "paid report" };
      },
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const map = new Map(),
      storage = {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
      };
    const agentWallet = {
      chain,
      getChainId: async () => 5042002,
      getAddresses: async () => [agent.address],
      request: async ({ params }) => agent.signTypedData(JSON.parse(params[1])),
      sendTransaction: async (args) => {
        sends++;
        const hash = await wallet(agent).sendTransaction(args);
        await mine(hash);
        if (fault === "wallet-response") throw new Error("lost wallet response");
        return hash;
      },
    };
    const config = {
      chainId: 5042002,
      account: agent.address,
      contract,
      runtimeHash,
      provider: provider.address,
      providerUrl: "https://service.example",
      endpoint,
      principal: "50000",
    };
    let droppedDelivery = false;
    const create = () =>
      createSelfServicePurchase({
        client,
        wallet: agentWallet,
        config,
        storage,
        withLock: async (_k, work) => work(),
        fetchImpl: async (url, options) => {
          const path = new URL(url).pathname;
          const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
          if (fault === "delivery-response" && path === "/serve" && response.ok && !droppedDelivery) {
            await response.arrayBuffer(); // Server completed the paid job, client never receives it.
            droppedDelivery = true;
            throw new Error("lost delivery response");
          }
          return response;
        },
      });
    const flow = create();
    await flow.prepare(lineId, "job-public-1");
    if (fault === "wallet-response") {
      await assert.rejects(flow.submit(), /lost wallet response/);
    } else {
      await flow.submit();
      await assert.rejects(flow.recover(), /lost delivery response/);
      assert.equal(jobs, 1);
      assert(droppedDelivery);
    }
    await assert.rejects(create().submit(), /reconciliation/);
    assert.equal(sends, 1);
    const result = await create().recover();
    assert.equal(result.status, "delivered");
    assert.equal(new TextDecoder().decode(result.bytes), "paid report");
    await create().recover();
    assert.equal(sends, 1);
    assert.equal(jobs, 1);
    assert.equal((await read("lines", [lineId])).principalOutstanding, 50000n);
    assert.equal(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [provider.address],
      }),
      50000n,
    );
    await write(owner, token, tokenArtifact.abi, "mint", [
      agent.address,
      50000n,
    ]);
    await write(agent, token, erc20Abi, "approve", [contract, 50000n]);
    await write(agent, contract, compiled.abi, "repay", [lineId, 50000n]);
    await write(sponsor, contract, compiled.abi, "closeLine", [lineId]);
    assert.equal(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sponsor.address],
      }),
      100000n,
    );
    assert.equal((await read("lines", [lineId])).principalOutstanding, 0n);
  },
);
