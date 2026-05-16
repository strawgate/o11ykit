require('./sourcemap-register.js');/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ 937:
/***/ (function(__unused_webpack_module, exports, __nccwpck_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.__test = void 0;
exports.runCli = runCli;
const format_1 = __nccwpck_require__(575);
const fs = __importStar(__nccwpck_require__(24));
const path = __importStar(__nccwpck_require__(760));
const RESERVED_POINT_ATTRIBUTES = new Set([
    "benchkit.scenario",
    "benchkit.series",
    "benchkit.metric.direction",
    "benchkit.metric.role",
]);
function printHelp() {
    console.log(`benchkit-emit — emit a custom OTLP metric via benchkit monitor\n\nUsage:\n  benchkit-emit --name <metric> --value <number> [options]\n\nOptions:\n  --name <name>                    Metric name (required)\n  --value <number>                 Metric value (required)\n  --unit <unit>                    Metric unit (ms, bytes, %, etc.)\n  --scenario <scenario>            Scenario label (default: metric name)\n  --series <series>                Series label (default: GITHUB_JOB or 'default')\n  --direction <dir>                bigger_is_better|smaller_is_better|up|down\n  --role <role>                    outcome|diagnostic (default: outcome)\n  --kind <kind>                    code|workflow|hybrid (default: hybrid)\n  --run-id <id>                    Override run id (default: BENCHKIT_RUN_ID or GITHUB_RUN_ID-attempt)\n  --endpoint <url>                 OTLP HTTP endpoint (default: BENCHKIT_EMIT_ENDPOINT)\n  --output <dir>                   Output directory for *.otlp.json fallback (default: BENCHKIT_METRICS_DIR)\n  --timeout-ms <ms>                HTTP timeout in milliseconds (default: 10000)\n  --attribute <k=v>                Repeatable datapoint attribute\n  --resource-attribute <k=v>       Repeatable resource attribute\n  --help                           Show this help\n\nBehavior:\n  If --endpoint (or BENCHKIT_EMIT_ENDPOINT) is set, emits over HTTP.\n  If no endpoint is set, or emission fails and --output is available, writes an OTLP JSON file.`);
}
function defaultRunId() {
    const explicit = process.env.BENCHKIT_RUN_ID;
    if (explicit)
        return explicit;
    const runId = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
    if (runId)
        return `${runId}-${attempt}`;
    return `local-${Date.now()}`;
}
function parseDirection(raw, fallbackHint) {
    if (!raw)
        return (0, format_1.inferDirection)(fallbackHint);
    const normalized = raw.trim().toLowerCase();
    if (normalized === "bigger_is_better"
        || normalized === "bigger"
        || normalized === "up"
        || normalized === "higher") {
        return "bigger_is_better";
    }
    if (normalized === "smaller_is_better"
        || normalized === "smaller"
        || normalized === "down"
        || normalized === "lower") {
        return "smaller_is_better";
    }
    throw new Error(`Unsupported direction '${raw}'. Expected bigger_is_better|smaller_is_better|up|down.`);
}
function normalizeEndpoint(endpoint) {
    const trimmed = endpoint.trim().replace(/\/+$/, "");
    if (!trimmed) {
        throw new Error("OTLP HTTP endpoint must not be empty.");
    }
    return trimmed.endsWith("/v1/metrics") ? trimmed : `${trimmed}/v1/metrics`;
}
function parseFiniteNumber(name, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`'${name}' must be a finite number. Received '${value}'.`);
    }
    return parsed;
}
function parsePositiveInteger(name, value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`'${name}' must be a positive integer. Received '${value}'.`);
    }
    return parsed;
}
function parseScalar(value) {
    const lowered = value.toLowerCase();
    if (lowered === "true")
        return true;
    if (lowered === "false")
        return false;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && value.trim() !== "") {
        return asNumber;
    }
    return value;
}
function parseKeyValueEntry(entry) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
        throw new Error(`Attribute '${entry}' must use key=value format.`);
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!key) {
        throw new Error("Attribute key must not be empty.");
    }
    return [key, parseScalar(value)];
}
function sanitizeFileName(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "metric";
}
function parseArgs(argv) {
    const flags = new Map();
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === "--help") {
            printHelp();
            process.exit(0);
        }
        if (!token.startsWith("--")) {
            throw new Error(`Unexpected argument '${token}'. Use --help for usage.`);
        }
        const key = token.slice(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`Missing value for '--${key}'.`);
        }
        i += 1;
        const existing = flags.get(key) ?? [];
        existing.push(value);
        flags.set(key, existing);
    }
    const requiredSingle = (name) => {
        const values = flags.get(name) ?? [];
        if (values.length === 0) {
            throw new Error(`Missing required argument '--${name}'.`);
        }
        return values[values.length - 1].trim();
    };
    const optionalSingle = (name) => {
        const values = flags.get(name) ?? [];
        if (values.length === 0)
            return undefined;
        return values[values.length - 1].trim();
    };
    const attributes = {};
    for (const raw of flags.get("attribute") ?? []) {
        const [key, value] = parseKeyValueEntry(raw);
        attributes[key] = value;
    }
    const resourceAttributes = {};
    for (const raw of flags.get("resource-attribute") ?? []) {
        const [key, value] = parseKeyValueEntry(raw);
        resourceAttributes[key] = value;
    }
    const name = requiredSingle("name");
    if (!name) {
        throw new Error("'--name' must not be blank.");
    }
    const unit = optionalSingle("unit");
    const scenario = optionalSingle("scenario") || name;
    const series = optionalSingle("series") || process.env.GITHUB_JOB || "default";
    const direction = parseDirection(optionalSingle("direction"), unit || name);
    const roleInput = optionalSingle("role") || "outcome";
    if (roleInput !== "outcome" && roleInput !== "diagnostic") {
        throw new Error(`Unsupported role '${roleInput}'. Expected outcome|diagnostic.`);
    }
    const kindInput = optionalSingle("kind") || "hybrid";
    if (kindInput !== "code" && kindInput !== "workflow" && kindInput !== "hybrid") {
        throw new Error(`Unsupported kind '${kindInput}'. Expected code|workflow|hybrid.`);
    }
    return {
        name,
        value: parseFiniteNumber("value", requiredSingle("value")),
        unit,
        scenario,
        series,
        direction,
        role: roleInput,
        kind: kindInput,
        runId: optionalSingle("run-id") || defaultRunId(),
        endpoint: optionalSingle("endpoint") || process.env.BENCHKIT_EMIT_ENDPOINT,
        outputDir: optionalSingle("output") || process.env.BENCHKIT_METRICS_DIR,
        timeoutMs: parsePositiveInteger("timeout-ms", optionalSingle("timeout-ms") || "10000"),
        attributes,
        resourceAttributes,
    };
}
function toOtlpAttributeValue(value) {
    if (typeof value === "boolean") {
        return { boolValue: value };
    }
    if (typeof value === "number") {
        if (Number.isSafeInteger(value)) {
            return { intValue: String(value) };
        }
        return { doubleValue: value };
    }
    return { stringValue: value };
}
function buildAttribute(key, value) {
    return {
        key,
        value: toOtlpAttributeValue(value),
    };
}
function validatePointAttributes(attributes) {
    for (const key of Object.keys(attributes)) {
        if (RESERVED_POINT_ATTRIBUTES.has(key)) {
            throw new Error(`Attribute '${key}' is reserved. Use a dedicated option instead.`);
        }
        if (key.startsWith("benchkit.")) {
            throw new Error(`Custom attributes must not use the 'benchkit.' prefix. Got '${key}'.`);
        }
    }
}
function validateResourceAttributes(attributes) {
    for (const key of Object.keys(attributes)) {
        if (key.startsWith("benchkit.")) {
            throw new Error(`Resource attributes must not use the 'benchkit.' prefix. Got '${key}'.`);
        }
    }
}
function buildPayload(options, now = new Date()) {
    validatePointAttributes(options.attributes);
    validateResourceAttributes(options.resourceAttributes);
    const timestampNanos = String(BigInt(now.getTime()) * 1000000n);
    const point = {
        timeUnixNano: timestampNanos,
        attributes: [
            buildAttribute("benchkit.scenario", options.scenario),
            buildAttribute("benchkit.series", options.series),
            buildAttribute("benchkit.metric.direction", options.direction),
            buildAttribute("benchkit.metric.role", options.role),
            ...Object.entries(options.attributes).map(([key, value]) => buildAttribute(key, value)),
        ],
        ...(Number.isSafeInteger(options.value)
            ? { asInt: String(options.value) }
            : { asDouble: options.value }),
    };
    return {
        resourceMetrics: [{
                resource: {
                    attributes: [
                        buildAttribute("benchkit.run_id", options.runId),
                        buildAttribute("benchkit.kind", options.kind),
                        buildAttribute("benchkit.source_format", "otlp"),
                        ...(process.env.GITHUB_REF ? [buildAttribute("benchkit.ref", process.env.GITHUB_REF)] : []),
                        ...(process.env.GITHUB_SHA ? [buildAttribute("benchkit.commit", process.env.GITHUB_SHA)] : []),
                        ...(process.env.GITHUB_WORKFLOW ? [buildAttribute("benchkit.workflow", process.env.GITHUB_WORKFLOW)] : []),
                        ...(process.env.GITHUB_JOB ? [buildAttribute("benchkit.job", process.env.GITHUB_JOB)] : []),
                        ...(process.env.GITHUB_RUN_ATTEMPT ? [buildAttribute("benchkit.run_attempt", process.env.GITHUB_RUN_ATTEMPT)] : []),
                        ...(process.env.GITHUB_REPOSITORY ? [buildAttribute("service.name", process.env.GITHUB_REPOSITORY)] : []),
                        ...Object.entries(options.resourceAttributes).map(([key, value]) => buildAttribute(key, value)),
                    ],
                },
                scopeMetrics: [{
                        scope: { name: "benchkit.emit.cli" },
                        metrics: [{
                                name: options.name,
                                unit: options.unit || undefined,
                                gauge: { dataPoints: [point] },
                            }],
                    }],
            }],
    };
}
async function emitToCollector(endpoint, payload, timeoutMs) {
    const url = normalizeEndpoint(endpoint);
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
        console.log(`benchkit-emit: emitted metric to ${url}`);
        return;
    }
    const body = (await response.text()).trim();
    throw new Error(`Collector rejected metric emission (${response.status} ${response.statusText})${body ? `: ${body}` : "."}`);
}
function writePayloadFile(outputDir, metricName, payload) {
    const nonce = Math.random().toString(36).slice(2, 8);
    const fileName = `emit-${sanitizeFileName(metricName)}-${Date.now()}-${nonce}.otlp.json`;
    const outputPath = path.join(outputDir, fileName);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    return outputPath;
}
async function runCli(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const payload = buildPayload(args);
    if (!args.endpoint && !args.outputDir) {
        throw new Error("No endpoint or output directory available. Set --endpoint/--output or BENCHKIT_EMIT_ENDPOINT/BENCHKIT_METRICS_DIR.");
    }
    if (args.endpoint) {
        try {
            await emitToCollector(args.endpoint, payload, args.timeoutMs);
            return;
        }
        catch (err) {
            if (!args.outputDir) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`benchkit-emit: HTTP emit failed (${message}); writing OTLP file fallback.`);
        }
    }
    if (!args.outputDir) {
        throw new Error("No output directory available for OTLP fallback file.");
    }
    const outputPath = writePayloadFile(args.outputDir, args.name, payload);
    console.log(`benchkit-emit: wrote ${outputPath}`);
}
if (require.main === require.cache[eval('__filename')]) {
    runCli().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`benchkit-emit: ${message}`);
        process.exitCode = 1;
    });
}
exports.__test = {
    buildPayload,
    parseArgs,
    parseDirection,
    normalizeEndpoint,
};
//# sourceMappingURL=cli.js.map

