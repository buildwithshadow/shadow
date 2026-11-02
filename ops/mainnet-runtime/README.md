# Service privilege hardening

`security.conf` is a systemd drop-in for a Shadow provider, read-only observer, or
one-shot alert worker. It prevents privilege escalation and preserves the
service's existing account, environment-file references, journals, observation
baseline and allowed write paths. It contains no credentials.

Before activation, validate against the actual unit with `systemd-analyze verify`,
archive its existing drop-ins and record data-directory ownership and checksums.
Install it as an instance-specific `zzzz-shadow-security.conf` drop-in after
checking existing platform overrides. Some container hosts apply a generic
`zzz-lxc-service.conf` that disables NoNewPrivileges; an earlier-sorting filename
will not enforce the intended setting. Use a disposable, credential-free service
probe and verify `/proc/self/status` reports `NoNewPrivs: 1` before activation.

Activate during an idle, paused rehearsal; do not interrupt unresolved writes.
After restart verify effective properties, original store/baseline identity,
provider health, a completed healthy observer heartbeat and the alerts timer.
A one-shot alert service can be inactive between timer invocations; inspect its
result and timer activity rather than treating that normal state as an outage.
Never relax a hold, delete a journal or reset an execution budget to make a
restart appear healthy. Rotation of wallet/provider credentials and a change in
Safe threshold require separate procedures and are not performed by this file.

## Approved monitoring phase changes

The provider pins the manifest and baseline hashes at startup. A healthy
observer does not establish that an older provider process accepts the current
policy. After verifying the exact onchain transition, install its approved
baseline atomically while preserving the previous file and its owner, group
and permissions. Restart the observer to load that phase. Require a complete
healthy sample; if a transition incident is latched, acknowledge only its exact
ID using the supported monitor command after the healthy sample exists.

Restart the signing provider against the same approved phase during an idle
window and verify its actual admission guard, not just its process status or
an existing paid receipt lookup. Admission verification must not sign a new
acceptance or submit a payment. Preserve the original store, witness and
journals. Do not reload policy from a snapshot, suppress drift, or bypass holds.
