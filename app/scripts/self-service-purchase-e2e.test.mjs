import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
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
import { storeOnce } from './float-mainnet-provider.mjs';
import { connectCandidate } from "./float-mainnet-config.mjs";
import { createProviderServer } from "../../examples/float-mainnet-provider-server/server.mjs";
import { createSelfServicePurchase, createGuardedMainnetPurchase } from "../src/selfServicePurchase.mjs";
import { recoverOriginalPurchase } from '../src/purchaseRecovery.mjs';

for (const variant of ["testnet", "guarded", "public-bounded"]) for (const fault of ["wallet-response", "delivery-response", "prepared-marker", "unprepared-marker", "readiness-hold"]) test(
  `new ${variant} sponsor: ${fault} after payment retains exact recovery behavior`,
  { skip: e2eSkip, timeout: 120000 },
  async (t) => {
    const mainnet = variant !== "testnet", bounded = variant === "public-bounded";
    const chainId=mainnet?5042:5042002,price=mainnet?5000n:50000n;
    const anvil = await startAnvil(18731,[],BigInt(chainId));
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
      id: chainId,
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
    const compiled = artifact(bounded?"ShadowFloatMainnetPublicBounded":mainnet?"ShadowFloatMainnetGuarded":"ShadowFloatPublicTestnet"),
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
    const contract = await deploy(compiled, [token,...(mainnet?[BigInt(chainId)]:[]),caps,caps,60n,86400n,86400n]);
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
    if(mainnet){
      await write(owner,contract,compiled.abi,'setOpeningsPaused',[false]);
      await write(owner,contract,compiled.abi,'setSpendsPaused',[false]);
      if (bounded) await write(sponsor,contract,compiled.abi,'registerSponsor');
      else await write(owner,contract,compiled.abi,'setSponsorAllowed',[sponsor.address,true]);
    }else await write(sponsor, contract, compiled.abi, "registerSponsor");
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
      expectedChainId: BigInt(chainId),
      runtimeHash,
      deployBlock: 0n,
    });
    let jobs = 0,
      sends = 0;
    const service = async () => {
      if (fault === 'prepared-marker') throw Error('prepared output must never repeat external work');
      jobs++;
      return { result: 'paid report' };
    };
    if (fault === 'prepared-marker') service.prepare = async () => { jobs++;return { result:'paid report' }; };
    server = createProviderServer({
      connection,
      account: provider,
      endpointHash: keccak256(stringToHex(endpoint)),
      price,
      storeDir: dir,
      service,
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const map = new Map(),
      storage = {
        get length() { return map.size; },
        key: index => [...map.keys()][index] ?? null,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
      };
    const agentWallet = {
      chain,
      getChainId: async () => chainId,
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
      chainId,
      account: agent.address,
      contract,
      runtimeHash,
      provider: provider.address,
      providerUrl: "https://service.example",
      endpoint,
      principal: String(price),
    };
    let droppedDelivery = false, unrelatedFundingHold = false;
    const acceptanceRequests = [];
    const create = (selectedStorage = storage) =>
      (mainnet?createGuardedMainnetPurchase:createSelfServicePurchase)({
        client,
        wallet: agentWallet,
        config,
        storage: selectedStorage,
        wait: async () => {},
        withLock: async (_k, work, operation) => {
          if (unrelatedFundingHold && (operation === 'prepare' || operation === 'submit')) throw Error('unresolved funding');
          return work();
        },
        fetchImpl: async (url, options) => {
          const path = new URL(url).pathname;
          if (path === "/accept") {
            acceptanceRequests.push(options.body);
            if (fault === "readiness-hold" && acceptanceRequests.length === 1) return new Response('', {status:503});
          }
          if (path === "/serve") {
            const body = JSON.parse(options.body);
            const saved = [...map.values()].map(value => JSON.parse(value)).find(record => record.intent?.digest === body.digest);
            assert.equal(body.paymentTransactionHash, saved.txHash ?? undefined, "browser forwards the original hash when retained, never invents a replacement after lost wallet response");
          }
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
    } else if (fault === "readiness-hold") {
      await flow.submit();
      assert.equal(acceptanceRequests.length,2);
      assert.equal(acceptanceRequests[0],acceptanceRequests[1]);
    } else if (fault === 'prepared-marker' || fault === 'unprepared-marker') {
      await flow.submit();
      const digest = flow.load().intent.digest;
      assert.equal(storeOnce(join(dir, `${digest}.started.json`), { digest, requestId:'job-public-1' }),true);
      if (fault === 'unprepared-marker') {
        await assert.rejects(create().recover(), /409/);
        assert.equal(jobs,0);assert.equal(sends,1);
        assert.equal(existsSync(join(dir, `${digest}.result.json`)),false);
        assert.equal((await read('lines',[lineId])).principalOutstanding,price);
        return;
      }
      assert.equal(existsSync(join(dir, `${digest}.prepared.json`)),true);
      assert.equal(existsSync(join(dir, `${digest}.result.json`)),false);
    } else {
      await flow.submit();
      await assert.rejects(flow.recover(), /lost delivery response/);
      assert.equal(jobs, 1);
      assert(droppedDelivery);
    }
    await assert.rejects(create().submit(), /reconciliation/);
    assert.equal(sends, 1);
    unrelatedFundingHold = true;
    const activeKey = [...map.keys()][0], pendingJournal = map.get(activeKey);
    let result, recoveryAttempts = 0;
    await recoverOriginalPurchase({
      recover: async () => {
        if (++recoveryAttempts === 1) throw new Error('Provider unavailable (503). Keep the original purchase and retry recovery.');
        return create().recover();
      },
      isCurrent: () => true, wait: async () => {},
      onResult: value => { result = value; }, onStop: cause => assert.fail(cause?.message ?? 'Recovery budget exhausted'),
    });
    assert.equal(recoveryAttempts, 2);
    assert.equal(result.status, "delivered");
    assert.equal(new TextDecoder().decode(result.bytes), "paid report");
    await create().recover();
    assert.equal(sends, 1);
    assert.equal(jobs, 1);
    assert.equal((await read("lines", [lineId])).principalOutstanding, price);
    assert.equal(
      await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [provider.address],
      }),
      price,
    );
    await write(owner, token, tokenArtifact.abi, "mint", [
      agent.address,
      price,
    ]);
    await write(agent, token, erc20Abi, "approve", [contract, price]);
    if(mainnet){const draw=await read('currentDrawDigest',[lineId]);await write(agent,contract,compiled.abi,'repayForDraw',[lineId,draw,price]);}
    else await write(agent,contract,compiled.abi,'repay',[lineId,price]);
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
    // Anvil finality trails the latest block. Preserve production's same-block
    // archive proof instead of substituting a latest-block read in the test.
    await client.request({method:'anvil_mine',params:['0x40']});
    await create().archive();
    assert.equal(create().load(), null);
    const paidDigest = result.record.intent.digest;
    const archives = create().listArchived();
    assert.equal(archives.length, 1);
    assert.equal(archives[0].intent.digest, paidDigest);
    // Opening an earlier receipt must never replace an unresolved journal.
    map.set(activeKey, pendingJournal);
    const reopened = await create().recoverArchived(paidDigest);
    assert.equal(new TextDecoder().decode(reopened.bytes), 'paid report');
    assert.equal(map.get(activeKey), pendingJournal);
    assert.equal(sends, 1); assert.equal(jobs, 1);
    const archiveKey = `${activeKey}:${paidDigest}`, archivedRaw = map.get(archiveKey);
    const portable = await create().exportArchived(paidDigest);
    assert.equal(JSON.parse(portable).kind,'shadow.completed-service-receipt');
    assert.equal(JSON.parse(portable).record.acceptance,undefined);
    assert.equal(JSON.parse(portable).record.agentSignature,undefined);
    const fresh = new Map(), freshStorage = {
      get length(){return fresh.size;},key:index=>[...fresh.keys()][index]??null,
      getItem:key=>fresh.get(key)??null,setItem:(key,value)=>fresh.set(key,value),removeItem:key=>fresh.delete(key),
    };
    const restored = create(freshStorage);
    const imported = await restored.importCompleted(portable);
    assert.equal(new TextDecoder().decode(imported.bytes),'paid report');
    assert.equal(restored.load(),null,'import never creates an active purchase');
    assert.equal(restored.listArchived().length,1);
    assert.equal((await restored.recoverArchived(paidDigest)).record.intent.digest,paidDigest);
    assert.equal(map.get(activeKey),pendingJournal,'source active purchase remains unchanged');
    fresh.set(activeKey,pendingJournal);
    await restored.importCompleted(portable);
    assert.equal(fresh.get(activeKey),pendingJournal,'destination active purchase remains unchanged');
    for(const [field,value] of [['account',sponsor.address],['chainId',123],['contract',token]]) {
      const wrong=JSON.parse(portable);wrong.record[field]=value;
      await assert.rejects(restored.importCompleted(JSON.stringify(wrong)),/another wallet or deployment/);
      assert.equal(fresh.get(activeKey),pendingJournal);
    }
    const beforeCanceled=[...fresh.entries()];
    let mayCommit=true;
    const previousVerify=client.verifyTypedData;
    client.verifyTypedData=async args=>{mayCommit=false;return previousVerify(args);};
    await assert.rejects(restored.importCompleted(portable,{mayCommit:()=>mayCommit}),/context changed/);
    client.verifyTypedData=previousVerify;
    assert.deepEqual([...fresh.entries()],beforeCanceled,'context cancellation must happen before storage writes');
    const changedResult=JSON.parse(portable);changedResult.record.result.result=btoa('forged result');
    await assert.rejects(restored.importCompleted(JSON.stringify(changedResult)),/signed receipt/);
    const changedSignature=JSON.parse(portable);changedSignature.record.result.delivery.signature=`0x${'12'.repeat(65)}`;
    await assert.rejects(restored.importCompleted(JSON.stringify(changedSignature)));
    await assert.rejects(restored.importCompleted('x'.repeat(2_000_001)),/too large/);
    assert.equal(fresh.get(activeKey),pendingJournal);
    assert.equal(sends,1);assert.equal(jobs,1);
    const tampered = JSON.parse(archivedRaw); tampered.result.result = btoa('altered report');
    map.set(archiveKey, JSON.stringify(tampered));
    await assert.rejects(create().recoverArchived(paidDigest), /signed receipt/);
    assert.equal(map.get(activeKey), pendingJournal);
    map.set(archiveKey, archivedRaw);
    const wrongDelivery = JSON.parse(archivedRaw);
    wrongDelivery.result.delivery.typedData.message.requestIdHash = `0x${'00'.repeat(32)}`;
    map.set(archiveKey, JSON.stringify(wrongDelivery));
    await assert.rejects(create().recoverArchived(paidDigest));
    assert.equal(map.get(activeKey), pendingJournal);
    map.set(archiveKey, archivedRaw);
    const originalRead = client.readContract;
    client.readContract = args => args.functionName === 'receiptStatus' ? Promise.resolve(0n) : originalRead(args);
    await assert.rejects(create().recoverArchived(paidDigest), /reconciliation/);
    await assert.rejects(restored.importCompleted(portable),/reconciliation/);
    assert.equal(fresh.get(activeKey),pendingJournal);
    client.readContract = originalRead;
    assert.equal(map.get(activeKey), pendingJournal);
  },
);
