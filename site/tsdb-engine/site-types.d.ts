export interface MetricStore {
  matchLabel(label: string, value: string): number[];
  read(id: number, from: bigint, to: bigint): { timestamps: bigint[] };
  labels(id: number): Map<string, string> | null | undefined;
}

export interface LabelMeta {
  label: string;
  cardinality: number;
  score: number;
  values: string[];
}

export interface MetricMeta {
  metric: string;
  ids: number[];
  seriesCount: number;
  counterLike: boolean;
  rankedLabels: LabelMeta[];
  suggestedStepMs: number;
}

export interface MetricViewConfig {
  metric: string;
  transform?: string | undefined;
  agg?: string | undefined;
  groupBy?: string[] | undefined;
  stepMs: number;
  intro: string;
}

export interface MetricDimensionView {
  key: string;
  title: string;
  config: MetricViewConfig;
}

export interface QueryMatcher {
  label: string;
  op: string;
  value: string;
}

export interface QueryPreviewOptions {
  metric?: string | undefined;
  matchers?: QueryMatcher[] | undefined;
  transform?: string | undefined;
  agg?: string | undefined;
  groupBy?: string[] | undefined;
  stepMs?: number | undefined;
}

export interface QueryRecipeConfig {
  agg: string;
  transform: string;
  stepMs: number;
  groupBy: string[];
}

export type StepValue = bigint | number | null | undefined;

export interface StepResolutionResult {
  effectiveStep?: StepValue;
  requestedStep?: StepValue;
  pointBudget?: number | null | undefined;
}

export interface RandomPickSeriesInfo {
  info: {
    frozen: unknown[];
    hot: {
      count: number;
    };
  };
}

export interface RandomChunkPick {
  si: RandomPickSeriesInfo;
  chunkIndex: number;
  type: "frozen" | "hot";
}

export interface ByteSegment {
  label: string;
  bytes: number;
  cls: string;
}

export interface ByteRegion {
  name: string;
  cls: string;
  start: number;
  end: number;
  decode: () => string;
}

export interface ExplorerShellOptions {
  title: string;
  bytesLength: number;
  minimapId: string;
  gridId: string;
  decodePanelId: string;
  emptyKind: "byte" | "timestamp";
  insightHtml?: string | null | undefined;
}
