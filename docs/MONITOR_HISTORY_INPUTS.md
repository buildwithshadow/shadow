# Immutable monitor history input locations

An embedding may pass `approvedHistoryRuntimeFile` to `loadContext` when the approved baseline names a filesystem location unavailable in that runtime. `validateConfiguredHistory` accepts the corresponding trusted `{ runtimeFile }` option. The runtime location must be a bounded absolute path and requires an existing protected history approval.

This relocates the immutable input bytes only. The baseline, original history filename, baseline hash, approved digest, manifest identity and anchor remain unchanged. A missing file, altered bytes or wrong binding fails validation. The default filesystem path and default replay behaviour are unchanged when no mapping is supplied.

The Node collector forwards the selected runtime filename with the original approved digest. Other embeddings must pass that filename and digest to their collector after validation. Prepare immutable scratch files for each invocation when required by the runtime. Heartbeats, incident latches, generation locks, records and witnesses must remain in durable storage.
