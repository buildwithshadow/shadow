// The provider's service: replace this module with your own. The server calls
// it once per paid digest, after the contract records the payment, as
// service({ digest, requestId, acceptance }). requestId is the id the agent's
// request was accepted under: look up the request's content by it.
// Return { result, resultRef }: result is a string (hashed as its UTF-8 bytes)
// or a Uint8Array, and resultRef, when given, names where you keep the result.
// This example echoes a result that depends only on its inputs.
export default async function service({ digest, requestId }) {
  return {
    result: `${JSON.stringify({ digest, requestId, answer: `echo: request ${requestId} served` })}\n`,
    resultRef: `example://results/${digest}`,
  };
}