/***/ }),

/***/ 837:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.buildOtlpResult = buildOtlpResult;
const otlp_conventions_js_1 = __nccwpck_require__(757);
// ---- Attribute helpers ----------------------------------------------------
function toOtlpValue(value) {
    if (typeof value === "boolean")
        return { boolValue: value };
    if (typeof value === "number") {
        return Number.isSafeInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value };
    }
    return { stringValue: value };
}
function attr(key, value) {
    return { key, value: toOtlpValue(value) };
}
function dataPointValue(value) {
    return Number.isSafeInteger(value)
        ? { asInt: String(value) }
        : { asDouble: value };
}
// ---- Build ----------------------------------------------------------------
function buildResourceAttributes(ctx) {
    const attrs = [];
    if (ctx.runId)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUN_ID, ctx.runId));
    if (ctx.kind)
        attrs.push(attr(otlp_conventions_js_1.ATTR_KIND, ctx.kind));
    attrs.push(attr(otlp_conventions_js_1.ATTR_SOURCE_FORMAT, ctx.sourceFormat));
    if (ctx.ref)
        attrs.push(attr(otlp_conventions_js_1.ATTR_REF, ctx.ref));
    if (ctx.commit)
        attrs.push(attr(otlp_conventions_js_1.ATTR_COMMIT, ctx.commit));
    if (ctx.workflow)
        attrs.push(attr(otlp_conventions_js_1.ATTR_WORKFLOW, ctx.workflow));
    if (ctx.job)
        attrs.push(attr(otlp_conventions_js_1.ATTR_JOB, ctx.job));
    if (ctx.runAttempt)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUN_ATTEMPT, ctx.runAttempt));
    if (ctx.runner)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUNNER, ctx.runner));
    if (ctx.serviceName)
        attrs.push(attr(otlp_conventions_js_1.ATTR_SERVICE_NAME, ctx.serviceName));
    if (ctx.resourceAttributes) {
        for (const [key, value] of Object.entries(ctx.resourceAttributes)) {
            attrs.push(attr(key, value));
        }
    }
    return attrs;
}
function normalizeMetric(input) {
    return typeof input === "number" ? { value: input } : input;
}
/**
 * Build an OtlpMetricsDocument from a list of benchmarks and optional context.
 *
 * Each benchmark becomes a scenario. Each metric key within a benchmark
 * becomes a separate OTLP metric with a single gauge datapoint carrying
 * benchkit semantic attributes.
 */
function buildOtlpResult(options) {
    const ctx = options.context ?? { sourceFormat: "otlp" };
    const now = String(BigInt(Date.now()) * 1000000n);
    const metrics = [];
    for (const bench of options.benchmarks) {
        for (const [metricName, rawMetric] of Object.entries(bench.metrics)) {
            const m = normalizeMetric(rawMetric);
            const pointAttrs = [
                attr(otlp_conventions_js_1.ATTR_SCENARIO, bench.name),
                attr(otlp_conventions_js_1.ATTR_SERIES, bench.name),
                attr(otlp_conventions_js_1.ATTR_METRIC_ROLE, "outcome"),
            ];
            if (m.direction) {
                pointAttrs.push(attr(otlp_conventions_js_1.ATTR_METRIC_DIRECTION, m.direction));
            }
            if (bench.tags) {
                for (const [k, v] of Object.entries(bench.tags)) {
                    pointAttrs.push(attr(k, v));
                }
            }
            metrics.push({
                name: metricName,
                unit: m.unit,
                gauge: {
                    dataPoints: [{
                            timeUnixNano: now,
                            attributes: pointAttrs,
                            ...dataPointValue(m.value),
                        }],
                },
            });
        }
    }
    return {
        resourceMetrics: [{
                resource: {
                    attributes: buildResourceAttributes(ctx),
                },
                scopeMetrics: [{
                        metrics,
                    }],
            }],
    };
}
//# sourceMappingURL=build-otlp-result.js.map

/***/ }),

/***/ 16:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.compareRuns = compareRuns;
const infer_direction_js_1 = __nccwpck_require__(83);
const DEFAULT_CONFIG = { test: "percentage", threshold: 5 };
const MAX_EXPECTED_LANES = 10_000;
function normalizeDimensionValue(value) {
    return String(value);
}
function normalizeSeriesValue(series, scenario) {
    if (!series || series === scenario) {
        return undefined;
    }
    return series;
}
function normalizePointTags(tags) {
    return Object.fromEntries(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));
}
function formatTagSuffix(tags) {
    const entries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
        return "";
    }
    return ` [${entries.map(([key, value]) => `${key}=${value}`).join(", ")}]`;
}
function formatPointLane(point) {
    const normalizedSeries = normalizeSeriesValue(point.series, point.scenario);
    const seriesPart = normalizedSeries
        ? ` / ${normalizedSeries}`
        : "";
    return `${point.scenario}${seriesPart}${formatTagSuffix(point.tags)}`;
}
function pointComparisonKey(point) {
    return JSON.stringify([
        point.scenario,
        normalizeSeriesValue(point.series, point.scenario),
        Object.entries(normalizePointTags(point.tags)),
        point.metric,
    ]);
}
function getPointDimensionValue(point, dimension) {
    if (dimension === "scenario" || dimension === "benchmark") {
        return point.scenario;
    }
    if (dimension === "series") {
        return normalizeSeriesValue(point.series, point.scenario);
    }
    return point.tags[dimension];
}
function getEntryDimensionValue(entry, dimension) {
    if (dimension === "scenario" || dimension === "benchmark") {
        return entry.benchmark;
    }
    if (dimension === "series") {
        return normalizeSeriesValue(entry.series, entry.benchmark);
    }
    return entry.tags?.[dimension];
}
function cartesianDimensions(entries, index = 0, current = {}) {
    if (index >= entries.length) {
        return [{ ...current }];
    }
    const [name, values] = entries[index];
    const lanes = [];
    for (const value of values) {
        current[name] = normalizeDimensionValue(value);
        lanes.push(...cartesianDimensions(entries, index + 1, current));
    }
    delete current[name];
    return lanes;
}
function validateLaneBudget(entries) {
    let expectedLaneCount = 1;
    for (const [name, values] of entries) {
        expectedLaneCount *= values.length;
        if (expectedLaneCount > MAX_EXPECTED_LANES) {
            throw new Error(`matrix-policy expands to ${expectedLaneCount.toLocaleString("en-US")} lanes after '${name}', exceeding the limit of ${MAX_EXPECTED_LANES.toLocaleString("en-US")}`);
        }
    }
}
function toNumber(value) {
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value)) {
        return null;
    }
    return Number(value);
}
function matchesMatcherValue(actual, matcher) {
    if (Array.isArray(matcher)) {
        return matcher.map(normalizeDimensionValue).includes(actual);
    }
    if (typeof matcher !== "object" || matcher === null) {
        return normalizeDimensionValue(matcher) === actual;
    }
    const exact = matcher.eq;
    if (exact !== undefined && normalizeDimensionValue(exact) !== actual) {
        return false;
    }
    const includes = matcher.in;
    if (includes && !includes.map(normalizeDimensionValue).includes(actual)) {
        return false;
    }
    const excludes = matcher.notIn;
    if (excludes && excludes.map(normalizeDimensionValue).includes(actual)) {
        return false;
    }
    const numeric = toNumber(actual);
    if (matcher.lt !== undefined
        || matcher.lte !== undefined
        || matcher.gt !== undefined
        || matcher.gte !== undefined) {
        if (numeric === null) {
            return false;
        }
        if (matcher.lt !== undefined && !(numeric < matcher.lt)) {
            return false;
        }
        if (matcher.lte !== undefined && !(numeric <= matcher.lte)) {
            return false;
        }
        if (matcher.gt !== undefined && !(numeric > matcher.gt)) {
            return false;
        }
        if (matcher.gte !== undefined && !(numeric >= matcher.gte)) {
            return false;
        }
    }
    return true;
}
function matchesLane(dimensions, matcher) {
    return Object.entries(matcher).every(([dimension, expected]) => {
        const actual = dimensions[dimension];
        if (actual === undefined) {
            return false;
        }
        return matchesMatcherValue(actual, expected);
    });
}
function classifyLane(dimensions, policy) {
    if (policy.required?.some((matcher) => matchesLane(dimensions, matcher))) {
        return "required";
    }
    if (policy.probe?.some((matcher) => matchesLane(dimensions, matcher))) {
        return "probe";
    }
    return "required";
}
function formatMatrixLaneLabel(dimensions) {
    return Object.entries(dimensions)
        .map(([dimension, value]) => `${dimension}=${value}`)
        .join(", ");
}
function laneDimensionsKey(dimensions) {
    return JSON.stringify(Object.entries(dimensions).sort(([a], [b]) => a.localeCompare(b)));
}
function pointMatrixDimensions(point, dimensionNames) {
    const dimensions = {};
    for (const name of dimensionNames) {
        const value = getPointDimensionValue(point, name);
        if (value === undefined || value === "") {
            return null;
        }
        dimensions[name] = value;
    }
    return dimensions;
}
function entryMatrixDimensions(entry, dimensionNames) {
    const dimensions = {};
    for (const name of dimensionNames) {
        const value = getEntryDimensionValue(entry, name);
        if (value === undefined || value === "") {
            return null;
        }
        dimensions[name] = value;
    }
    return dimensions;
}
function computeMatrixSummary(current, entries, policy) {
    const dimensionEntries = Object.entries(policy.dimensions);
    validateLaneBudget(dimensionEntries);
    const dimensionNames = dimensionEntries.map(([name]) => name);
    const expectedDimensions = cartesianDimensions(dimensionEntries).filter((dimensions) => !policy.excludes?.some((matcher) => matchesLane(dimensions, matcher)));
    const expectedLaneKeys = new Set(expectedDimensions.map((dimensions) => laneDimensionsKey(dimensions)));
    const regressedLaneKeys = new Set(entries
        .filter((entry) => entry.status === "regressed")
        .map((entry) => entryMatrixDimensions(entry, dimensionNames))
        .filter((dimensions) => dimensions !== null)
        .map((dimensions) => laneDimensionsKey(dimensions)));
    const observedExpectedLaneKeys = new Set();
    for (const point of current.points) {
        if (point.scenario.startsWith("_monitor/")) {
            continue;
        }
        const dimensions = pointMatrixDimensions(point, dimensionNames);
        if (!dimensions) {
            continue;
        }
        const key = laneDimensionsKey(dimensions);
        if (expectedLaneKeys.has(key)) {
            observedExpectedLaneKeys.add(key);
        }
    }
    const lanes = expectedDimensions.map((dimensions) => {
        const key = laneDimensionsKey(dimensions);
        const laneClass = classifyLane(dimensions, policy);
        const observed = observedExpectedLaneKeys.has(key);
        let status;
        if (!observed) {
            status = "missing";
        }
        else if (regressedLaneKeys.has(key)) {
            status = "failed";
        }
        else {
            status = "passed";
        }
        return {
            key,
            label: formatMatrixLaneLabel(dimensions),
            dimensions,
            laneClass,
            status,
        };
    });
    lanes.sort((a, b) => a.label.localeCompare(b.label));
    const requiredPassedCount = lanes.filter((lane) => lane.laneClass === "required" && lane.status === "passed").length;
    const requiredFailedCount = lanes.filter((lane) => lane.laneClass === "required" && lane.status === "failed").length;
    const probePassedCount = lanes.filter((lane) => lane.laneClass === "probe" && lane.status === "passed").length;
    const probeFailedCount = lanes.filter((lane) => lane.laneClass === "probe" && lane.status === "failed").length;
    const missingResultCount = lanes.filter((lane) => lane.status === "missing").length;
    return {
        expectedCount: lanes.length,
        observedCount: observedExpectedLaneKeys.size,
        missingResultCount,
        requiredPassedCount,
        requiredFailedCount,
        probePassedCount,
        probeFailedCount,
        hasRequiredFailure: requiredFailedCount > 0 || lanes.some((lane) => lane.laneClass === "required" && lane.status === "missing"),
        lanes,
    };
}
/**
 * Compare a current benchmark run against one or more baseline runs.
 *
 * Baseline values are averaged across the provided runs. For each lane+metric
 * pair in `current`, the function computes a percentage change and applies the
 * threshold test to classify the result as improved, stable, or regressed.
 *
 * Metrics present in `current` but absent from every baseline are excluded —
 * new metrics have no history to regress against.
 *
 * When a matrix policy is provided, the result also includes completeness and
 * required/probe lane summaries derived from the current run.
 */
