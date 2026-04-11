import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import {
  downloadUrl,
  platformArch,
  resolveMetricSetsInput,
  resolveProfile,
  resolveRunId,
  validatePort,
  waitForOtlpHttpReady,
} from "./otel-start.js";

// ── platformArch ────────────────────────────────────────────────────

describe("platformArch", () => {
  it("returns values for the current platform", () => {
    // We can't test all platforms from one machine, but we can verify
    // that the current platform is handled without throwing.
    const result = platformArch();
    assert.ok(["linux", "darwin", "windows"].includes(result.os));
    assert.ok(["amd64", "arm64"].includes(result.arch));
    assert.ok(["tar.gz", "zip"].includes(result.ext));
  });

  it("uses tar.gz for non-windows and zip for windows", () => {
    const result = platformArch();
    if (process.platform === "win32") {
      assert.equal(result.ext, "zip");
    } else {
      assert.equal(result.ext, "tar.gz");
    }
  });

  it("throws for unsupported platform", () => {
    // Mock process.platform with a Symbol to bypass type safety
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    try {
      assert.throws(() => platformArch(), /Unsupported platform/);
    } finally {
      // Restore original property
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      } else {
        delete (process as unknown as Record<string, unknown>).platform;
      }
    }
  });

  it("throws for unsupported architecture", () => {
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch");
    Object.defineProperty(process, "arch", { value: "mips", configurable: true });
    try {
      assert.throws(() => platformArch(), /Unsupported architecture/);
    } finally {
      if (originalArch) {
        Object.defineProperty(process, "arch", originalArch);
      } else {
        delete (process as unknown as Record<string, unknown>).arch;
      }
    }
  });
});

describe("resolveProfile", () => {
  it("accepts default and ci", () => {
    assert.equal(resolveProfile("default"), "default");
    assert.equal(resolveProfile("ci"), "ci");
    assert.equal(resolveProfile(""), "default");
  });

  it("rejects unknown profiles", () => {
    assert.throws(() => resolveProfile("prod"), /Invalid profile/);
  });
});

describe("resolveMetricSetsInput", () => {
  it("uses explicit metric sets when provided", () => {
    assert.deepEqual(resolveMetricSetsInput("cpu,memory,process", "ci"), [
      "cpu",
      "memory",
      "process",
    ]);
  });

  it("uses ci defaults when empty and profile=ci", () => {
    assert.deepEqual(resolveMetricSetsInput("", "ci"), [
      "cpu",
      "memory",
      "load",
      "process",
    ]);
  });

  it("uses default profile defaults when empty", () => {
    assert.deepEqual(resolveMetricSetsInput("", "default"), [
      "cpu",
      "memory",
      "load",
      "process",
    ]);
  });
});

// ── downloadUrl ─────────────────────────────────────────────────────

describe("downloadUrl", () => {
  it("builds correct URL for linux amd64", () => {
    const url = downloadUrl("0.102.0", "linux", "amd64", "tar.gz");
    assert.equal(
      url,
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.102.0/otelcol-contrib_0.102.0_linux_amd64.tar.gz",
    );
  });

  it("builds correct URL for darwin arm64", () => {
    const url = downloadUrl("0.102.0", "darwin", "arm64", "tar.gz");
    assert.equal(
      url,
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.102.0/otelcol-contrib_0.102.0_darwin_arm64.tar.gz",
    );
  });

  it("builds correct URL for windows", () => {
    const url = downloadUrl("0.102.0", "windows", "amd64", "zip");
    assert.equal(
      url,
      "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.102.0/otelcol-contrib_0.102.0_windows_amd64.zip",
    );
  });

  it("handles different versions", () => {
    const url = downloadUrl("0.110.0", "linux", "arm64", "tar.gz");
    assert.match(url, /v0\.110\.0/);
    assert.match(url, /otelcol-contrib_0\.110\.0_linux_arm64\.tar\.gz/);
  });
});

// ── resolveRunId ───────────────────────────────────────────────────

