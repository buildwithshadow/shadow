import cctpFunding from "../api/cctp-funding.ts";
import followPlan from "../api/agent/follow-plan.ts";
import float from "../api/float.ts";
import floatTools from "../api/float-tools.ts";
import fundSmartAccount from "../api/fund-smart-account.ts";
import pilot from "../api/pilot.ts";
import reasoning from "../api/reasoning.ts";
import reasoningX402 from "../api/reasoning-x402.ts";
import settlements from "../api/settlements.ts";
import state from "../api/state.ts";
import treasury from "../api/treasury.ts";
import verifySlippage from "../api/verify-slippage.ts";
import { runApiHandler, type ApiContext, type ApiHandler } from "./request-adapter.ts";

export const apiRoutes: ReadonlyMap<string, ApiHandler> = new Map([
  ["/api/cctp-funding", cctpFunding],
  ["/api/agent/follow-plan", followPlan],
  ["/api/float", float],
  ["/api/float-tools", floatTools],
  ["/api/fund-smart-account", fundSmartAccount],
  ["/api/pilot", pilot],
  ["/api/reasoning", reasoning],
  ["/api/reasoning-x402", reasoningX402],
  ["/api/settlements", settlements],
  ["/api/state", state],
  ["/api/treasury", treasury],
  ["/api/verify-slippage", verifySlippage],
]);

export async function routeApi(request: Request, context?: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/desk") {
    url.pathname = "/api/float";
    url.searchParams.set("mode", "desk");
    request = new Request(url, request);
  }
  const handler = apiRoutes.get(url.pathname);
  if (!handler) {
    return Response.json({ error: "API route not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return runApiHandler(request, handler, context);
}