function compareRuns(current, baseline, config = DEFAULT_CONFIG) {
    const baselineMap = new Map();
    for (const run of baseline) {
        for (const point of run.points) {
            const key = pointComparisonKey(point);
            let entry = baselineMap.get(key);
            if (!entry) {
                entry = { values: [], point };
                baselineMap.set(key, entry);
            }
            entry.values.push(point.value);
        }
    }
    const entries = [];
    const warnings = [];
    for (const point of current.points) {
        const baselineEntry = baselineMap.get(pointComparisonKey(point));
        if (!baselineEntry || baselineEntry.values.length === 0) {
            continue;
        }
        const baselineAvg = baselineEntry.values.reduce((a, b) => a + b, 0) / baselineEntry.values.length;
        if (baselineAvg === 0) {
            warnings.push(`Skipped metric '${point.metric}' for benchmark '${formatPointLane(point)}': baseline mean is zero`);
            continue;
        }
        const direction = point.direction ?? (0, infer_direction_js_1.inferDirection)(point.unit || point.metric);
        const rawChange = ((point.value - baselineAvg) / baselineAvg) * 100;
        const isWorse = direction === "smaller_is_better" ? rawChange > 0 : rawChange < 0;
        const isBetter = direction === "smaller_is_better" ? rawChange < 0 : rawChange > 0;
        const absChange = Math.abs(rawChange);
        let status;
        if (absChange <= config.threshold) {
            status = "stable";
        }
        else if (isWorse) {
            status = "regressed";
        }
        else if (isBetter) {
            status = "improved";
        }
        else {
            status = "stable";
        }
        entries.push({
            benchmark: point.scenario,
            ...(point.series && point.series !== point.scenario ? { series: point.series } : {}),
            ...(Object.keys(point.tags).length > 0 ? { tags: normalizePointTags(point.tags) } : {}),
            lane: formatPointLane(point),
            metric: point.metric,
            unit: point.unit || undefined,
            direction,
            baseline: baselineAvg,
            current: point.value,
            percentChange: Math.round(rawChange * 100) / 100,
            status,
        });
    }
    let matrix;
    if (config.matrixPolicy) {
        const dimensionNames = Object.keys(config.matrixPolicy.dimensions);
        matrix = computeMatrixSummary(current, entries, config.matrixPolicy);
        const laneClassByKey = new Map(matrix.lanes.map((lane) => [lane.key, lane.laneClass]));
        for (const entry of entries) {
            const dimensions = entryMatrixDimensions(entry, dimensionNames);
            if (!dimensions) {
                continue;
            }
            const key = laneDimensionsKey(dimensions);
            const laneClass = laneClassByKey.get(key);
            if (laneClass) {
                entry.laneClass = laneClass;
            }
        }
    }
    return {
        entries,
        hasRegression: entries.some((entry) => entry.status === "regressed"),
        ...(matrix ? { matrix } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
//# sourceMappingURL=compare.js.map

/***/ }),

/***/ 160:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.formatComparisonMarkdown = formatComparisonMarkdown;
const DEFAULT_OPTIONS = {
    currentLabel: "Current",
    baselineLabel: "Baseline",
    maxRegressions: 10,
    includeDetails: true,
    footerHref: "https://github.com/strawgate/octo11y",
};
function isMonitorEntry(entry) {
    return entry.benchmark.startsWith("_monitor/");
}
function sortAlphabetically(entries) {
    return [...entries].sort((a, b) => {
        const laneA = a.lane ?? a.benchmark;
        const laneB = b.lane ?? b.benchmark;
        if (laneA !== laneB)
            return laneA.localeCompare(laneB);
        return a.metric.localeCompare(b.metric);
    });
}
function formatNumber(value) {
    if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
        return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
    }
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function formatValue(value, unit) {
    return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}
function formatPercent(value) {
    return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function directionArrow(entry) {
    if (entry.status === "stable")
        return "→";
    if (entry.direction === "smaller_is_better") {
        return entry.status === "regressed" ? "↑" : "↓";
    }
    return entry.status === "regressed" ? "↓" : "↑";
}
function statusLabel(entry) {
    return `${entry.status} ${directionArrow(entry)}`;
}
function laneLabel(entry) {
    return entry.lane ?? entry.benchmark;
}
function classLabel(entry) {
    return entry.laneClass ?? "—";
}
function formatCurrentRef(ref) {
    const prMatch = /^refs\/pull\/(\d+)\/merge$/.exec(ref);
    if (prMatch) {
        return `PR #${prMatch[1]}`;
    }
    return ref;
}
function formatHeader(options) {
    const lines = [];
    lines.push(`## ${options.title ?? "Benchmark Comparison"}`);
    if (options.currentCommit || options.currentRef) {
        const parts = [
            options.currentCommit ? `commit \`${options.currentCommit.slice(0, 8)}\`` : "",
            options.currentRef ? `ref \`${formatCurrentRef(options.currentRef)}\`` : "",
        ].filter(Boolean);
        lines.push(`Comparing results for ${parts.join(" on ")}.`);
    }
    return lines;
}
function formatTable(entries, options) {
    const includeLaneClass = entries.some((entry) => entry.laneClass);
    const lines = includeLaneClass
        ? [
            `| Lane | Class | Metric | ${options.baselineLabel} | ${options.currentLabel} | Δ% | Status |`,
            "| --- | --- | --- | --- | --- | --- | --- |",
        ]
        : [
            `| Lane | Metric | ${options.baselineLabel} | ${options.currentLabel} | Δ% | Status |`,
            "| --- | --- | --- | --- | --- | --- |",
        ];
    for (const entry of sortAlphabetically(entries)) {
        if (includeLaneClass) {
            lines.push(`| \`${laneLabel(entry)}\` | \`${classLabel(entry)}\` | \`${entry.metric}\` | ${formatValue(entry.baseline, entry.unit)} | ${formatValue(entry.current, entry.unit)} | ${formatPercent(entry.percentChange)} | ${statusLabel(entry)} |`);
            continue;
        }
        lines.push(`| \`${laneLabel(entry)}\` | \`${entry.metric}\` | ${formatValue(entry.baseline, entry.unit)} | ${formatValue(entry.current, entry.unit)} | ${formatPercent(entry.percentChange)} | ${statusLabel(entry)} |`);
    }
    return lines;
}
function groupByMetric(entries) {
    const grouped = new Map();
    for (const entry of entries) {
        const key = entry.metric;
        const existing = grouped.get(key);
        if (existing)
            existing.push(entry);
        else
            grouped.set(key, [entry]);
    }
    return new Map([...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}
function formatMatrixSummary(result) {
    if (!result.matrix) {
        return [];
    }
    const lines = [
        "### Matrix Summary",
        "",
        "| Expected | Observed | Missing | Required Failed | Probe Failed |",
        "| --- | --- | --- | --- | --- |",
        `| ${result.matrix.expectedCount} | ${result.matrix.observedCount} | ${result.matrix.missingResultCount} | ${result.matrix.requiredFailedCount} | ${result.matrix.probeFailedCount} |`,
        "",
        "| Class | Passed | Failed | Missing |",
        "| --- | --- | --- | --- |",
        `| \`required\` | ${result.matrix.requiredPassedCount} | ${result.matrix.requiredFailedCount} | ${result.matrix.lanes.filter((lane) => lane.laneClass === "required" && lane.status === "missing").length} |`,
        `| \`probe\` | ${result.matrix.probePassedCount} | ${result.matrix.probeFailedCount} | ${result.matrix.lanes.filter((lane) => lane.laneClass === "probe" && lane.status === "missing").length} |`,
        "",
    ];
    const interestingLanes = result.matrix.lanes.filter((lane) => lane.status !== "passed");
    if (interestingLanes.length > 0) {
        lines.push("### Matrix Lane Outcomes");
        lines.push("");
        lines.push(...formatLaneOutcomeTable(interestingLanes));
        lines.push("");
    }
    return lines;
}
function sortLanes(lanes) {
    return [...lanes].sort((a, b) => a.label.localeCompare(b.label));
}
function formatLaneOutcomeTable(lanes) {
    const lines = [
        "| Lane | Class | Status |",
        "| --- | --- | --- |",
    ];
    for (const lane of sortLanes(lanes)) {
        lines.push(`| \`${lane.label}\` | \`${lane.laneClass}\` | \`${lane.status}\` |`);
    }
    return lines;
}
function formatComparisonMarkdown(result, options = {}) {
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    const lines = [];
    lines.push(...formatHeader(options));
    lines.push("");
    lines.push(...formatMatrixSummary(result));
    const benchmarkEntries = result.entries.filter((entry) => !isMonitorEntry(entry));
    const monitorEntries = result.entries.filter((entry) => isMonitorEntry(entry));
    const regressions = sortAlphabetically(result.entries.filter((entry) => entry.status === "regressed"));
    if (result.entries.length === 0) {
        lines.push("No comparable baseline data found.");
        lines.push("");
    }
    else if (regressions.length > 0) {
        lines.push("### Regressions");
        lines.push("");
        lines.push(...formatTable(regressions.slice(0, resolved.maxRegressions), resolved));
        if (regressions.length > resolved.maxRegressions) {
            lines.push("");
            lines.push(`Showing ${resolved.maxRegressions} of ${regressions.length} regressions.`);
        }
        lines.push("");
    }
    else {
        lines.push("No regressions detected.");
        lines.push("");
    }
    if (benchmarkEntries.length > 0) {
        lines.push("### Benchmark Metrics");
        lines.push("");
        lines.push(...formatTable(benchmarkEntries, resolved));
        lines.push("");
    }
    if (monitorEntries.length > 0) {
        lines.push("### Monitor Metrics");
        lines.push("");
        lines.push(...formatTable(monitorEntries, resolved));
        lines.push("");
    }
    if (resolved.includeDetails && result.entries.length > 0) {
        const grouped = groupByMetric(result.entries);
        lines.push("<details>");
        lines.push("<summary>Per-metric detail</summary>");
        lines.push("");
        for (const [metric, entries] of grouped.entries()) {
            lines.push(`#### \`${metric}\``);
            lines.push("");
            lines.push(...formatTable(entries, resolved));
            lines.push("");
        }
        lines.push("</details>");
        lines.push("");
    }
    lines.push(`Generated by [octo11y](${resolved.footerHref}).`);
    return lines.join("\n");
}
//# sourceMappingURL=format-comparison-markdown.js.map

/***/ }),

/***/ 575:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.sleep = exports.computeRetryDelayMs = exports.formatComparisonMarkdown = exports.compareRuns = exports.isMonitorMetric = exports.isValidSourceFormat = exports.isValidMetricRole = exports.isValidDirection = exports.isValidRunKind = exports.validateSourceFormat = exports.validateMetricRole = exports.validateDirection = exports.validateRunKind = exports.validateRequiredDatapointAttributes = exports.validateRequiredResourceAttributes = exports.DEFAULT_DATA_BRANCH = exports.MONITOR_METRIC_PREFIX = exports.VALID_SOURCE_FORMATS = exports.VALID_METRIC_ROLES = exports.VALID_DIRECTIONS = exports.VALID_RUN_KINDS = exports.RESERVED_DATAPOINT_ATTRIBUTES = exports.REQUIRED_RESOURCE_ATTRIBUTES = exports.ATTR_METRIC_ROLE = exports.ATTR_METRIC_DIRECTION = exports.ATTR_SERIES = exports.ATTR_SCENARIO = exports.ATTR_SERVICE_VERSION = exports.ATTR_SERVICE_NAME = exports.ATTR_RUNNER = exports.ATTR_RUN_ATTEMPT = exports.ATTR_JOB = exports.ATTR_WORKFLOW = exports.ATTR_COMMIT = exports.ATTR_REF = exports.ATTR_SOURCE_FORMAT = exports.ATTR_KIND = exports.ATTR_RUN_ID = exports.getOtlpTemporality = exports.getOtlpMetricKind = exports.otlpAttributesToRecord = exports.parseOtlp = exports.parsePytestBenchmark = exports.parseHyperfine = exports.parseBenchmarkAction = exports.parseRustBench = exports.parseGoBench = exports.unitToMetricName = exports.inferDirection = exports.parseBenchmarks = void 0;
exports.seriesKey = exports.MetricsBatch = exports.buildOtlpResult = exports.RETRY_DELAY_MAX_MS = exports.RETRY_DELAY_MIN_MS = exports.DEFAULT_PUSH_RETRY_COUNT = void 0;
/** Parse benchmark output in any supported format (auto-detect, go, otlp, benchmark-action). */
var parse_js_1 = __nccwpck_require__(152);
Object.defineProperty(exports, "parseBenchmarks", ({ enumerable: true, get: function () { return parse_js_1.parseBenchmarks; } }));
/** Infer the `direction` ("smaller_is_better" / "bigger_is_better") from a metric unit string. */
var infer_direction_js_1 = __nccwpck_require__(83);
Object.defineProperty(exports, "inferDirection", ({ enumerable: true, get: function () { return infer_direction_js_1.inferDirection; } }));
/** Convert a benchmark unit string to a normalized metric name (e.g. "ns/op" -> "ns_per_op"). */
var parser_utils_js_1 = __nccwpck_require__(524);
Object.defineProperty(exports, "unitToMetricName", ({ enumerable: true, get: function () { return parser_utils_js_1.unitToMetricName; } }));
/** Parse Go testing/benchmark output text. */
var parse_go_js_1 = __nccwpck_require__(303);
Object.defineProperty(exports, "parseGoBench", ({ enumerable: true, get: function () { return parse_go_js_1.parseGoBench; } }));
/** Parse Rust cargo bench (libtest) output text. */
var parse_rust_js_1 = __nccwpck_require__(215);
Object.defineProperty(exports, "parseRustBench", ({ enumerable: true, get: function () { return parse_rust_js_1.parseRustBench; } }));
/** Parse benchmark-action/github-action-benchmark JSON format. */
var parse_benchmark_action_js_1 = __nccwpck_require__(985);
Object.defineProperty(exports, "parseBenchmarkAction", ({ enumerable: true, get: function () { return parse_benchmark_action_js_1.parseBenchmarkAction; } }));
/** Parse Hyperfine JSON format. */
var parse_hyperfine_js_1 = __nccwpck_require__(347);
Object.defineProperty(exports, "parseHyperfine", ({ enumerable: true, get: function () { return parse_hyperfine_js_1.parseHyperfine; } }));
/** Parse pytest-benchmark JSON format. */
var parse_pytest_benchmark_js_1 = __nccwpck_require__(956);
Object.defineProperty(exports, "parsePytestBenchmark", ({ enumerable: true, get: function () { return parse_pytest_benchmark_js_1.parsePytestBenchmark; } }));
/** Parse OTLP metrics JSON. */
var parse_otlp_js_1 = __nccwpck_require__(158);
Object.defineProperty(exports, "parseOtlp", ({ enumerable: true, get: function () { return parse_otlp_js_1.parseOtlp; } }));
Object.defineProperty(exports, "otlpAttributesToRecord", ({ enumerable: true, get: function () { return parse_otlp_js_1.otlpAttributesToRecord; } }));
Object.defineProperty(exports, "getOtlpMetricKind", ({ enumerable: true, get: function () { return parse_otlp_js_1.getOtlpMetricKind; } }));
Object.defineProperty(exports, "getOtlpTemporality", ({ enumerable: true, get: function () { return parse_otlp_js_1.getOtlpTemporality; } }));
/** OTLP semantic convention constants — attribute names, valid values, reserved keys. */
var otlp_conventions_js_1 = __nccwpck_require__(757);
Object.defineProperty(exports, "ATTR_RUN_ID", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_RUN_ID; } }));
Object.defineProperty(exports, "ATTR_KIND", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_KIND; } }));
Object.defineProperty(exports, "ATTR_SOURCE_FORMAT", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_SOURCE_FORMAT; } }));
Object.defineProperty(exports, "ATTR_REF", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_REF; } }));
Object.defineProperty(exports, "ATTR_COMMIT", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_COMMIT; } }));
Object.defineProperty(exports, "ATTR_WORKFLOW", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_WORKFLOW; } }));
Object.defineProperty(exports, "ATTR_JOB", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_JOB; } }));
Object.defineProperty(exports, "ATTR_RUN_ATTEMPT", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_RUN_ATTEMPT; } }));
Object.defineProperty(exports, "ATTR_RUNNER", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_RUNNER; } }));
Object.defineProperty(exports, "ATTR_SERVICE_NAME", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_SERVICE_NAME; } }));
Object.defineProperty(exports, "ATTR_SERVICE_VERSION", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_SERVICE_VERSION; } }));
Object.defineProperty(exports, "ATTR_SCENARIO", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_SCENARIO; } }));
Object.defineProperty(exports, "ATTR_SERIES", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_SERIES; } }));
Object.defineProperty(exports, "ATTR_METRIC_DIRECTION", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_METRIC_DIRECTION; } }));
Object.defineProperty(exports, "ATTR_METRIC_ROLE", ({ enumerable: true, get: function () { return otlp_conventions_js_1.ATTR_METRIC_ROLE; } }));
Object.defineProperty(exports, "REQUIRED_RESOURCE_ATTRIBUTES", ({ enumerable: true, get: function () { return otlp_conventions_js_1.REQUIRED_RESOURCE_ATTRIBUTES; } }));
Object.defineProperty(exports, "RESERVED_DATAPOINT_ATTRIBUTES", ({ enumerable: true, get: function () { return otlp_conventions_js_1.RESERVED_DATAPOINT_ATTRIBUTES; } }));
Object.defineProperty(exports, "VALID_RUN_KINDS", ({ enumerable: true, get: function () { return otlp_conventions_js_1.VALID_RUN_KINDS; } }));
Object.defineProperty(exports, "VALID_DIRECTIONS", ({ enumerable: true, get: function () { return otlp_conventions_js_1.VALID_DIRECTIONS; } }));
Object.defineProperty(exports, "VALID_METRIC_ROLES", ({ enumerable: true, get: function () { return otlp_conventions_js_1.VALID_METRIC_ROLES; } }));
Object.defineProperty(exports, "VALID_SOURCE_FORMATS", ({ enumerable: true, get: function () { return otlp_conventions_js_1.VALID_SOURCE_FORMATS; } }));
Object.defineProperty(exports, "MONITOR_METRIC_PREFIX", ({ enumerable: true, get: function () { return otlp_conventions_js_1.MONITOR_METRIC_PREFIX; } }));
Object.defineProperty(exports, "DEFAULT_DATA_BRANCH", ({ enumerable: true, get: function () { return otlp_conventions_js_1.DEFAULT_DATA_BRANCH; } }));
/** Runtime validators for the benchkit OTLP semantic contract. */
var otlp_validation_js_1 = __nccwpck_require__(442);
Object.defineProperty(exports, "validateRequiredResourceAttributes", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateRequiredResourceAttributes; } }));
Object.defineProperty(exports, "validateRequiredDatapointAttributes", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateRequiredDatapointAttributes; } }));
Object.defineProperty(exports, "validateRunKind", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateRunKind; } }));
Object.defineProperty(exports, "validateDirection", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateDirection; } }));
Object.defineProperty(exports, "validateMetricRole", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateMetricRole; } }));
Object.defineProperty(exports, "validateSourceFormat", ({ enumerable: true, get: function () { return otlp_validation_js_1.validateSourceFormat; } }));
Object.defineProperty(exports, "isValidRunKind", ({ enumerable: true, get: function () { return otlp_validation_js_1.isValidRunKind; } }));
Object.defineProperty(exports, "isValidDirection", ({ enumerable: true, get: function () { return otlp_validation_js_1.isValidDirection; } }));
Object.defineProperty(exports, "isValidMetricRole", ({ enumerable: true, get: function () { return otlp_validation_js_1.isValidMetricRole; } }));
Object.defineProperty(exports, "isValidSourceFormat", ({ enumerable: true, get: function () { return otlp_validation_js_1.isValidSourceFormat; } }));
Object.defineProperty(exports, "isMonitorMetric", ({ enumerable: true, get: function () { return otlp_validation_js_1.isMonitorMetric; } }));
/** Compare a current benchmark run against baseline runs to detect regressions. */
var compare_js_1 = __nccwpck_require__(16);
Object.defineProperty(exports, "compareRuns", ({ enumerable: true, get: function () { return compare_js_1.compareRuns; } }));
/** Format a ComparisonResult as markdown for job summaries and PR comments. */
var format_comparison_markdown_js_1 = __nccwpck_require__(160);
Object.defineProperty(exports, "formatComparisonMarkdown", ({ enumerable: true, get: function () { return format_comparison_markdown_js_1.formatComparisonMarkdown; } }));
/** Retry helpers for push operations. */
var retry_js_1 = __nccwpck_require__(257);
Object.defineProperty(exports, "computeRetryDelayMs", ({ enumerable: true, get: function () { return retry_js_1.computeRetryDelayMs; } }));
Object.defineProperty(exports, "sleep", ({ enumerable: true, get: function () { return retry_js_1.sleep; } }));
Object.defineProperty(exports, "DEFAULT_PUSH_RETRY_COUNT", ({ enumerable: true, get: function () { return retry_js_1.DEFAULT_PUSH_RETRY_COUNT; } }));
Object.defineProperty(exports, "RETRY_DELAY_MIN_MS", ({ enumerable: true, get: function () { return retry_js_1.RETRY_DELAY_MIN_MS; } }));
Object.defineProperty(exports, "RETRY_DELAY_MAX_MS", ({ enumerable: true, get: function () { return retry_js_1.RETRY_DELAY_MAX_MS; } }));
/** Build an OtlpMetricsDocument from a simple benchmark input shape. */
var build_otlp_result_js_1 = __nccwpck_require__(837);
Object.defineProperty(exports, "buildOtlpResult", ({ enumerable: true, get: function () { return build_otlp_result_js_1.buildOtlpResult; } }));
/** Ergonomic batch wrapper over OtlpMetricsDocument. */
var metrics_batch_js_1 = __nccwpck_require__(515);
Object.defineProperty(exports, "MetricsBatch", ({ enumerable: true, get: function () { return metrics_batch_js_1.MetricsBatch; } }));
Object.defineProperty(exports, "seriesKey", ({ enumerable: true, get: function () { return metrics_batch_js_1.seriesKey; } }));
//# sourceMappingURL=index.js.map

