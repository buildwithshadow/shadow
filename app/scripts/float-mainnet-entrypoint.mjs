import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// import.meta.main exists from Node 24.2; older Node leaves it undefined. Node
// resolves symlinks in the main module's URL, so compare real paths.
export function isEntrypoint(meta, argv = process.argv) {
  if (meta.main !== undefined) return meta.main;
  return argv[1] !== undefined && existsSync(argv[1]) && realpathSync(argv[1]) === realpathSync(fileURLToPath(meta.url));
}
