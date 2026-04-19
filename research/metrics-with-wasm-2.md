Right. The answer is both — ephemeral instance per query, but per-chunk calls within it:

```typescript
async function evaluateRate(
  seriesChunks: Uint8Array[][],  // chunks per series
  windowStart: number,
  windowEnd: number
): Promise<number[]> {
  // Born
  const instance = await WebAssembly.instantiate(module);
  const scratch = new Uint8Array(instance.exports.memory.buffer, 0, 4096);
  
  const results: number[] = [];
  
  for (const chunks of seriesChunks) {
    let rate = 0;
    for (const chunk of chunks) {
      // 165 bytes in
      scratch.set(chunk);
      // 8 bytes out
      rate = instance.exports.chunk_rate(
        chunk.length, windowStart, windowEnd
      ) as number;
    }
    results.push(rate);
  }
  
  // Dies — V8 reclaims everything
  return results;
}
```

Peak WASM memory: one chunk (~165 bytes) + scratch output. Constant. Doesn't matter if the query touches 100 series or 100,000. The instance might internally `Vec::push` a few intermediate values during one chunk's processing, and that memory is "leaked" within the instance — but who cares, the instance is dead in 50 ms and never grew past a few KB.

So the instance lifecycle is per-query (amortize the ~100 µs instantiation), the data flow is per-chunk (bound memory to one chunk at a time), and the two concerns are cleanly separated.