/***/ }),

/***/ 83:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.inferDirection = inferDirection;
/**
 * Infer whether a unit is "bigger_is_better" or "smaller_is_better".
 *
 * Common patterns:
 *  - ops/s, MB/s, throughput, events → bigger is better
 *  - ns/op, B/op, allocs/op, ms, bytes → smaller is better (default)
 */
function inferDirection(unit) {
    const lower = unit.toLowerCase();
    if (lower.includes("ops/s") ||
        lower.includes("op/s") ||
        lower.includes("/sec") ||
        lower.includes("mb/s") ||
        lower.includes("throughput") ||
        lower.includes("events")) {
        return "bigger_is_better";
    }
    return "smaller_is_better";
}
//# sourceMappingURL=infer-direction.js.map

/***/ }),

/***/ 515:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MetricsBatch = void 0;
exports.seriesKey = seriesKey;
const otlp_conventions_js_1 = __nccwpck_require__(757);
// ---------------------------------------------------------------------------
// Attribute helpers (internal)
// ---------------------------------------------------------------------------
function getStr(attrs, key) {
    const a = attrs.find((x) => x.key === key);
    return a?.value?.stringValue;
}
function pointValue(dp) {
    if (dp.asInt !== undefined)
        return Number(dp.asInt);
    if (dp.asDouble !== undefined)
        return dp.asDouble;
    return NaN;
}
function extractResourceContext(attrs) {
    return {
        runId: getStr(attrs, otlp_conventions_js_1.ATTR_RUN_ID),
        kind: getStr(attrs, otlp_conventions_js_1.ATTR_KIND),
        sourceFormat: getStr(attrs, otlp_conventions_js_1.ATTR_SOURCE_FORMAT),
        commit: getStr(attrs, otlp_conventions_js_1.ATTR_COMMIT),
        ref: getStr(attrs, otlp_conventions_js_1.ATTR_REF),
        workflow: getStr(attrs, otlp_conventions_js_1.ATTR_WORKFLOW),
        job: getStr(attrs, otlp_conventions_js_1.ATTR_JOB),
        runAttempt: getStr(attrs, otlp_conventions_js_1.ATTR_RUN_ATTEMPT),
        runner: getStr(attrs, otlp_conventions_js_1.ATTR_RUNNER),
        serviceName: getStr(attrs, otlp_conventions_js_1.ATTR_SERVICE_NAME),
    };
}
function flattenGaugePoints(metric, dpAttrs, dpValue, dataPoints) {
    if (!dataPoints)
        return [];
    const results = [];
    for (const dp of dataPoints) {
        const attrs = dpAttrs(dp);
        const tags = {};
        for (const a of attrs) {
            if (!otlp_conventions_js_1.RESERVED_DATAPOINT_ATTRIBUTES.has(a.key) && a.value?.stringValue !== undefined) {
                tags[a.key] = a.value.stringValue;
            }
        }
        results.push({
            scenario: getStr(attrs, otlp_conventions_js_1.ATTR_SCENARIO) ?? "",
            series: getStr(attrs, otlp_conventions_js_1.ATTR_SERIES) ?? "",
            metric: metric.name,
            value: dpValue(dp),
            unit: metric.unit ?? "",
            direction: getStr(attrs, otlp_conventions_js_1.ATTR_METRIC_DIRECTION),
            role: getStr(attrs, otlp_conventions_js_1.ATTR_METRIC_ROLE),
            tags,
            timestamp: dp.timeUnixNano,
        });
    }
    return results;
}
function flattenDoc(doc) {
    const allPoints = [];
    let context = {
        runId: undefined, kind: undefined, sourceFormat: undefined,
        commit: undefined, ref: undefined, workflow: undefined,
        job: undefined, runAttempt: undefined, runner: undefined,
        serviceName: undefined,
    };
    for (const rm of doc.resourceMetrics) {
        if (rm.resource?.attributes) {
            context = extractResourceContext(rm.resource.attributes);
        }
        for (const sm of rm.scopeMetrics ?? []) {
            for (const metric of sm.metrics ?? []) {
                // Gauge
                if (metric.gauge?.dataPoints) {
                    allPoints.push(...flattenGaugePoints(metric, (dp) => dp.attributes ?? [], pointValue, metric.gauge.dataPoints));
                }
                // Sum (same datapoint shape as gauge)
                if (metric.sum?.dataPoints) {
                    allPoints.push(...flattenGaugePoints(metric, (dp) => dp.attributes ?? [], pointValue, metric.sum.dataPoints));
                }
                // Histogram → split into .count and .sum child metrics
                if (metric.histogram?.dataPoints) {
                    for (const dp of metric.histogram.dataPoints) {
                        const attrs = dp.attributes ?? [];
                        const tags = {};
                        for (const a of attrs) {
                            if (!otlp_conventions_js_1.RESERVED_DATAPOINT_ATTRIBUTES.has(a.key) && a.value?.stringValue !== undefined) {
                                tags[a.key] = a.value.stringValue;
                            }
                        }
                        const base = {
                            scenario: getStr(attrs, otlp_conventions_js_1.ATTR_SCENARIO) ?? "",
                            series: getStr(attrs, otlp_conventions_js_1.ATTR_SERIES) ?? "",
                            unit: metric.unit ?? "",
                            direction: getStr(attrs, otlp_conventions_js_1.ATTR_METRIC_DIRECTION),
                            role: getStr(attrs, otlp_conventions_js_1.ATTR_METRIC_ROLE),
                            tags,
                            timestamp: dp.timeUnixNano,
                        };
                        if (dp.count !== undefined) {
                            allPoints.push({ ...base, metric: `${metric.name}.count`, value: Number(dp.count) });
                        }
                        if (dp.sum !== undefined) {
                            allPoints.push({ ...base, metric: `${metric.name}.sum`, value: dp.sum });
                        }
                    }
                }
            }
        }
    }
    return { points: allPoints, context };
}
// ---------------------------------------------------------------------------
// OTLP reconstruction helpers
// ---------------------------------------------------------------------------
function toOtlpValue(value) {
    return { stringValue: value };
}
function attr(key, value) {
    return { key, value: toOtlpValue(value) };
}
function dpValue(value) {
    return Number.isSafeInteger(value) ? { asInt: String(value) } : { asDouble: value };
}
function contextToResourceAttrs(ctx) {
    const attrs = [];
    if (ctx.runId)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUN_ID, ctx.runId));
    if (ctx.kind)
        attrs.push(attr(otlp_conventions_js_1.ATTR_KIND, ctx.kind));
    if (ctx.sourceFormat)
        attrs.push(attr(otlp_conventions_js_1.ATTR_SOURCE_FORMAT, ctx.sourceFormat));
    if (ctx.ref)
        attrs.push(attr(otlp_conventions_js_1.ATTR_REF, ctx.ref));
    if (ctx.commit)
        attrs.push(attr(otlp_conventions_js_1.ATTR_COMMIT, ctx.commit));
    if (ctx.workflow)
        attrs.push(attr(otlp_conventions_js_1.ATTR_WORKFLOW, ctx.workflow));
    if (ctx.job)
        attrs.push(attr(otlp_conventions_js_1.ATTR_JOB, ctx.job));
    if (ctx.runAttempt)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUN_ATTEMPT, ctx.runAttempt));
    if (ctx.runner)
        attrs.push(attr(otlp_conventions_js_1.ATTR_RUNNER, ctx.runner));
    if (ctx.serviceName)
        attrs.push(attr(otlp_conventions_js_1.ATTR_SERVICE_NAME, ctx.serviceName));
    return attrs;
}
function pointToDataPointAttrs(p) {
    const attrs = [];
    if (p.scenario)
        attrs.push(attr(otlp_conventions_js_1.ATTR_SCENARIO, p.scenario));
    if (p.series)
        attrs.push(attr(otlp_conventions_js_1.ATTR_SERIES, p.series));
    if (p.role)
        attrs.push(attr(otlp_conventions_js_1.ATTR_METRIC_ROLE, p.role));
    if (p.direction)
        attrs.push(attr(otlp_conventions_js_1.ATTR_METRIC_DIRECTION, p.direction));
    for (const [k, v] of Object.entries(p.tags)) {
        attrs.push(attr(k, v));
    }
    return attrs;
}
// ---------------------------------------------------------------------------
// MetricsBatch
// ---------------------------------------------------------------------------
const EMPTY_CONTEXT = {
    runId: undefined, kind: undefined, sourceFormat: undefined,
    commit: undefined, ref: undefined, workflow: undefined,
    job: undefined, runAttempt: undefined, runner: undefined,
    serviceName: undefined,
};
class MetricsBatch {
    context;
    points;
    constructor(points, context) {
        this.points = points;
        this.context = context;
    }
    // ---- Constructors -------------------------------------------------------
    static fromOtlp(doc) {
        const { points, context } = flattenDoc(doc);
        return new MetricsBatch(points, context);
    }
    static fromPoints(points, context) {
        return new MetricsBatch(points, context ?? EMPTY_CONTEXT);
    }
    static merge(...batches) {
        if (batches.length === 0)
            return new MetricsBatch([], EMPTY_CONTEXT);
        const allPoints = batches.flatMap((b) => b.points);
        // Use the first batch's context as the merged context
        return new MetricsBatch(allPoints, batches[0].context);
    }
    // ---- Scalar accessors ---------------------------------------------------
    get size() {
        return this.points.length;
    }
    get scenarios() {
        return [...new Set(this.points.map((p) => p.scenario))].sort();
    }
    get metricNames() {
        return [...new Set(this.points.map((p) => p.metric))].sort();
    }
    // ---- Filter → new MetricsBatch (chainable) ------------------------------
    filter(fn) {
        return new MetricsBatch(this.points.filter(fn), this.context);
    }
    forScenario(name) {
        return this.filter((p) => p.scenario === name);
    }
    forMetric(name) {
        return this.filter((p) => p.metric === name);
    }
    withoutMonitor() {
        return this.filter((p) => !p.metric.startsWith(otlp_conventions_js_1.MONITOR_METRIC_PREFIX));
    }
    onlyMonitor() {
        return this.filter((p) => p.metric.startsWith(otlp_conventions_js_1.MONITOR_METRIC_PREFIX));
    }
    // ---- Group → Map<key, MetricsBatch> -------------------------------------
    groupBy(fn) {
        const groups = new Map();
        for (const p of this.points) {
            const key = fn(p);
            let arr = groups.get(key);
            if (!arr) {
                arr = [];
                groups.set(key, arr);
            }
            arr.push(p);
        }
        const result = new Map();
        for (const [key, pts] of groups) {
            result.set(key, new MetricsBatch(pts, this.context));
        }
        return result;
    }
    groupByScenario() {
        return this.groupBy((p) => p.scenario);
    }
    groupByMetric() {
        return this.groupBy((p) => p.metric);
    }
    groupBySeries() {
        return this.groupBy((p) => seriesKey(p));
    }
    // ---- Output -------------------------------------------------------------
    toOtlp() {
        // Group points by metric name to produce one OtlpMetric per unique name
        const metricMap = new Map();
        for (const p of this.points) {
            let entry = metricMap.get(p.metric);
            if (!entry) {
                entry = { unit: p.unit, points: [] };
                metricMap.set(p.metric, entry);
            }
            entry.points.push(p);
        }
        const metrics = [];
        for (const [name, { unit, points }] of metricMap) {
            metrics.push({
                name,
                unit: unit || undefined,
                gauge: {
                    dataPoints: points.map((p) => ({
                        timeUnixNano: p.timestamp,
                        attributes: pointToDataPointAttrs(p),
                        ...dpValue(p.value),
                    })),
                },
            });
        }
        return {
            resourceMetrics: [{
                    resource: { attributes: contextToResourceAttrs(this.context) },
                    scopeMetrics: [{ metrics }],
                }],
        };
    }
    toJson() {
        return JSON.stringify(this.toOtlp());
    }
}
exports.MetricsBatch = MetricsBatch;
// ---------------------------------------------------------------------------
// Utility: series key (name + sorted tags)
// ---------------------------------------------------------------------------
function seriesKey(p) {
    const tagParts = Object.entries(p.tags).sort(([a], [b]) => a.localeCompare(b));
    if (tagParts.length === 0)
        return p.series || p.scenario;
    return `${p.series || p.scenario} [${tagParts.map(([k, v]) => `${k}=${v}`).join(",")}]`;
}
//# sourceMappingURL=metrics-batch.js.map

