// Enforce bytes while streaming, before allocating or parsing the whole body.
// Missing Content-Length and chunked replies receive the same bound.
export async function readBoundedJson(response, limit = 1_000_000) {
  const declared = response.headers?.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) {
    await response.body?.cancel();
    throw new Error("Provider response is too large.");
  }
  if (!response.body?.getReader) throw new Error("Provider response has no readable body.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Provider response is too large.");
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* preserve the original failure */ }
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
