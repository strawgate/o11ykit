function labelsKey(labels) {
  return [...labels.entries()]
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("\0");
}

export function deserializeWorkerResult(result) {
  return {
    scannedSeries: result.scannedSeries,
    scannedSamples: result.scannedSamples,
    requestedStep: result.requestedStep ?? null,
    effectiveStep: result.effectiveStep ?? null,
    pointBudget: result.pointBudget ?? null,
    series: result.series.map((series) => ({
      labels: new Map(series.labels),
      timestamps: series.timestamps,
      values: series.values,
    })),
  };
}

export function mergeRawWorkerResults(results) {
  const series = [];
  let scannedSeries = 0;
  let scannedSamples = 0;
  for (const result of results) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    series.push(...result.series);
  }
  series.sort((a, b) => labelsKey(a.labels).localeCompare(labelsKey(b.labels)));
  return {
    series,
    scannedSeries,
    scannedSamples,
    requestedStep: results[0]?.requestedStep ?? null,
    effectiveStep: results[0]?.effectiveStep ?? null,
    pointBudget: results[0]?.pointBudget ?? null,
  };
}

export function mergeReductionWorkerResults(results, agg) {
  const groups = new Map();
  let scannedSeries = 0;
  let scannedSamples = 0;

  for (const result of results) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    for (const series of result.series) {
      const key = labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const value = series.values[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, value });
          continue;
        }
        const existing = group.points.get(pointKey);
        if (agg === "sum" || agg === "count") existing.value += value;
        else if (agg === "min") existing.value = Math.min(existing.value, value);
        else if (agg === "max") existing.value = Math.max(existing.value, value);
      }
    }
  }

  return {
    scannedSeries,
    scannedSamples,
    requestedStep: results[0]?.requestedStep ?? null,
    effectiveStep: results[0]?.effectiveStep ?? null,
    pointBudget: results[0]?.pointBudget ?? null,
    series: [...groups.values()].map((group) => {
      const points = [...group.points.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
      );
      return {
        labels: group.labels,
        timestamps: BigInt64Array.from(points.map((point) => point.timestamp)),
        values: Float64Array.from(points.map((point) => point.value)),
      };
    }),
  };
}

export function mergeAvgWorkerResults(sumResults, countResults) {
  const groups = new Map();
  let scannedSeries = 0;
  let scannedSamples = 0;

  for (const result of sumResults) {
    scannedSeries += result.scannedSeries;
    scannedSamples += result.scannedSamples;
    for (const series of result.series) {
      const key = labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, sum: 0, count: 0 });
        }
        group.points.get(pointKey).sum += series.values[i];
      }
    }
  }

  for (const result of countResults) {
    for (const series of result.series) {
      const key = labelsKey(series.labels);
      let group = groups.get(key);
      if (!group) {
        group = { labels: series.labels, points: new Map() };
        groups.set(key, group);
      }
      for (let i = 0; i < series.timestamps.length; i++) {
        const timestamp = series.timestamps[i];
        const pointKey = timestamp.toString();
        if (!group.points.has(pointKey)) {
          group.points.set(pointKey, { timestamp, sum: 0, count: 0 });
        }
        group.points.get(pointKey).count += series.values[i];
      }
    }
  }

  return {
    scannedSeries,
    scannedSamples,
    requestedStep: sumResults[0]?.requestedStep ?? null,
    effectiveStep: sumResults[0]?.effectiveStep ?? null,
    pointBudget: sumResults[0]?.pointBudget ?? null,
    series: [...groups.values()].map((group) => {
      const points = [...group.points.values()].sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
      );
      return {
        labels: group.labels,
        timestamps: BigInt64Array.from(points.map((point) => point.timestamp)),
        values: Float64Array.from(
          points.map((point) => (point.count > 0 ? point.sum / point.count : 0))
        ),
      };
    }),
  };
}

export function mergeWorkerResponses(workerResponses, agg) {
  if (agg === "avg") {
    const sumResults = workerResponses.map((response) => deserializeWorkerResult(response.sum));
    const countResults = workerResponses.map((response) =>
      deserializeWorkerResult(response.count)
    );
    return mergeAvgWorkerResults(sumResults, countResults);
  }

  if (agg === "sum" || agg === "min" || agg === "max" || agg === "count") {
    return mergeReductionWorkerResults(
      workerResponses.map((response) => deserializeWorkerResult(response.result)),
      agg
    );
  }

  return mergeRawWorkerResults(
    workerResponses.map((response) => deserializeWorkerResult(response.result))
  );
}
