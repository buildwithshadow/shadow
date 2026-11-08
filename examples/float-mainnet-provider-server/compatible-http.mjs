import { createServer } from 'node:http';

// Workers implements node:http over Fetch and rejects several Node connection
// options. Keep the provider's application body deadlines and admission lanes;
// enforce its header bound before dispatch instead of silently dropping it.
// This factory alone is not a deployable Worker or a trusted client IP bridge.
export function createCompatibleProviderHttpServer(options, listener, requestLimit = 32) {
  const maximum = options?.maxHeaderSize;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('A positive provider header bound is required');
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1) throw new Error('A positive request bound is required');
  if (typeof listener !== 'function') throw new Error('Provider listener is required');
  let active = 0;
  return createServer((request, response) => {
    const headers = request.rawHeaders;
    const target = request.url;
    let valid = typeof target === 'string' && target.length <= maximum && Array.isArray(headers) && headers.length % 2 === 0;
    let size = valid ? Buffer.byteLength(target, 'utf8') : maximum + 1;
    valid = valid && size <= maximum;
    if (valid) {
      for (const header of headers) {
        if (typeof header !== 'string' || header.length > maximum) { valid = false; break; }
        size += Buffer.byteLength(header, 'utf8') + 2;
        if (size > maximum) { valid = false; break; }
      }
    }
    if (!valid) {
      response.writeHead(431, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'application/json' });
      response.once('finish', () => request.destroy());
      response.end('{"error":"Request headers exceed the provider limit"}');
      return;
    }
    // Workers owns its TCP connections. Bound dispatched requests instead;
    // the provider separately bounds body ingress, normal work and recovery.
    if (active >= requestLimit) {
      response.writeHead(429, { 'cache-control': 'no-store', 'retry-after': '1', 'content-type': 'application/json' });
      response.once('finish', () => request.destroy());
      response.end('{"error":"Provider request capacity busy; retry later"}');
      return;
    }
    active++;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    response.once('finish', release);
    response.once('close', release);
    return listener(request, response);
  });
}