/***/ }),

/***/ 757:
/***/ ((__unused_webpack_module, exports) => {


/**
 * Benchkit OTLP Semantic Conventions
 *
 * Canonical attribute names and valid values for the benchkit OTLP contract.
 * Source of truth: docs/otlp-semantic-conventions.md
 *
 * Every benchkit OTLP producer and consumer should import from this module
 * rather than hard-coding attribute strings.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MONITOR_METRIC_PREFIX = exports.DEFAULT_DATA_BRANCH = exports.VALID_SOURCE_FORMATS = exports.VALID_METRIC_ROLES = exports.VALID_DIRECTIONS = exports.VALID_RUN_KINDS = exports.RESERVED_DATAPOINT_ATTRIBUTES = exports.ATTR_METRIC_ROLE = exports.ATTR_METRIC_DIRECTION = exports.ATTR_SERIES = exports.ATTR_SCENARIO = exports.REQUIRED_RESOURCE_ATTRIBUTES = exports.ATTR_SERVICE_VERSION = exports.ATTR_SERVICE_NAME = exports.ATTR_RUNNER = exports.ATTR_RUN_ATTEMPT = exports.ATTR_JOB = exports.ATTR_WORKFLOW = exports.ATTR_COMMIT = exports.ATTR_REF = exports.ATTR_SOURCE_FORMAT = exports.ATTR_KIND = exports.ATTR_RUN_ID = void 0;
// ---------------------------------------------------------------------------
// Resource attributes (run-level metadata on every ResourceMetrics)
// ---------------------------------------------------------------------------
/** Unique run artifact identifier, e.g. `"12345678-1"`. Required. */
exports.ATTR_RUN_ID = "benchkit.run_id";
/** Benchmark kind: code, workflow, or hybrid. Required. */
exports.ATTR_KIND = "benchkit.kind";
/** Parser / origin format that produced the OTLP data. Required. */
exports.ATTR_SOURCE_FORMAT = "benchkit.source_format";
/** Git ref (branch or tag). Strongly recommended. */
exports.ATTR_REF = "benchkit.ref";
/** Full commit SHA. Strongly recommended. */
exports.ATTR_COMMIT = "benchkit.commit";
/** GitHub Actions workflow name. Strongly recommended. */
exports.ATTR_WORKFLOW = "benchkit.workflow";
/** GitHub Actions job name. Strongly recommended. */
exports.ATTR_JOB = "benchkit.job";
/** Retry/rerun attempt number. Optional. */
exports.ATTR_RUN_ATTEMPT = "benchkit.run_attempt";
/** Human-readable runner description. Optional. */
exports.ATTR_RUNNER = "benchkit.runner";
/** OpenTelemetry standard service name. Strongly recommended. */
exports.ATTR_SERVICE_NAME = "service.name";
/** Application or service version. Optional. */
exports.ATTR_SERVICE_VERSION = "service.version";
/** All resource attributes that MUST be present. */
exports.REQUIRED_RESOURCE_ATTRIBUTES = [
    exports.ATTR_RUN_ID,
    exports.ATTR_KIND,
    exports.ATTR_SOURCE_FORMAT,
];
// ---------------------------------------------------------------------------
// Datapoint attributes (metric identity on every data-point)
// ---------------------------------------------------------------------------
/** Primary benchmark scenario / workload name. Required. */
exports.ATTR_SCENARIO = "benchkit.scenario";
/** Series identity within a scenario. Required. */
exports.ATTR_SERIES = "benchkit.series";
/** Metric improvement direction. Required for comparison-eligible metrics. */
exports.ATTR_METRIC_DIRECTION = "benchkit.metric.direction";
/** Metric role: outcome or diagnostic. Recommended. */
exports.ATTR_METRIC_ROLE = "benchkit.metric.role";
/**
 * Datapoint attributes consumed internally by the projection logic.
 * These are not forwarded as user-visible benchmark tags.
 */
exports.RESERVED_DATAPOINT_ATTRIBUTES = new Set([
    exports.ATTR_SCENARIO,
    exports.ATTR_SERIES,
    exports.ATTR_METRIC_DIRECTION,
    exports.ATTR_METRIC_ROLE,
]);
// ---------------------------------------------------------------------------
// Valid enum values
// ---------------------------------------------------------------------------
/** Valid values for `benchkit.kind`. */
exports.VALID_RUN_KINDS = ["code", "workflow", "hybrid"];
/** Valid values for `benchkit.metric.direction`. */
exports.VALID_DIRECTIONS = [
    "bigger_is_better",
    "smaller_is_better",
];
/** Valid values for `benchkit.metric.role`. */
exports.VALID_METRIC_ROLES = ["outcome", "diagnostic"];
/** Valid values for `benchkit.source_format`. */
exports.VALID_SOURCE_FORMATS = [
    "go",
    "otlp",
    "rust",
    "hyperfine",
    "pytest-benchmark",
    "benchmark-action",
];
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
/** Default Git branch name used for storing benchmark data. */
exports.DEFAULT_DATA_BRANCH = "bench-data";
// ---------------------------------------------------------------------------
// Metric naming conventions
// ---------------------------------------------------------------------------
/**
 * Prefix reserved for infrastructure / diagnostic metrics emitted by the
 * benchkit monitor action (e.g. `_monitor.cpu_user_pct`).
 */
exports.MONITOR_METRIC_PREFIX = "_monitor.";
//# sourceMappingURL=otlp-conventions.js.map

/***/ }),