describe("resolveRunId", () => {
  it("falls back to local-<timestamp> when no env or input", () => {
    // resolveRunId reads from core.getInput (which returns '' by default in tests)
    // and env vars. With no GITHUB_RUN_ID set, it should return local-<timestamp>.
    const saved = process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ID;
    try {
      const id = resolveRunId();
      assert.match(id, /^local-\d+$/);
    } finally {
      if (saved !== undefined) process.env.GITHUB_RUN_ID = saved;
    }
  });

  it("uses GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT from env", () => {
    const savedId = process.env.GITHUB_RUN_ID;
    const savedAttempt = process.env.GITHUB_RUN_ATTEMPT;
    process.env.GITHUB_RUN_ID = "99887766";
    process.env.GITHUB_RUN_ATTEMPT = "3";
    try {
      const id = resolveRunId();
      assert.equal(id, "99887766-3");
    } finally {
      if (savedId !== undefined) process.env.GITHUB_RUN_ID = savedId;
      else delete process.env.GITHUB_RUN_ID;
      if (savedAttempt !== undefined) process.env.GITHUB_RUN_ATTEMPT = savedAttempt;
      else delete process.env.GITHUB_RUN_ATTEMPT;
    }
  });

  it("sanitizes path traversal characters in runId", () => {
    const savedId = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_RUN_ID = "../../etc/passwd";
    try {
      const id = resolveRunId();
      assert.doesNotMatch(id, /\.\.\//);
      assert.doesNotMatch(id, /\//);
    } finally {
      if (savedId !== undefined) process.env.GITHUB_RUN_ID = savedId;
      else delete process.env.GITHUB_RUN_ID;
    }
  });
});

// ── validatePort ───────────────────────────────────────────────────

describe("validatePort", () => {
  it("accepts valid port numbers", () => {
    assert.equal(validatePort("otlp-grpc-port", "4317"), 4317);
    assert.equal(validatePort("otlp-http-port", "4318"), 4318);
    assert.equal(validatePort("otlp-grpc-port", "1"), 1);
    assert.equal(validatePort("otlp-grpc-port", "65535"), 65535);
  });

  it("throws for non-numeric input", () => {
    assert.throws(
      () => validatePort("otlp-grpc-port", "abc"),
      /Invalid port number for otlp-grpc-port: expected a number, got 'abc'/,
    );
  });

  it("throws for empty string after fallback resolution", () => {
    assert.throws(
      () => validatePort("otlp-http-port", ""),
      /Invalid port number for otlp-http-port: expected a number, got ''/,
    );
  });

  it("throws for port 0", () => {
    assert.throws(
      () => validatePort("otlp-grpc-port", "0"),
      /Invalid port number for otlp-grpc-port: 0 is out of range/,
    );
  });

  it("throws for port above 65535", () => {
    assert.throws(
      () => validatePort("otlp-grpc-port", "65536"),
      /Invalid port number for otlp-grpc-port: 65536 is out of range/,
    );
  });

  it("throws for negative port", () => {
    assert.throws(
      () => validatePort("otlp-http-port", "-1"),
      /Invalid port number for otlp-http-port: -1 is out of range/,
    );
  });
});

describe("waitForOtlpHttpReady", () => {
  it("returns true once an HTTP endpoint responds", async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("ready");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    try {
      assert.equal(await waitForOtlpHttpReady(address.port, 500, 10), true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("returns false when the endpoint never becomes ready", async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));

    assert.equal(await waitForOtlpHttpReady(port, 50, 10), false);
  });
});

// ── validatePort — error paths ──────────────────────────────────────

describe("validatePort — error paths", () => {
  it("rejects non-numeric strings", () => {
    assert.throws(
      () => validatePort("otlp-grpc-port", "abc"),
      /Invalid port number for otlp-grpc-port: expected a number/,
    );
  });

  it("rejects port 0", () => {
    assert.throws(
      () => validatePort("otlp-http-port", "0"),
      /out of range/,
    );
  });

  it("rejects port above 65535", () => {
    assert.throws(
      () => validatePort("otlp-grpc-port", "70000"),
      /out of range/,
    );
  });

  it("rejects negative ports", () => {
    assert.throws(
      () => validatePort("otlp-http-port", "-1"),
      /out of range/,
    );
  });

  it("accepts valid port numbers", () => {
    assert.equal(validatePort("test", "4317"), 4317);
    assert.equal(validatePort("test", "1"), 1);
    assert.equal(validatePort("test", "65535"), 65535);
  });
});
