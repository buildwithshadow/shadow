import { routeApi } from "../../cloudflare/routes.ts";
import type { ApiContext } from "../../cloudflare/request-adapter.ts";

export function onRequest(context: ApiContext & { request: Request }): Promise<Response> {
  return routeApi(context.request, context);
}
