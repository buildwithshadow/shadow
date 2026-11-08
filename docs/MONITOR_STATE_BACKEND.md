# Monitor state backend contract

The monitor runner accepts an optional trusted `context.stateBackend` for embedding. The CLI does not configure it. Without it, filesystem permissions, atomic replacement, fsync and lock behaviour remain unchanged.

The backend implements synchronous methods:

| Method | Contract |
| --- | --- |
| `has(key)` | Return a boolean. |
| `read(key)` | Return a JSON string or throw for a missing or invalid record. |
| `write(key, bytes)` | Atomically replace the record with the supplied canonical JSON string. |
| `remove(key, force)` | Remove the record; tolerate absence only when `force` is true. |
| `acquire(key, bytes)` | Atomically create a missing lock, returning true only for the successful owner. |
| `release(key, token)` | Remove only a lock whose stored token matches. |

Keys are restricted to `heartbeat.json`, `snapshot.json`, `hold.json`, `events.json`, `publication.json` and `runner.lock`. The runner owns serialization and parses a copy of each read. Promise returning methods are rejected. This interface is an operator capability, never a public request option.

A durable backend must persist the lock before collection begins. Status remains held while it exists. An unexpected interruption retains that lock, including a failure before replacing an older healthy heartbeat. Failed acknowledgement mutations also retain the lock, even if removal of the hold succeeded before storage reported failure. Ordinary acknowledgement validation errors release it. Recovery requires a separate operator procedure that verifies no collector is still running. Never delete locks on a timer or recreate the backend identity when its baseline changes.

The same runner retains publication generation checks, snapshot binding, baseline changes, stale samples, head regression, incident latching and exact fresh acknowledgement. A storage adapter must preserve those semantics. An adapter with asynchronous durability must finish its durable commit barriers before exposing status or beginning external work. Synchronous method return alone does not prove durable replication.

This boundary does not install an alarm, migrate existing state, implement a Cloudflare backend, configure notifications or establish production readiness. Embeddings must supply their own bounded collector instead of the default Node subprocess. Monitor script path resolution is deferred until that default collector is called.
