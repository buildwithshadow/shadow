# Readonly WebSocket transport

A bounded EIP 1193 style request channel for owned read providers. It accepts only seven methods: `eth_chainId`, `eth_getCode`, `eth_call`, `eth_getBlockByNumber`, `eth_getLogs`, `eth_getTransactionByHash` and `eth_getTransactionReceipt`. It does not sign, submit transactions or silently fall back to HTTP.

The caller supplies the socket factory and owns endpoint configuration. One connection is shared by bounded pending requests. Connection attempts happen before sending; a request already sent is never automatically replayed after timeout, disconnect or reconnect. Aborted requests release their slots and listeners immediately. Call `close()` when the invocation or idle resource ends.

`readonlyViemTransport` disables both transport and per call viem retries. A higher level read queue may explicitly retry safe reads according to application policy. This module itself makes no decision about history completeness, independent source agreement, manifest approval or spending admission.

Remote error messages are discarded. Only locally classified diagnostics, numeric error codes and bounded hex revert data for `eth_call` survive. Revert bytes are untrusted remote data. Endpoint credentials stay inside the caller supplied factory and must never be printed.

## Verify

Use Node 24 or later.

```sh
npm ci
npm run check
```

The tests use injected sockets and deterministic clocks. They do not connect to any live RPC endpoint or deploy anything. A production runtime must separately verify its socket factory, lifecycle cleanup, canonical history and quota budget.

Built with assistance from Arc Studio and independently reviewed and tested in Shadow.
