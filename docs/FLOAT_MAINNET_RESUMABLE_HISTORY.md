# Resumable history capture

This maintenance tool retains validated log windows when a public RPC interrupts a complete history extension. It produces an unapproved candidate only. It does not change a protected history binding, baseline, service, incident, admission decision or transaction.

## Capture and resume

Use a new private workspace and output path for each source. The configured `ARC_RPC_URL` is consumed by the existing read only connection. Do not put credentials in `--provider-fingerprint`; use an opaque source label.

```sh
node app/scripts/float-mainnet-history-resumable.mjs \
  --manifest /protected/release.manifest.json \
  --baseline /protected/phase.baseline.json \
  --workspace /private/source-a-capture \
  --out /private/source-a.unapproved.json \
  --provider-fingerprint source-a-label
```

After a quota failure, wait for the provider cooldown and run the same command with `--resume`. There is no automatic resume loop. A fixed finalized anchor, original prefix digest, baseline hash, manifest identity, endpoint digest, source label, window width and bounds must remain unchanged. Advancing the finalized head is allowed if the fixed anchor remains finalized and canonical. Raw endpoint URLs and credentials are never written to the workspace or reports. Changing an endpoint credential also changes its digest and requires a new workspace.

Each page covers one exact inclusive window, including empty windows. Resume validates saved pages and their event blocks before fetching missing windows. Newly fetched pages are saved only after canonical checks pass. Final assembly freshly rechecks all suffix event blocks, both anchors and protected inputs. Its bytes must equal the existing uninterrupted capture for the same anchor and source data. Existing history validators are unchanged.

## Limits and failure behavior

Default limits are 200 windows, 1 MiB per page, 8 MiB total page bytes, 20,000 logs, 2,000 logical client calls and 30 minutes per invocation. Window width defaults to 10,000 blocks and cannot exceed that value. CLI flags can tighten these limits or increase them only up to the exported hard ceilings. Final history size is also bounded by the existing 8 MiB validator.

Call and time budgets are per invocation. They reset on an explicit operator resume. Logical call counts do not include connection setup or individual HTTP attempts inside the existing bounded transport retry policy. Page, byte and log limits apply to the whole workspace. Budget exhaustion retains only validated unapproved pages and returns nonzero.

Private directories, exclusive locks, regular files, no symlink traversal at file opens and exclusive atomic writes prevent accidental overlap. A crash can leave a lock or temporary file. The tool refuses that state rather than removing it automatically. Inspect and preserve evidence before manually cleaning a stale lock; never remove a live lock. Failed canonical pages require a new session if retained data is no longer canonical.

## Required independent comparison

Local page digests detect corruption and inconsistent structure. They cannot prove that a provider returned every event. A valid omitted event can evade local validation. The source label and endpoint digest do not prove that two endpoints have independent infrastructure.

Capture the entire suffix separately from another provider, using its own workspace and output. Compare complete overlapping history with `float-mainnet-history-renewal.mjs`, corroborate the chosen anchor and preserve the original prefix. Maintainer review and the existing protected installation process remain required. A saved page, complete candidate or successful comparison never establishes a healthy monitor or clears a hold by itself.

## Offline validation

```sh
node --test app/scripts/float-mainnet-history-resumable.test.mjs \
  app/scripts/float-mainnet-history-extension.test.mjs \
  app/scripts/float-mainnet-history-renewal.test.mjs
```

Tests use temporary files and fake clients, with no external RPC or wallet. They cover interrupted capture byte equality, source binding, fresh canonical checks, changed inputs, resource bounds, filesystem failures, omission limits and strict CLI parsing. Passing tests is not audit clearance.
