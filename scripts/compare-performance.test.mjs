import { test } from "node:test";
import assert from "node:assert/strict";
import { compareReports, formatComparison } from "./compare-performance.mjs";

function report(overrides = {}) {
  return {
    maxHeapUsedBytes: 100,
    maxQueuedChars: 50,
    maxFrontendAgeMs: 200,
    maxTimerLagMs: 10,
    maxSampleDurationMs: 5,
    processes: [{ peakPrivateBytes: 1000 }],
    ...overrides,
  };
}

test("flags a metric as regression when candidate exceeds tolerance", () => {
  const baseline = report({ maxHeapUsedBytes: 100 });
  const candidate = report({ maxHeapUsedBytes: 200 }); // +100%
  const result = compareReports(baseline, candidate);
  assert.equal(result.ok, false);
  assert.deepEqual(result.regressions, ["maxHeapUsedBytes"]);
  const heap = result.rows.find((row) => row.key === "maxHeapUsedBytes");
  assert.equal(heap.verdict, "regression");
  assert.equal(heap.deltaRatio, 1);
});

test("treats deltas within tolerance as ok", () => {
  const baseline = report({ maxHeapUsedBytes: 100 });
  const candidate = report({ maxHeapUsedBytes: 105 }); // +5% < 10%
  const result = compareReports(baseline, candidate);
  assert.equal(result.ok, true);
  const heap = result.rows.find((row) => row.key === "maxHeapUsedBytes");
  assert.equal(heap.verdict, "ok");
});

test("respects a custom tolerance", () => {
  const baseline = report({ maxHeapUsedBytes: 100 });
  const candidate = report({ maxHeapUsedBytes: 115 }); // +15%
  assert.equal(compareReports(baseline, candidate, { tolerance: 0.2 }).ok, true);
  assert.equal(compareReports(baseline, candidate, { tolerance: 0.1 }).ok, false);
});

test("treats improvement beyond tolerance as improved, not regression", () => {
  const baseline = report({ maxQueuedChars: 100 });
  const candidate = report({ maxQueuedChars: 50 }); // -50%
  const result = compareReports(baseline, candidate);
  assert.equal(result.ok, true);
  const queued = result.rows.find((row) => row.key === "maxQueuedChars");
  assert.equal(queued.verdict, "improved");
});

test("marks metrics with missing or zero baseline as na without blocking", () => {
  const baseline = report({ maxTimerLagMs: 0, processes: [] });
  const candidate = report({ maxTimerLagMs: 999, processes: [{ peakPrivateBytes: 10 }] });
  const result = compareReports(baseline, candidate);
  assert.equal(result.ok, true); // na 不计入回归
  assert.equal(result.rows.find((row) => row.key === "maxTimerLagMs").verdict, "na");
  assert.equal(result.rows.find((row) => row.key === "peakProcessPrivateBytes").verdict, "na");
});

test("aggregates peak process private bytes across processes", () => {
  const baseline = report({ processes: [{ peakPrivateBytes: 100 }, { peakPrivateBytes: 400 }] });
  const candidate = report({ processes: [{ peakPrivateBytes: 200 }, { peakPrivateBytes: 300 }] });
  const result = compareReports(baseline, candidate);
  const row = result.rows.find((r) => r.key === "peakProcessPrivateBytes");
  assert.equal(row.baseline, 400);
  assert.equal(row.candidate, 300);
  assert.equal(row.verdict, "improved");
});

test("handles null/undefined reports defensively", () => {
  const result = compareReports(undefined, null);
  assert.equal(result.ok, true);
  assert.ok(result.rows.every((row) => row.verdict === "na"));
});

test("formatComparison includes a human-readable verdict line", () => {
  const baseline = report({ maxHeapUsedBytes: 100 });
  const candidate = report({ maxHeapUsedBytes: 200 });
  const text = formatComparison(compareReports(baseline, candidate));
  assert.match(text, /REGRESSION/);
  assert.match(text, /maxHeapUsedBytes/);
});

test("compares observed update intervals while retaining legacy age checks", () => {
  const baseline = report({ maxFrontendAgeMs: 700, maxFrontendUpdateIntervalMs: 15000 });
  const candidate = report({ maxFrontendAgeMs: 14700, maxFrontendUpdateIntervalMs: 15000 });
  assert.equal(compareReports(baseline, candidate).ok, true);
  assert.deepEqual(compareReports(baseline, { ...candidate, maxFrontendUpdateIntervalMs: 30700 }).regressions,
    ["maxFrontendUpdateIntervalMs"]);
  assert.deepEqual(compareReports(baseline, { ...candidate, maxFrontendUpdateIntervalMs: null }).regressions,
    ["maxFrontendAgeMs"]);
});
