# Service privilege hardening

`security.conf` is a systemd drop-in for a Shadow provider, read-only observer, or
one-shot alert worker. It prevents privilege escalation and preserves the
service's existing account, environment-file references, journals, observation
baseline and allowed write paths. It contains no credentials.

Before activation, validate against the actual unit with `systemd-analyze verify`,
archive its existing drop-ins and record data-directory ownership and checksums.
Activate during an idle, paused rehearsal; do not interrupt unresolved writes.
After restart verify effective properties, original store/baseline identity,
provider health, a completed healthy observer heartbeat and the alerts timer.
A one-shot alert service can be inactive between timer invocations; inspect its
result and timer activity rather than treating that normal state as an outage.
Never relax a hold, delete a journal or reset an execution budget to make a
restart appear healthy. Rotation of wallet/provider credentials and a change in
Safe threshold require separate procedures and are not performed by this file.