/***/ 442:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


/**
 * Runtime validators for the benchkit OTLP semantic contract.
 *
 * These validators enforce the required attributes documented in
 * docs/otlp-semantic-conventions.md. They throw descriptive errors that
 * guide producers toward compliance.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.validateRequiredResourceAttributes = validateRequiredResourceAttributes;
exports.validateRequiredDatapointAttributes = validateRequiredDatapointAttributes;
exports.isValidRunKind = isValidRunKind;
exports.validateRunKind = validateRunKind;
exports.isValidDirection = isValidDirection;
exports.validateDirection = validateDirection;
exports.isValidMetricRole = isValidMetricRole;
exports.validateMetricRole = validateMetricRole;
exports.isValidSourceFormat = isValidSourceFormat;
exports.validateSourceFormat = validateSourceFormat;
exports.isMonitorMetric = isMonitorMetric;
const otlp_conventions_js_1 = __nccwpck_require__(757);
// ---------------------------------------------------------------------------
// Resource attribute validation
// ---------------------------------------------------------------------------
/**
 * Validates that all required resource-level attributes are present and valid.
 * Throws with a descriptive message on the first violation found.
 */
function validateRequiredResourceAttributes(attrs) {
    requireAttribute(attrs, otlp_conventions_js_1.ATTR_RUN_ID);
    validateRunKind(attrs[otlp_conventions_js_1.ATTR_KIND]);
    validateSourceFormat(attrs[otlp_conventions_js_1.ATTR_SOURCE_FORMAT]);
}
// ---------------------------------------------------------------------------
// Datapoint attribute validation
// ---------------------------------------------------------------------------
/**
 * Validates that required datapoint-level attributes are present.
 *
 * For non-monitor metrics, `benchkit.scenario` and `benchkit.series` are
 * required. Monitor metrics (`_monitor.*`) are exempt since they default
 * to `"diagnostic"` scenario.
 */
