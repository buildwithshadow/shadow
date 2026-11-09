// Independent publication witness: deploy as a separate script and restore domain.
export { StoreWitnessDO } from '../../provider-durable-store/src/do-witness.ts';
export default { fetch: () => new Response('Not found', {status:404}) } satisfies ExportedHandler;
