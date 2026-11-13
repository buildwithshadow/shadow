// Pages can retain an externally managed API hostname, including HTTPS 8443.
// Bind public provider fetch surfaces only. Never bind ProviderAdmin here.
export const providerRoutes = Object.freeze([
  ['/provider/arc-wallet-mainnet-settled', 'CURRENT_MAINNET'],
  ['/provider/arc-wallet-mainnet-public', 'PUBLIC_MAINNET'],
  ['/provider/arc-wallet-mainnet-guarded', 'GUARDED_MAINNET'],
  ['/provider/arc-wallet-mainnet', 'ORIGINAL_MAINNET'],
  ['/provider/arc-wallet-testnet-settled', 'SETTLED_TESTNET'],
  ['/provider/arc-wallet-testnet-bounded', 'BOUNDED_TESTNET'],
  ['/provider/arc-wallet-testnet-guarded', 'GUARDED_TESTNET'],
  ['/provider/shadow-v2-cycle', 'PUBLIC_TESTNET'],
]);

function unavailable(request, status, message) {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin' });
  if (request.headers.get('origin') === 'https://www.shadowbuild.xyz') {
    headers.set('access-control-allow-origin', 'https://www.shadowbuild.xyz');
    headers.set('access-control-expose-headers', 'retry-after');
  }
  if (status === 503) headers.set('retry-after', '10');
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

export async function routeProviderRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname.length + url.search.length > 2048) return unavailable(request, 414, 'Request target exceeds the provider limit');
  const route = providerRoutes.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
  if (!route) return unavailable(request, 404, 'Not found');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > 65536)) return unavailable(request, 413, 'Request body exceeds the provider limit');
  const [prefix, binding] = route;
  if (!env[binding] || typeof env[binding].fetch !== 'function') return unavailable(request, 503, 'Provider temporarily unavailable; retry the original request');
  url.pathname = url.pathname.slice(prefix.length) || '/';
  // Preserve the platform-established caller IP, body stream, Origin and CORS
  // preflight headers. The maintained provider edge validates and reconstructs
  // them before touching its coordinator. This gateway never sends a payment,
  // signs a receipt, interprets a digest, or retries a request.
  try {
    const response = await env[binding].fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    headers.delete('server');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return unavailable(request, 503, 'Provider temporarily unavailable; retry the original request');
  }
}

export default { fetch: routeProviderRequest };