function validateRequiredDatapointAttributes(attrs, metricName) {
    if (isMonitorMetric(metricName)) {
        requireAttribute(attrs, otlp_conventions_js_1.ATTR_SERIES);
        return;
    }
    requireAttribute(attrs, otlp_conventions_js_1.ATTR_SCENARIO);
    requireAttribute(attrs, otlp_conventions_js_1.ATTR_SERIES);
}
// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------
/** Returns true if `value` is a valid `benchkit.kind`. */
function isValidRunKind(value) {
    return otlp_conventions_js_1.VALID_RUN_KINDS.includes(value);
}
/** Validates and returns a `RunKind`, or throws. */
function validateRunKind(value) {
    return validateAttribute(value, otlp_conventions_js_1.ATTR_KIND, otlp_conventions_js_1.VALID_RUN_KINDS);
}
/** Returns true if `value` is a valid `benchkit.metric.direction`. */
function isValidDirection(value) {
    return otlp_conventions_js_1.VALID_DIRECTIONS.includes(value);
}
/** Validates and returns a `Direction`, or throws. */
function validateDirection(value) {
    return validateAttribute(value, otlp_conventions_js_1.ATTR_METRIC_DIRECTION, otlp_conventions_js_1.VALID_DIRECTIONS);
}
/** Returns true if `value` is a valid `benchkit.metric.role`. */
function isValidMetricRole(value) {
    return otlp_conventions_js_1.VALID_METRIC_ROLES.includes(value);
}
/** Validates and returns a `MetricRole`, or throws. */
function validateMetricRole(value) {
    return validateAttribute(value, otlp_conventions_js_1.ATTR_METRIC_ROLE, otlp_conventions_js_1.VALID_METRIC_ROLES);
}
/** Returns true if `value` is a valid `benchkit.source_format`. */
function isValidSourceFormat(value) {
    return otlp_conventions_js_1.VALID_SOURCE_FORMATS.includes(value);
}
/** Validates and returns a `SourceFormat`, or throws. */
function validateSourceFormat(value) {
    return validateAttribute(value, otlp_conventions_js_1.ATTR_SOURCE_FORMAT, otlp_conventions_js_1.VALID_SOURCE_FORMATS);
}
/** Returns true if the metric name uses the reserved `_monitor.` prefix. */
function isMonitorMetric(name) {
    return name.startsWith(otlp_conventions_js_1.MONITOR_METRIC_PREFIX);
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function requireAttribute(attrs, key) {
    if (!attrs[key]) {
        throw new Error(`Missing required attribute '${key}'.`);
    }
}
function validateAttribute(value, attribute, validValues) {
    if (!value) {
        throw new Error(`Missing required attribute '${attribute}'. ` +
            `Expected one of: ${validValues.join(", ")}.`);
    }
    if (!validValues.includes(value)) {
        throw new Error(`Invalid '${attribute}' value '${value}'. ` +
            `Expected one of: ${validValues.join(", ")}.`);
    }
    return value;
}
//# sourceMappingURL=otlp-validation.js.map

/***/ }),

/***/ 985:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseBenchmarkAction = parseBenchmarkAction;
const build_otlp_result_js_1 = __nccwpck_require__(837);
const infer_direction_js_1 = __nccwpck_require__(83);
/**
 * benchmark-action/github-action-benchmark compatible format.
 *
 * Input: [{ name, value, unit, range?, extra? }]
 *
 * Each entry becomes one benchmark with one metric called "value".
 * Direction is inferred from the unit string.
 */
function parseBenchmarkAction(input) {
    let entries;
    try {
        entries = JSON.parse(input);
    }
    catch (err) {
        throw new Error(`[parse-benchmark-action] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!Array.isArray(entries)) {
        throw new Error("[parse-benchmark-action] Input must be a JSON array of {name, value, unit} objects.");
    }
    const benchmarks = entries.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            throw new Error(`[parse-benchmark-action] Entry at index ${index} must be an object.`);
        }
        const e = entry;
        if (typeof e.name !== "string") {
            throw new Error(`[parse-benchmark-action] Entry at index ${index} must have a string 'name'.`);
        }
        if (typeof e.value !== "number") {
            throw new Error(`[parse-benchmark-action] Entry '${e.name}' must have a numeric 'value'.`);
        }
        if (typeof e.unit !== "string") {
            throw new Error(`[parse-benchmark-action] Entry '${e.name}' must have a string 'unit'.`);
        }
        const metric = {
            value: e.value,
            unit: e.unit,
            direction: (0, infer_direction_js_1.inferDirection)(e.unit),
        };
        return {
            name: e.name,
            metrics: { value: metric },
        };
    });
    return (0, build_otlp_result_js_1.buildOtlpResult)({
        benchmarks,
        context: { sourceFormat: "benchmark-action" },
    });
}
//# sourceMappingURL=parse-benchmark-action.js.map

/***/ }),

/***/ 303:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseGoBench = parseGoBench;
const build_otlp_result_js_1 = __nccwpck_require__(837);
const infer_direction_js_1 = __nccwpck_require__(83);
const parser_utils_js_1 = __nccwpck_require__(524);
/**
 * Parse Go benchmark text output into an OtlpMetricsDocument.
 *
 * Handles the standard format:
 *   BenchmarkName-8   N   value unit [value unit ...]
 *
 * Multiple value/unit pairs per line produce multiple metrics per benchmark.
 * The -P suffix is extracted as a "procs" tag.
 */
function parseGoBench(input) {
    if (typeof input !== "string" || input.trim() === "") {
        throw new Error("[parse-go] Input must be a non-empty string.");
    }
    try {
        const benchmarks = [];
        const re = /^(?<fullName>Benchmark\S+)\s+(?<iters>\d+)\s+(?<rest>.+)$/;
        for (const line of input.split(/\r?\n/)) {
            const m = line.match(re);
            if (!m?.groups)
                continue;
            const { fullName, iters: _iters, rest } = m.groups;
            const procsMatch = fullName.match(/^(?<name>.+?)-(?<procs>\d+)$/);
            const name = procsMatch?.groups?.name ?? fullName;
            const procs = procsMatch?.groups?.procs;
            const tags = {};
            if (procs)
                tags.procs = procs;
            const pieces = rest.trim().split(/\s+/);
            const metrics = {};
            // Pieces come in (value, unit) pairs
            for (let i = 0; i + 1 < pieces.length; i += 2) {
                const value = parseFloat(pieces[i]);
                const unit = pieces[i + 1];
                if (isNaN(value))
                    continue;
                const metricName = (0, parser_utils_js_1.unitToMetricName)(unit);
                metrics[metricName] = {
                    value,
                    unit,
                    direction: (0, infer_direction_js_1.inferDirection)(unit),
                };
            }
            if (Object.keys(metrics).length > 0) {
                benchmarks.push({
                    name,
                    tags: Object.keys(tags).length > 0 ? tags : undefined,
                    metrics,
                });
            }
        }
        return (0, build_otlp_result_js_1.buildOtlpResult)({
            benchmarks,
            context: { sourceFormat: "go" },
        });
    }
    catch (err) {
        throw new Error(`[parse-go] Failed to parse Go benchmark output: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
}
//# sourceMappingURL=parse-go.js.map

/***/ }),

/***/ 347:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseHyperfine = parseHyperfine;
const build_otlp_result_js_1 = __nccwpck_require__(837);
const infer_direction_js_1 = __nccwpck_require__(83);
function parseHyperfine(input) {
    let parsed;
    try {
        parsed = JSON.parse(input);
    }
    catch (err) {
        throw new Error(`[parse-hyperfine] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!parsed.results || !Array.isArray(parsed.results)) {
        throw new Error("[parse-hyperfine] Hyperfine format must have a 'results' array.");
    }
    const benchmarks = parsed.results.map((result) => {
        if (typeof result.command !== "string") {
            throw new Error("[parse-hyperfine] Each Hyperfine result must have a 'command' string.");
        }
        const timeDirection = (0, infer_direction_js_1.inferDirection)("s");
        const metrics = {
            mean: {
                value: result.mean,
                unit: "s",
                direction: timeDirection,
            },
            stddev: {
                value: result.stddev,
                unit: "s",
                direction: timeDirection,
            },
            median: {
                value: result.median,
                unit: "s",
                direction: timeDirection,
            },
            min: {
                value: result.min,
                unit: "s",
                direction: timeDirection,
            },
            max: {
                value: result.max,
                unit: "s",
                direction: timeDirection,
            },
        };
        return {
            name: result.command,
            metrics,
        };
    });
    return (0, build_otlp_result_js_1.buildOtlpResult)({
        benchmarks,
        context: { sourceFormat: "hyperfine" },
    });
}
//# sourceMappingURL=parse-hyperfine.js.map

/***/ }),

/***/ 158:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.otlpAttributesToRecord = otlpAttributesToRecord;
exports.parseOtlp = parseOtlp;
exports.getOtlpMetricKind = getOtlpMetricKind;
exports.getOtlpTemporality = getOtlpTemporality;
function anyValueToString(value) {
    if (!value)
        return "";
    if (value.stringValue !== undefined)
        return value.stringValue;
    if (value.boolValue !== undefined)
        return String(value.boolValue);
    if (value.intValue !== undefined)
        return String(value.intValue);
    if (value.doubleValue !== undefined)
        return String(value.doubleValue);
    return "";
}
/**
 * Flatten an OTLP `KeyValue` attribute array into a plain string record.
 *
 * All OTLP value types (string, bool, int, double) are coerced to strings.
 * Attributes with an absent or unrecognised value are stored as empty strings.
 *
 * @param attributes - Optional OTLP attribute array to flatten.
 * @returns A `Record<string, string>` mapping each attribute key to its string value.
 */
function otlpAttributesToRecord(attributes) {
    const record = {};
    for (const attribute of attributes ?? []) {
        record[attribute.key] = anyValueToString(attribute.value);
    }
    return record;
}
/**
 * Parse and minimally validate an OTLP metrics JSON string.
 *
 * Validates that the top-level object contains a `resourceMetrics` array.
 * Throws if the input is not valid JSON or if `resourceMetrics` is absent/not
 * an array.
 *
 * @param input - Raw OTLP metrics JSON string.
 * @returns The parsed `OtlpMetricsDocument`.
 */
function parseOtlp(input) {
    const parsed = JSON.parse(input);
    if (typeof parsed !== "object" ||
        parsed === null ||
        !Array.isArray(parsed.resourceMetrics)) {
        throw new Error("[parse-otlp] OTLP metrics JSON must contain a top-level resourceMetrics array.");
    }
    return parsed;
}
/**
 * Determine the data kind of an OTLP metric.
 *
 * Supported kinds are `"gauge"`, `"sum"`, and `"histogram"`.
 * Throws an `Error` if none of those fields are present on the metric.
 *
 * @param metric - The OTLP metric to inspect.
 * @returns `"gauge"`, `"sum"`, or `"histogram"`.
 */
function getOtlpMetricKind(metric) {
    if (metric.gauge)
        return "gauge";
    if (metric.sum)
        return "sum";
    if (metric.histogram)
        return "histogram";
    throw new Error(`[parse-otlp] Unsupported OTLP metric kind for metric '${metric.name}'.`);
}
/**
 * Resolve the aggregation temporality for an OTLP sum or histogram metric.
 *
 * Maps the raw numeric OTLP enum to a human-readable string:
 * - `1` → `"delta"`
 * - `2` → `"cumulative"`
 * - anything else (including absent) → `"unspecified"`
 *
 * @param metric - The OTLP metric to inspect.
 * @returns The `OtlpAggregationTemporality` string value.
 */
function getOtlpTemporality(metric) {
    const raw = metric.sum?.aggregationTemporality ?? metric.histogram?.aggregationTemporality;
    if (raw === 1)
        return "delta";
    if (raw === 2)
        return "cumulative";
    return "unspecified";
}
//# sourceMappingURL=parse-otlp.js.map

/***/ }),

/***/ 956:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parsePytestBenchmark = parsePytestBenchmark;
const build_otlp_result_js_1 = __nccwpck_require__(837);
const infer_direction_js_1 = __nccwpck_require__(83);
function parsePytestBenchmark(input) {
    let parsed;
    try {
        parsed = JSON.parse(input);
    }
    catch (err) {
        throw new Error(`[parse-pytest-benchmark] Failed to parse input as JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!parsed.benchmarks || !Array.isArray(parsed.benchmarks)) {
        throw new Error("[parse-pytest-benchmark] pytest-benchmark format must have a 'benchmarks' array.");
    }
    const benchmarks = parsed.benchmarks.map((entry) => {
        if (typeof entry.name !== "string") {
            throw new Error("[parse-pytest-benchmark] Each pytest-benchmark entry must have a 'name' string.");
        }
        if (!entry.stats || typeof entry.stats !== "object") {
            throw new Error(`[parse-pytest-benchmark] pytest-benchmark entry '${entry.name}' must have a 'stats' object.`);
        }
        const stats = entry.stats;
        const timeDirection = (0, infer_direction_js_1.inferDirection)("s");
        const metrics = {
            mean: {
                value: stats.mean,
                unit: "s",
                direction: timeDirection,
            },
            median: {
                value: stats.median,
                unit: "s",
                direction: timeDirection,
            },
            min: {
                value: stats.min,
                unit: "s",
                direction: timeDirection,
            },
            max: {
                value: stats.max,
                unit: "s",
                direction: timeDirection,
            },
            stddev: {
                value: stats.stddev,
                unit: "s",
                direction: timeDirection,
            },
            ops: {
                value: stats.ops,
                unit: "ops/s",
                direction: (0, infer_direction_js_1.inferDirection)("ops/s"),
            },
            rounds: {
                value: stats.rounds,
                direction: "bigger_is_better",
            },
        };
        return {
            name: entry.name,
            metrics,
        };
    });
    return (0, build_otlp_result_js_1.buildOtlpResult)({
        benchmarks,
        context: { sourceFormat: "pytest-benchmark" },
    });
}
//# sourceMappingURL=parse-pytest-benchmark.js.map

/***/ }),

