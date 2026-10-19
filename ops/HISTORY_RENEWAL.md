# Monitor history maintenance

An approved immutable history prefix keeps canonical suffix scans within the monitor deadline. As the chain grows, that suffix grows too. A one time prefix refresh is not a permanent performance fix.

Check scan duration and prefix age during routine operations. Prepare renewal before scans approach the configured deadline. Keep the existing deadline, full deployment range, execution audit and fail closed behavior unchanged.

The runner now records start time in its existing bounded event journal. Inspect the last twenty cycles for the selected baseline with:

```sh
node app/scripts/float-mainnet-maintenance-report.mjs \
  --baseline /protected/baseline.json --events /monitor-state/events.json
```

This offline advisory recommends maintenance when any observed cycle consumes at least 75 percent of the approved timeout. Failed or held cycles and stale journals require investigation. Older records without start times are not fabricated into timing samples; at least three timed cycles are needed before reporting no observed pressure. Exit 0 means no pressure observed, 2 means attention or more evidence is needed, and 1 means invalid input or command failure. It neither measures current service health nor predicts when history growth will cause failure. RPC latency and other checks can also cause slow scans.

The report does not send notifications, change admission, approve history, or clear a hold. Keep scheduled advisory reporting separate from the payment gate. After deploying the runner update, wait for three completed cycles before using its timing output. A single healthy cycle does not establish sustainable capacity.

1. Produce two complete captures with `app/scripts/float-mainnet-history-capture.mjs`, using separately operated RPC backends and distinct output files. Preserve each capture command, time, successful exit status and source identity privately. Never interpret an RPC failure as an empty log range.
2. Compare both captures against the currently protected prefix and its externally approved digest:

```sh
node app/scripts/float-mainnet-history-renewal.mjs \
  --manifest /protected/deployment.manifest.json \
  --approved /protected/current-history.json \
  --digest APPROVED_SHA256 \
  --first /private/first-capture.json \
  --second /private/second-capture.json
```

3. A passing comparison is **not approval**. It checks identity, preservation of all previous events, agreement throughout the overlapping range and overlapping event block hashes. It recommends only the older capture, never an uncorroborated newer tail. Identical files do not prove independent sources. Two backends can omit the same event. The operator must review complete capture provenance and independently verify the selected finalized canonical anchor before approving its digest.
4. Install reviewed bytes and the new digest in the protected configuration as a separate maintenance action. Preserve the old version and journal. Do not grant the monitor write access to protected history or baseline files. Keep policy, executor audit start, identity and limits unchanged.
5. Run a complete monitor check. If an incident was already latched, acknowledge its exact ID using the existing runner only after a fresh healthy sample. Never delete a hold manually. Restart dependent services when their baseline binding changes. Verify subsequent automatic scans and retain their records.

The comparison command reads local files and prints an unapproved report. It sends no RPC requests or transactions, installs no configuration, and clears no hold. It makes renewal review repeatable; it does not automate protected approval or eliminate the need for future renewal. A fully automatic incremental scanner requires separate security review of its trust and persistence model.
