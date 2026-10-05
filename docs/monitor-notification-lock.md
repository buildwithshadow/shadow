# Mainnet notification process lock

The notifier requires Node.js with `process.execve` (22.15+ on Linux/macOS) and Python 3 with the standard `fcntl` module (Linux or macOS). It acquires a nonblocking kernel lock before delivery and keeps the descriptor open in the Node process. The helper replaces the original CLI process, so the service manager tracks the same PID that owns delivery and the lock. SIGTERM, SIGKILL, a crash, and host restart release the kernel lock. The `notification.flock` file remains in place; do not delete or rotate it while notifier processes may exist.

Concurrent invocations exit without sending while another notifier owns the lock. Successful delivery state is saved only after Telegram confirms acceptance. A crash after Telegram accepts a message but before the local acknowledgment may still cause a duplicate retry; Telegram does not offer an idempotency guarantee here.

For an upgrade from the legacy `notification.lock` file, stop the notifier timer and wait for its service and any manually launched notifier to exit. Inspect any remaining legacy lock and its recorded process before removing it. The new notifier refuses to start while a legacy lock exists. Never delete monitoring incident holds as part of this migration.

Keep the notification directory private and local to one host. The lock does not provide distributed coordination across hosts or an external dead-man alert if the host itself is lost.
