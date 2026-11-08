// Prototype bounds. These are NOT measured against Cloudflare CPU or storage
// quotas. They only bound the work one call can request. Tune after measuring.
export const LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024,
  maxRecords: 1000,
  maxTotalBytes: 8 * 1024 * 1024,
  defaultListLimit: 100,
  maxListLimit: 200,
  witnessPageSize: 200,
});