/***/ 215:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseRustBench = parseRustBench;
const build_otlp_result_js_1 = __nccwpck_require__(837);
const parser_utils_js_1 = __nccwpck_require__(524);
/**
 * Parse Rust cargo bench (libtest) output into an OtlpMetricsDocument.
 *
 * Example:
 *   test sort::bench_sort   ... bench:         320 ns/iter (+/- 42)
 */
function parseRustBench(input) {
    if (typeof input !== "string" || input.trim() === "") {
        throw new Error("[parse-rust] Input must be a non-empty string.");
    }
    try {
        const benchmarks = [];
        const re = /^test\s+(?<name>\S+)\s+\.\.\.\s+bench:\s+(?<value>[\d,]+)\s+(?<unit>\S+)(?:\s+\(\+\/-\s+(?<range>[\d,]+)\))?/;
        for (const line of input.split(/\r?\n/)) {
            const trimmedLine = line.trim();
            const m = trimmedLine.match(re);
            if (!m?.groups)
                continue;
            const { name, value, unit, range: _range } = m.groups;
            const numericValue = parseFloat(value.replace(/,/g, ""));
            if (isNaN(numericValue)) {
                throw new Error(`Invalid numeric value '${value}' for benchmark '${name}'.`);
            }
            const metric = {
                value: numericValue,
                unit,
                direction: "smaller_is_better",
            };
            const metrics = {};
            metrics[(0, parser_utils_js_1.unitToMetricName)(unit)] = metric;
            benchmarks.push({
                name,
                metrics,
            });
        }
        return (0, build_otlp_result_js_1.buildOtlpResult)({
            benchmarks,
            context: { sourceFormat: "rust" },
        });
    }
    catch (err) {
        throw new Error(`[parse-rust] Failed to parse Rust benchmark output: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
}
//# sourceMappingURL=parse-rust.js.map

/***/ }),

/***/ 152:
/***/ ((__unused_webpack_module, exports, __nccwpck_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.parseBenchmarks = parseBenchmarks;
const parse_go_js_1 = __nccwpck_require__(303);
const parse_rust_js_1 = __nccwpck_require__(215);
const parse_benchmark_action_js_1 = __nccwpck_require__(985);
const parse_hyperfine_js_1 = __nccwpck_require__(347);
const parse_pytest_benchmark_js_1 = __nccwpck_require__(956);
const parse_otlp_js_1 = __nccwpck_require__(158);
/**
 * Detect the input format and parse into an OtlpMetricsDocument.
 */
function parseBenchmarks(input, format = "auto") {
    if (format === "auto") {
        format = detectFormat(input);
    }
    switch (format) {
        case "go":
            return (0, parse_go_js_1.parseGoBench)(input);
        case "rust":
            return (0, parse_rust_js_1.parseRustBench)(input);
        case "benchmark-action":
            return (0, parse_benchmark_action_js_1.parseBenchmarkAction)(input);
        case "hyperfine":
            return (0, parse_hyperfine_js_1.parseHyperfine)(input);
        case "pytest-benchmark":
            return (0, parse_pytest_benchmark_js_1.parsePytestBenchmark)(input);
        case "otlp":
            return (0, parse_otlp_js_1.parseOtlp)(input);
        default:
            throw new Error(`[parseBenchmarks] Unknown format: ${format}`);
    }
}
/**
 * Auto-detect format from content.
 *
 * - If it parses as JSON with a "benchmarks" key and entries with "stats" → pytest-benchmark
 * - If it parses as JSON with a "resourceMetrics" key → otlp
 * - If it parses as JSON with a "results" key containing objects with "command" → hyperfine
 * - If it parses as a JSON array of objects with "name"/"value"/"unit" → benchmark-action
 * - If it contains lines matching "Benchmark...\s+\d+" → go
 * - Otherwise → error
 */
function detectFormat(input) {
    const trimmed = input.trim();
    // Try JSON first
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.benchmarks && Array.isArray(parsed.benchmarks)) {
                if (parsed.benchmarks.length > 0 &&
                    parsed.benchmarks[0].stats &&
                    typeof parsed.benchmarks[0].stats === "object") {
                    return "pytest-benchmark";
                }
            }
            if (parsed.resourceMetrics && Array.isArray(parsed.resourceMetrics)) {
                return "otlp";
            }
            if (parsed.results &&
                Array.isArray(parsed.results) &&
                parsed.results.length > 0 &&
                typeof parsed.results[0].command === "string") {
                return "hyperfine";
            }
            if (Array.isArray(parsed) &&
                parsed.length > 0 &&
                typeof parsed[0].name === "string" &&
                typeof parsed[0].value === "number") {
                return "benchmark-action";
            }
        }
        catch {
            // Not valid JSON, fall through
        }
    }
    // Check for Go benchmark lines
    if (/^Benchmark\w.*\s+\d+\s+[\d.]+\s+\w+\/\w+/m.test(trimmed)) {
        return "go";
    }
    // Check for Rust benchmark lines
    if (/^test\s+\S+\s+\.\.\.\s+bench:/m.test(trimmed)) {
        return "rust";
    }
    throw new Error("[parseBenchmarks] Could not auto-detect format. Use the 'format' option to specify one of: go, rust, benchmark-action, hyperfine, pytest-benchmark, otlp.");
}
//# sourceMappingURL=parse.js.map

/***/ }),

/***/ 524:
/***/ ((__unused_webpack_module, exports) => {


/**
 * Shared utilities for benchmark output parsers.
 */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.unitToMetricName = unitToMetricName;
/**
 * Convert a benchmark unit string to a metric name suitable for use as an
 * object key.
 *
 * Known aliases take precedence over the general rule:
 *   "B/op"    -> "bytes_per_op"
 *   "MB/s"    -> "mb_per_s"
 *   "ns/iter" -> "ns_per_iter"
 *
 * General rule: replace every `/` with `_per_`, replace spaces with `_`,
 * then lowercase.
 */
function unitToMetricName(unit) {
    const aliases = {
        "B/op": "bytes_per_op",
        "MB/s": "mb_per_s",
        "ns/iter": "ns_per_iter",
    };
    if (aliases[unit])
        return aliases[unit];
    return unit.replace(/\//g, "_per_").replace(/\s+/g, "_").toLowerCase();
}
//# sourceMappingURL=parser-utils.js.map

/***/ }),

/***/ 257:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.RETRY_DELAY_MAX_MS = exports.RETRY_DELAY_MIN_MS = exports.DEFAULT_PUSH_RETRY_COUNT = void 0;
exports.computeRetryDelayMs = computeRetryDelayMs;
exports.sleep = sleep;
exports.DEFAULT_PUSH_RETRY_COUNT = 5;
exports.RETRY_DELAY_MIN_MS = 500;
exports.RETRY_DELAY_MAX_MS = 3000;
function computeRetryDelayMs(randomValue, minMs = exports.RETRY_DELAY_MIN_MS, maxMs = exports.RETRY_DELAY_MAX_MS) {
    const normalized = Math.min(1, Math.max(0, randomValue));
    return Math.round(minMs + normalized * (maxMs - minMs));
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
//# sourceMappingURL=retry.js.map

/***/ }),

/***/ 24:
/***/ ((module) => {

module.exports = require("node:fs");

/***/ }),

/***/ 760:
/***/ ((module) => {

module.exports = require("node:path");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __nccwpck_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		var threw = true;
/******/ 		try {
/******/ 			__webpack_modules__[moduleId].call(module.exports, module, module.exports, __nccwpck_require__);
/******/ 			threw = false;
/******/ 		} finally {
/******/ 			if(threw) delete __webpack_module_cache__[moduleId];
/******/ 		}
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat */
/******/ 	
/******/ 	if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = __dirname + "/";
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __nccwpck_require__(937);
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=index.js.map