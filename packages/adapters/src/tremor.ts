import {
  asEngineLatestValueModel,
  asEngineWideTableModel,
  type EngineAdapterOptions,
  type EngineLatestValueInput,
  type EngineWideTableInput,
  type EngineWideTableModel,
} from "./engine.js";

export interface TremorSeriesDescriptor {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

export interface TremorXYOptions extends EngineAdapterOptions {
  readonly index?: string;
  readonly categoryLabel?: (
    series: EngineWideTableModel["series"][number],
    index: number
  ) => string;
  readonly valueFormatter?: (value: number) => string;
  readonly connectNulls?: boolean;
}

export interface TremorLineLikeProps {
  readonly data: readonly Record<string, number | string | null>[];
  readonly index: string;
  readonly categories: readonly string[];
  readonly valueFormatter?: (value: number) => string;
  readonly connectNulls?: boolean;
  readonly meta: {
    readonly series: readonly TremorSeriesDescriptor[];
  };
}

export interface TremorAreaChartProps extends TremorLineLikeProps {
  readonly type?: "default" | "stacked" | "percent";
}

export interface TremorBarChartProps extends TremorLineLikeProps {
  readonly layout?: "vertical" | "horizontal";
  readonly type?: "default" | "stacked" | "percent";
}

export interface TremorLatestOptions extends EngineAdapterOptions {
  readonly index?: string;
  readonly category?: string;
  readonly valueFormatter?: (value: number) => string;
}

export interface TremorDonutChartProps {
  readonly data: readonly Record<string, number | string>[];
  readonly index: string;
  readonly category: string;
  readonly valueFormatter?: (value: number) => string;
}

export interface TremorBarListProps {
  readonly data: readonly {
    readonly name: string;
    readonly value: number;
    readonly href?: string;
    readonly icon?: unknown;
  }[];
  readonly valueFormatter?: (value: number) => string;
}

export function toTremorLineChartProps(
  model: EngineWideTableInput,
  options: TremorXYOptions = {}
): TremorLineLikeProps {
  return toTremorLineLikeProps(asEngineWideTableModel(model, options), options);
}

export function toTremorAreaChartProps(
  model: EngineWideTableInput,
  options: TremorXYOptions & { readonly type?: "default" | "stacked" | "percent" } = {}
): TremorAreaChartProps {
  return {
    ...toTremorLineLikeProps(asEngineWideTableModel(model, options), options),
    ...(options.type ? { type: options.type } : {}),
  };
}

export function toTremorBarChartProps(
  model: EngineWideTableInput,
  options: TremorXYOptions & {
    readonly layout?: "vertical" | "horizontal";
    readonly type?: "default" | "stacked" | "percent";
  } = {}
): TremorBarChartProps {
  return {
    ...toTremorLineLikeProps(asEngineWideTableModel(model, options), options),
    ...(options.layout ? { layout: options.layout } : {}),
    ...(options.type ? { type: options.type } : {}),
  };
}

export function toTremorDonutChartProps(
  model: EngineLatestValueInput,
  options: TremorLatestOptions = {}
): TremorDonutChartProps {
  const latest = asEngineLatestValueModel(model, options);
  const index = options.index ?? "label";
  const category = options.category ?? "value";
  if (index === category) {
    throw new RangeError(`Tremor donut index and category keys must be distinct: ${index}`);
  }
  return {
    data: latest.rows.flatMap((row) =>
      row.value === null
        ? []
        : [
            {
              [index]: row.label,
              [category]: row.value,
            },
          ]
    ),
    index,
    category,
    ...(options.valueFormatter ? { valueFormatter: options.valueFormatter } : {}),
  };
}

export function toTremorBarListProps(
  model: EngineLatestValueInput,
  options: Pick<
    TremorLatestOptions,
    "seriesLabel" | "timestampUnit" | "maxPoints" | "valueFormatter"
  > = {}
): TremorBarListProps {
  const latest = asEngineLatestValueModel(model, options);
  return {
    data: latest.rows.flatMap((row) =>
      row.value === null
        ? []
        : [
            {
              name: row.label,
              value: row.value,
            },
          ]
    ),
    ...(options.valueFormatter ? { valueFormatter: options.valueFormatter } : {}),
  };
}

function toTremorLineLikeProps(
  model: EngineWideTableModel,
  options: TremorXYOptions
): TremorLineLikeProps {
  const index = options.index ?? "time";
  const usedCategoryKeys = new Set<string>([index]);
  const series = model.series.map((series, seriesIndex) => {
    const label = options.categoryLabel?.(series, seriesIndex) ?? series.label;
    return {
      id: series.id,
      key: uniqueCategoryKey(label, usedCategoryKeys),
      label,
    };
  });

  return {
    data: model.rows.map((row) => {
      const output: Record<string, number | string | null> = {
        [index]: row.t,
      };
      for (let i = 0; i < model.series.length; i++) {
        const seriesMeta = model.series[i];
        const tremorSeries = series[i];
        if (!seriesMeta || !tremorSeries) continue;
        output[tremorSeries.key] = row.values[i] ?? null;
      }
      return output;
    }),
    index,
    categories: series.map((series) => series.key),
    ...(options.valueFormatter ? { valueFormatter: options.valueFormatter } : {}),
    ...(options.connectNulls !== undefined ? { connectNulls: options.connectNulls } : {}),
    meta: {
      series,
    },
  };
}

function uniqueCategoryKey(label: string, used: Set<string>): string {
  const base = label.length > 0 ? label : `series-${used.size}`;
  let key = base;
  let suffix = 2;
  while (used.has(key)) {
    key = `${base} (${suffix})`;
    suffix += 1;
  }
  used.add(key);
  return key;
}
