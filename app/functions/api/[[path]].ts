import { routeApi } from "../../cloudflare/routes";

export function onRequest(context: { request: Request }): Promise<Response> {
  return routeApi(context.request);
}
