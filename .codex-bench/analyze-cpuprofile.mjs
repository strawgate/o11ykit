import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node analyze-cpuprofile.mjs <cpuprofile.json>");
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(file, "utf8"));
if (
  typeof profile !== "object" ||
  profile === null ||
  !Array.isArray(profile.nodes) ||
  !Array.isArray(profile.samples) ||
  !Array.isArray(profile.timeDeltas)
) {
  console.error("invalid cpuprofile: expected arrays `nodes`, `samples`, `timeDeltas`");
  process.exit(1);
}
const nodes = profile.nodes;
const samples = profile.samples;
const timeDeltas = profile.timeDeltas;

const nodeById = new Map(nodes.map((node) => [node.id, node]));
const parentById = new Map();
for (const node of nodes) {
  for (const childId of node.children ?? []) {
    parentById.set(childId, node.id);
  }
}

const selfByFrame = new Map();
const totalByFrame = new Map();

function frameKey(node) {
  const frame = node.callFrame ?? {};
  const fn = frame.functionName || "(anonymous)";
  const url = frame.url ? path.basename(frame.url) : "(native)";
  const line = frame.lineNumber != null ? frame.lineNumber + 1 : 0;
  return `${fn} @ ${url}:${line}`;
}

const sampleCount = Math.min(samples.length, timeDeltas.length);
if (samples.length !== timeDeltas.length) {
  console.warn(
    `warning: samples (${samples.length}) and timeDeltas (${timeDeltas.length}) length mismatch; truncating to ${sampleCount}`
  );
}

for (let i = 0; i < sampleCount; i++) {
  const nodeId = samples[i];
  const weight = timeDeltas[i] / 1000;
  if (!nodeId || weight <= 0) continue;

  let currentId = nodeId;
  while (currentId) {
    const node = nodeById.get(currentId);
    if (!node) break;
    const key = frameKey(node);
    totalByFrame.set(key, (totalByFrame.get(key) ?? 0) + weight);
    if (currentId === nodeId) {
      selfByFrame.set(key, (selfByFrame.get(key) ?? 0) + weight);
    }
    currentId = parentById.get(currentId);
  }
}

function topEntries(map, limit = 15) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([frame, ms]) => ({ frame, ms }));
}

console.log(
  JSON.stringify(
    {
      file,
      topSelfMs: topEntries(selfByFrame),
      topTotalMs: topEntries(totalByFrame),
    },
    null,
    2
  )
);
