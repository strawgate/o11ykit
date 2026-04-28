// Browser stub for node:zlib — used by stardb's codec-baseline.
// The logsdb demo uses bodyCodec: "raw" (no zstd/gzip) so these are
// never called at runtime. They exist only to satisfy the import.

export function gunzipSync() {
  throw new Error("node:zlib not available in browser");
}
export function gzipSync() {
  throw new Error("node:zlib not available in browser");
}
export function zstdCompressSync() {
  throw new Error("node:zlib not available in browser");
}
export function zstdDecompressSync() {
  throw new Error("node:zlib not available in browser");
}
export const constants = { ZSTD_CLEVEL_DEFAULT: 3 };
