import { Buffer } from "node:buffer";

type ApiRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  body?: unknown;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
};

type ApiResponse = {
  setHeader(name: string, value: string | number): void;
  status(code: number): ApiResponse;
  json(body: unknown): void;
};

export type ApiHandler = (request: ApiRequest, response: ApiResponse) => Promise<void>;
const MAX_BODY_BYTES = 1_048_576;

function errorResponse(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function runApiHandler(request: Request, handler: ApiHandler): Promise<Response> {
  const url = new URL(request.url);
  const headers = Object.fromEntries(request.headers);
  // Handlers construct payment-resource URLs from these headers. Use the actual
  // request origin, not client-supplied forwarding headers.
  headers.host = url.host;
  headers["x-forwarded-host"] = url.host;
  headers["x-forwarded-proto"] = url.protocol.slice(0, -1);
  const query: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }

  let body: unknown;
  const chunks: Buffer[] = [];
  if (request.body) {
    const reader = request.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return errorResponse(413, "request body too large");
        }
        chunks.push(Buffer.from(value));
      }
    } catch {
      return errorResponse(400, "request body could not be read");
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (size) {
      const text = new TextDecoder().decode(bytes);
      if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json") {
        try {
          body = JSON.parse(text);
        } catch {
          return errorResponse(400, "invalid JSON body");
        }
      } else {
        body = text;
      }
    }
  }

  let status = 200;
  let response: Response | undefined;
  const responseHeaders = new Headers();
  const res: ApiResponse = {
    setHeader(name, value) { responseHeaders.set(name, String(value)); },
    status(code) { status = code; return res; },
    json(value) {
      responseHeaders.set("Content-Type", "application/json");
      const json = JSON.stringify(value);
      response = new Response(request.method === "HEAD" ? null : json, { status, headers: responseHeaders });
    },
  };
  try {
    await handler({
      method: request.method,
      url: request.url,
      headers,
      query,
      body,
      async *[Symbol.asyncIterator]() { yield* chunks; },
    }, res);
    return response ?? errorResponse(500, "API handler did not return a response");
  } catch {
    // Upstream error messages may contain authenticated URLs or response bodies.
    return errorResponse(500, "API request failed");
  }
}
