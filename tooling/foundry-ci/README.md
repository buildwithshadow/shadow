# Foundry CI binaries

The contract gates use the official `@foundry-rs` Linux x64 packages at exact version 1.7.1. The committed npm lockfile pins every tarball integrity hash. Install scripts are disabled. The verification step executes all three binaries with `--version` and requires upstream commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8` before adding their directory to PATH.

This is an alternative distribution channel for the same pinned tools, without a dependency on downloading the Foundry installer or attestations from GitHub during every CI run. It does not skip or alter contract tests. The package layout is documented in the [upstream npm distribution source](https://github.com/foundry-rs/foundry/tree/v1.7.1/npm).
