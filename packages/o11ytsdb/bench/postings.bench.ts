import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Suite, printReport } from "./harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = (rel: string) => join(__dirname, "..", "..", rel);

function makeSeriesLabels(n: number): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (let i = 0; i < n; i++) {
    out.push(new Map([
      ["__name__", "http_requests_total"],
      ["service", `svc-${i % 200}`],
      ["region", `r-${i % 10}`],
      ["env", i % 2 === 0 ? "prod" : "dev"],
    ]));
  }
  return out;
}

function naiveIntersect(a: number[], b: number[]): number[] {
  const s = new Set(b);
  return a.filter(x => s.has(x));
}

function makeSorted(size: number, stride: number): number[] {
  const out = new Array<number>(size);
  for (let i = 0; i < size; i++) out[i] = i * stride;
  return out;
}

export default async function runPostingsBench() {
  const { MemPostings } = await import(pkgPath("dist/postings.js"));
  const suite = new Suite("postings");
  const labels = makeSeriesLabels(10_000);

  const postings = new MemPostings();
  labels.forEach((l, i) => postings.add(i, l));

  suite.add("lookup_1_label", "ts", () => {
    postings.get("env", "prod");
  }, { iterations: 20_000 });

  const sizes = [100, 1000, 10_000];
  for (const size of sizes) {
    const a = makeSorted(size, 2);
    const b = makeSorted(size * 4, 1);
    const iterations = size <= 1000 ? 20_000 : 2_000;
    suite.add(`intersect_galloping_${size}`, "ts", () => postings.intersect(a, b), { iterations });
    suite.add(`intersect_naive_${size}`, "baseline", () => naiveIntersect(a, b), { iterations });
  }

  suite.add("query_match_postings", "ts", () => {
    const idsA = postings.get("__name__", "http_requests_total");
    const idsB = postings.get("env", "prod");
    postings.intersect(idsA, idsB);
  }, { iterations: 20_000 });

  suite.add("query_match_linear_scan", "baseline", () => {
    const out: number[] = [];
    for (let i = 0; i < labels.length; i++) {
      const set = labels[i]!;
      if (set.get("__name__") === "http_requests_total" && set.get("env") === "prod") out.push(i);
    }
    return out;
  }, { iterations: 2_000 });

  const report = suite.run();
  printReport(report);
  return report;
}
