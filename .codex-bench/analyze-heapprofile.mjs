import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node analyze-heapprofile.mjs <heapprofile.json>");
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(file, "utf8"));
const selfByFrame = new Map();
const totalByFrame = new Map();

function frameKey(node) {
  const frame = node.callFrame ?? {};
  const fn = frame.functionName || "(anonymous)";
  const url = frame.url ? path.basename(frame.url) : "(native)";
  const line = frame.lineNumber != null ? frame.lineNumber + 1 : 0;
  return `${fn} @ ${url}:${line}`;
}

function walk(node) {
  const key = frameKey(node);
  let total = node.selfSize ?? 0;
  selfByFrame.set(key, (selfByFrame.get(key) ?? 0) + (node.selfSize ?? 0));
  for (const child of node.children ?? []) {
    total += walk(child);
  }
  totalByFrame.set(key, (totalByFrame.get(key) ?? 0) + total);
  return total;
}

walk(profile.head);

function topEntries(map, limit = 15) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([frame, bytes]) => ({ frame, bytes }));
}

console.log(
  JSON.stringify(
    {
      file,
      topSelfBytes: topEntries(selfByFrame),
      topTotalBytes: topEntries(totalByFrame),
    },
    null,
    2
  )
);
