import { isAbsolute } from 'node:path';

// Vendor authentication runs without project dotenv files, arbitrary Node
// preload hooks, custom Circle proxies, or user executable search paths.
export function circleCliEnvironment(input = process.env) {
  for (const key of ['NODE_OPTIONS','NODE_PATH','CIRCLE_PROXY_URL']) {
    if (input[key]) throw new Error(`Remove ${key} before using the verified Circle CLI.`);
  }
  if (input.CIRCLE_CLI_HOME && !isAbsolute(input.CIRCLE_CLI_HOME)) throw new Error('Circle profile home must be an absolute path.');
  const output={PATH:'/usr/bin:/bin'};
  for(const key of ['HOME','USER','LOGNAME','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','CIRCLE_CLI_HOME']) {
    if(typeof input[key]==='string')output[key]=input[key];
  }
  return output;
}
