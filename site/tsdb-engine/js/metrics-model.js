// @ts-check

/** @typedef {import("../site-types").LabelMeta} LabelMeta */
/** @typedef {import("../site-types").MetricMeta} MetricMeta */
/** @typedef {import("../site-types").MetricStore} MetricStore */
/** @typedef {import("../site-types").MetricDimensionView} MetricDimensionView */
/** @typedef {import("../site-types").MetricViewConfig} MetricViewConfig */

/**
 * @param {string} metric
 * @returns {boolean}
 */
export function isCounterLikeMetric(metric) {
  return (
    /(?:^|_)(?:total|count|requests|events|restarts?)(?:$|_)/.test(metric) ||
    /^network_(?:rx|tx)_bytes$/.test(metric) ||
    /\.network\.(?:io|errors)$/.test(metric) ||
    /\.cpu\.time$/.test(metric)
  );
}

/**
 * @param {string} metric
 * @returns {string}
 */
export function formatMetricName(metric) {
  return metric.replaceAll(".", " ").replaceAll("_", " ");
}

/**
 * @param {LabelMeta} labelMeta
 * @param {number} totalSeries
 * @returns {number}
 */
export function scoreLabelMeta(labelMeta, totalSeries) {
  const cardinality = labelMeta.cardinality;
  const avgSeriesPerValue = totalSeries / Math.max(1, cardinality);
  let score = 0;
  if (cardinality <= 1) return -Infinity;
  if (cardinality <= 8) score += 120;
  else if (cardinality <= 16) score += 90;
  else if (cardinality <= 32) score += 60;
  else score += 20;
  score += Math.min(40, avgSeriesPerValue * 8);
  score -= Math.max(0, cardinality - 24);
  return score;
}

/**
 * @param {MetricStore | null | undefined} store
 * @param {string} metric
 * @returns {number[]}
 */
export function getMetricIds(store, metric) {
  return store ? store.matchLabel("__name__", metric) : [];
}

/**
 * @param {MetricStore | null | undefined} store
 * @param {string} metric
 * @param {number[]} [ids]
 * @returns {number}
 */
export function suggestMetricStep(store, metric, ids = getMetricIds(store, metric)) {
  if (!store || ids.length === 0) return 60000;
  const firstId = ids[0];
  if (firstId === undefined) return 60000;
  const range = store.read(firstId, -BigInt("9223372036854775808"), BigInt("9223372036854775807"));
  if (range.timestamps.length < 2) return 60000;
  const firstTimestamp = range.timestamps[0];
  const secondTimestamp = range.timestamps[1];
  if (firstTimestamp === undefined || secondTimestamp === undefined) return 60000;
  const intervalMs = Number(secondTimestamp - firstTimestamp) / 1_000_000;
  if (intervalMs <= 1000) return 10000;
  if (intervalMs <= 15000) return 60000;
  if (intervalMs <= 60000) return 300000;
  return 900000;
}

/**
 * @param {MetricStore} store
 * @param {string} metric
 * @returns {MetricMeta}
 */
export function collectMetricMeta(store, metric) {
  const ids = getMetricIds(store, metric);
  /** @type {Map<string, Map<string, number>>} */
  const labelValues = new Map();

  for (const id of ids) {
    const labels = store.labels(id);
    if (!labels) continue;
    for (const [key, value] of labels) {
      if (key === "__name__") continue;
      if (!labelValues.has(key)) labelValues.set(key, new Map());
      const counts = labelValues.get(key);
      if (!counts) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  /** @type {LabelMeta[]} */
  const rankedLabels = [...labelValues.entries()]
    .map(([label, values]) => ({
      label,
      cardinality: values.size,
      score: 0,
      values: [...values.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value]) => value),
    }))
    .filter((entry) => entry.cardinality > 1)
    .map((entry) => ({ ...entry, score: scoreLabelMeta(entry, ids.length) }))
    .sort(
      (a, b) => b.score - a.score || a.cardinality - b.cardinality || a.label.localeCompare(b.label)
    );

  return {
    metric,
    ids,
    seriesCount: ids.length,
    counterLike: isCounterLikeMetric(metric),
    rankedLabels,
    suggestedStepMs: suggestMetricStep(store, metric, ids),
  };
}

/**
 * @param {MetricStore} store
 * @param {string} metric
 * @param {number} [count]
 * @returns {string[]}
 */
export function recommendedGroupByForMetric(store, metric, count = 1) {
  const meta = collectMetricMeta(store, metric);
  return meta.rankedLabels.slice(0, count).map((entry) => entry.label);
}

/**
 * @param {MetricMeta} meta
 * @returns {MetricViewConfig}
 */
export function buildMetricOverviewConfig(meta) {
  return {
    metric: meta.metric,
    transform: meta.counterLike ? "rate" : undefined,
    agg: meta.counterLike ? "sum" : meta.seriesCount > 1 ? "avg" : undefined,
    groupBy: undefined,
    stepMs: meta.counterLike || meta.seriesCount > 1 ? meta.suggestedStepMs : 0,
    intro: meta.counterLike
      ? `Showing the total rate for ${formatMetricName(meta.metric)} across all matching series.`
      : meta.seriesCount > 1
        ? `Showing the average trend for ${formatMetricName(meta.metric)} across all matching series.`
        : `Showing the raw ${formatMetricName(meta.metric)} series.`,
  };
}

/**
 * @param {MetricMeta} meta
 * @returns {MetricDimensionView[]}
 */
export function buildMetricDimensionViews(meta) {
  /** @type {MetricDimensionView[]} */
  const views = [
    {
      key: "overview",
      title: "all series",
      config: buildMetricOverviewConfig(meta),
    },
  ];

  for (const labelMeta of meta.rankedLabels) {
    const usesRate = meta.counterLike;
    views.push({
      key: `dimension:${labelMeta.label}`,
      title: labelMeta.label,
      config: {
        metric: meta.metric,
        transform: usesRate ? "rate" : undefined,
        agg: usesRate ? "sum" : "avg",
        groupBy: [labelMeta.label],
        stepMs: meta.suggestedStepMs,
        intro: usesRate
          ? `Showing the rate for ${formatMetricName(meta.metric)} split by ${labelMeta.label}.`
          : `Showing ${formatMetricName(meta.metric)} split by ${labelMeta.label}.`,
      },
    });
  }

  return views;
}
