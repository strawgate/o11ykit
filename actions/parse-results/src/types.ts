export type ParseMode = "auto" | "file";

export type Format =
  | "auto"
  | "go"
  | "rust"
  | "hyperfine"
  | "pytest-benchmark"
  | "benchmark-action"
  | "otlp";

export interface OtlpAnyValue {
  readonly stringValue?: string;
  readonly boolValue?: boolean;
  readonly intValue?: string;
  readonly doubleValue?: number;
}

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

export interface OtlpDataPoint {
  readonly timeUnixNano?: string;
  readonly asInt?: string;
  readonly asDouble?: number;
  readonly attributes?: readonly OtlpAttribute[];
}

export interface OtlpMetric {
  readonly name: string;
  readonly unit?: string;
  readonly gauge?: {
    readonly dataPoints?: readonly OtlpDataPoint[];
  };
}

export interface OtlpMetricsDocument {
  readonly resourceMetrics: readonly {
    readonly resource?: {
      readonly attributes?: readonly OtlpAttribute[];
    };
    readonly scopeMetrics?: readonly {
      readonly metrics?: readonly OtlpMetric[];
    }[];
  }[];
}

export interface ParsedMetric {
  readonly value: number;
  readonly unit?: string;
  readonly direction?: "bigger_is_better" | "smaller_is_better";
}

export interface ParsedBenchmark {
  readonly name: string;
  readonly tags?: Record<string, string>;
  readonly metrics: Record<string, ParsedMetric>;
}

export interface ParseContext {
  readonly runId?: string;
  readonly sourceFormat: Exclude<Format, "auto">;
  readonly commit?: string;
  readonly ref?: string;
  readonly workflow?: string;
  readonly job?: string;
  readonly runAttempt?: string;
  readonly runner?: string;
}
