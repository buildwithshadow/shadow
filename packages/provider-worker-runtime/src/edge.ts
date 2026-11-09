import { isIP } from 'node:net';
import { storeObjectName } from '../../provider-durable-store/src/identity.ts';
import { readProviderConfig } from './config.ts';
import { trustedClientAddress } from './client-address.ts';

// The ONLY public entry. It owns the caller's identity: whatever the client says about its own address is
// discarded, the platform-established CF-Connecting-IP is validated, and the Durable Object is given a
// rebuilt request that carries exactly that address and nothing else a client could have forged.
const json = (status: number, body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });

const MAX_URL_CHARS = 2048;
const MAX_FORWARDED_HEADER_CHARS = 256;
const MAX_BODY_BYTES = 65_536; // the provider's own bound; refused early when declared
const FORWARDED_ALLOWLIST = ['content-type', 'accept', 'origin'] as const;

async function routeEdge(request: Request, env: Env): Promise<Response> {
  if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'method not allowed' }, { allow: 'GET, POST' });
  const url = new URL(request.url);
  const target = `${url.pathname}${url.search}`;
  if (target.length > MAX_URL_CHARS) return json(414, { error: 'Request target exceeds the provider limit' });

  // Trusted source, and the only one: the platform-set connecting address. Invalid or missing is refused here,
  // before any Durable Object is touched, with the provider's own wording for the same condition.
  const caller = trustedClientAddress(request.headers.get('cf-connecting-ip'));
  if (!caller || isIP(caller) === 0) return json(400, { error: 'Missing trusted client address' });

  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return json(413, { error: `the request body exceeds ${MAX_BODY_BYTES} bytes` });

  // Rebuild the headers from an allowlist. Everything else, including every forwarding header, is dropped.
  const headers = new Headers();
  for (const name of FORWARDED_ALLOWLIST) {
    const value = request.headers.get(name);
    if (value === null) continue;
    if (value.length > MAX_FORWARDED_HEADER_CHARS) return json(431, { error: 'Request headers exceed the provider limit' });
    headers.set(name, value);
  }
  headers.set('cf-connecting-ip', caller);

  const config = readProviderConfig(env as unknown as Record<string, unknown>);
  if (!config.ok) return json(503, { error: 'Provider is held; configuration or reconciliation is required', reason: config.reason });
  const coordinator = env.PROVIDER_COORDINATOR.get(env.PROVIDER_COORDINATOR.idFromName(await storeObjectName(config.config.identity)));
  const forwarded = new Request(`https://provider.internal${target}`, {
    method: request.method, headers, body: request.method === 'POST' ? request.body : null,
  });
  return coordinator.fetch(forwarded);
}

const PUBLIC_ORIGIN = 'https://www.shadowbuild.xyz';
function cors(response: Response, origin: string | null): Response {
  const headers=new Headers(response.headers);
  // This response depends on Origin, including denied and early error paths.
  const vary=headers.get('vary');headers.set('vary',vary ? [...new Set([...vary.split(',').map(x=>x.trim()),'Origin'])].join(', ') : 'Origin');
  if(origin===PUBLIC_ORIGIN) {
    headers.set('access-control-allow-origin',PUBLIC_ORIGIN);
    headers.set('access-control-allow-methods','GET, POST, OPTIONS');
    headers.set('access-control-allow-headers','content-type');
    headers.set('access-control-expose-headers','retry-after');
  } else {
    for(const name of ['access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-expose-headers'])headers.delete(name);
  }
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
export async function handleEdge(request: Request,env: Env): Promise<Response> {
  const origin=request.headers.get('origin');
  if(origin!==null && origin!==PUBLIC_ORIGIN)return cors(json(403,{error:'Origin is not allowed'}),origin);
  if(request.method==='OPTIONS') {
    const method=request.headers.get('access-control-request-method');
    const raw=request.headers.get('access-control-request-headers') ?? '';
    const allowedHeaders=raw.length<=256 && raw.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).every(x=>x==='content-type');
    if(origin!==PUBLIC_ORIGIN || !['GET','POST'].includes(method ?? '') || !allowedHeaders)return cors(json(403,{error:'Preflight is not allowed'}),origin);
    return cors(new Response(null,{status:204}),origin);
  }
  try {return cors(await routeEdge(request,env),origin);}
  catch {return cors(json(503,{error:'Provider temporarily unavailable; retry the original request'}),origin);}
}
