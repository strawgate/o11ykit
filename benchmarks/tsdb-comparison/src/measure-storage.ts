/**
 * Storage measurement — measures disk usage for each TSDB.
 *
 * Two methods:
 * 1. `docker exec du` on the data directory inside each container
 *    (falls back to `find` + `stat` for distroless images like Mimir)
 * 2. Internal metrics APIs (TSDB-specific)
 */

import { execSync } from "node:child_process";
import type { TsdbTarget } from "./config.js";

export interface StorageResult {
  target: string;
  /** Total bytes on disk (from du) */
  diskBytes: number;
  /** Human-readable disk size */
  diskHuman: string;
  /** Breakdown by subdirectory */
  breakdown: Record<string, number>;
  /** Internal metrics (TSDB-specific) */
  internalMetrics: Record<string, string>;
}

function dockerExec(container: string, cmd: string): string {
  try {
    const raw = execSync(`docker exec ${container} ${cmd}`, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return raw.trim();
  } catch {
    return "";
  }
}

/**
 * Measure directory size - tries `du` inside the container first,
 * then `find`+`stat`, then falls back to host-side volume measurement
 * for distroless containers (like Mimir).
 */
function measureDirBytes(container: string, dir: string, volumeName: string): number {
  // Try du first (works for Prometheus, VictoriaMetrics)
  const duOutput = dockerExec(container, `du -sb ${dir}`);
  if (duOutput) {
    const bytes = parseInt(duOutput.split("\t")[0], 10);
    if (!isNaN(bytes) && bytes > 0) return bytes;
  }

  // Fallback: use find + stat (works in some distroless images)
  const findOutput = dockerExec(container, `find ${dir} -type f -exec stat -c '%s' {} +`);
  if (findOutput) {
    let total = 0;
    for (const line of findOutput.split("\n")) {
      const n = parseInt(line.trim(), 10);
      if (!isNaN(n)) total += n;
    }
    if (total > 0) return total;
  }

  // Last resort: measure from host side using podman volume inspect
  try {
    const raw = execSync(
      `podman volume inspect ${volumeName} --format '{{.Mountpoint}}'`,
      { encoding: "utf-8", timeout: 5_000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (raw) {
      const duHost = execSync(`du -sb ${raw} 2>/dev/null`, {
        encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      const bytes = parseInt(duHost.split("\t")[0], 10);
      if (!isNaN(bytes) && bytes > 0) return bytes;
    }
  } catch {
    // volume inspect may fail
  }

  return 0;
}

function parseDuBreakdown(output: string): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const line of output.trim().split("\n")) {
    const [sizeStr, path] = line.split("\t");
    if (path && sizeStr) {
      breakdown[path.trim()] = parseInt(sizeStr, 10) || 0;
    }
  }
  return breakdown;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  return `${value.toFixed(1)} ${units[exp]}`;
}

async function queryInternalMetrics(target: TsdbTarget): Promise<Record<string, string>> {
  const metrics: Record<string, string> = {};

  try {
    if (target.name === "Prometheus") {
      const resp = await fetch("http://localhost:9090/api/v1/status/tsdb");
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        metrics["tsdb_status"] = JSON.stringify(data, null, 2).slice(0, 500);
      }

      const countResp = await fetch(
        'http://localhost:9090/api/v1/query?query=count({__name__=~".+"})'
      );
      if (countResp.ok) {
        const countData = (await countResp.json()) as {
          data?: { result?: { value?: [number, string] }[] };
        };
        const val = countData?.data?.result?.[0]?.value?.[1];
        if (val) metrics["series_count"] = val;
      }
    } else if (target.name === "VictoriaMetrics") {
      const resp = await fetch("http://localhost:8428/api/v1/status/tsdb");
      if (resp.ok) {
        const data = await resp.json() as Record<string, unknown>;
        metrics["tsdb_status"] = JSON.stringify(data, null, 2).slice(0, 500);
      }

      const countResp = await fetch(
        'http://localhost:8428/api/v1/query?query=count({__name__=~".+"})'
      );
      if (countResp.ok) {
        const countData = (await countResp.json()) as {
          data?: { result?: { value?: [number, string] }[] };
        };
        const val = countData?.data?.result?.[0]?.value?.[1];
        if (val) metrics["series_count"] = val;
      }
    } else if (target.name === "Mimir") {
      const headers = { "X-Scope-OrgID": "benchmark" };
      const countResp = await fetch(
        'http://localhost:9009/prometheus/api/v1/query?query=count({__name__=~".+"})',
        { headers },
      );
      if (countResp.ok) {
        const countData = (await countResp.json()) as {
          data?: { result?: { value?: [number, string] }[] };
        };
        const val = countData?.data?.result?.[0]?.value?.[1];
        if (val) metrics["series_count"] = val;
      }
    }
  } catch (err) {
    metrics["error"] = (err as Error).message;
  }

  return metrics;
}

/**
 * Force each TSDB to flush/compact before measuring storage.
 */
async function flushTsdbs(): Promise<void> {
  console.log("  Flushing TSDBs...");

  // Prometheus: trigger TSDB admin snapshot or head compaction
  try {
    await fetch("http://localhost:9090/api/v1/admin/tsdb/snapshot", {
      method: "POST",
    });
  } catch {
    // May not be enabled — that's OK
  }

  // VictoriaMetrics: force flush via /internal/force_flush
  try {
    await fetch("http://localhost:8428/internal/force_flush", {
      method: "GET",
    });
  } catch {
    // Older versions may not have this
  }

  // Mimir: flush ingester to force block creation
  try {
    await fetch("http://localhost:9009/ingester/flush", {
      method: "POST",
    });
  } catch {
    // May not be available
  }

  // Wait for flushes to complete
  await new Promise((r) => setTimeout(r, 5000));
}

/**
 * Measure storage for all targets.
 */
export async function measureStorage(
  targets: TsdbTarget[],
): Promise<StorageResult[]> {
  console.log("\nMeasuring storage...");

  await flushTsdbs();

  const results: StorageResult[] = [];

  for (const target of targets) {
    console.log(`\n  ${target.name}:`);

    const diskBytes = measureDirBytes(target.containerName, target.dataDir, target.volumeName);

    // Breakdown by top-level subdirectories (best-effort)
    const breakdownOutput = dockerExec(
      target.containerName,
      `du -sb ${target.dataDir}/* 2>/dev/null`
    );
    const breakdown = parseDuBreakdown(breakdownOutput);

    const internalMetrics = await queryInternalMetrics(target);

    const diskHuman = formatBytes(diskBytes);
    console.log(`    Disk: ${diskHuman} (${diskBytes} bytes)`);
    if (internalMetrics.series_count) {
      console.log(`    Series count: ${internalMetrics.series_count}`);
    }

    results.push({
      target: target.name,
      diskBytes,
      diskHuman,
      breakdown,
      internalMetrics,
    });
  }

  return results;
}
