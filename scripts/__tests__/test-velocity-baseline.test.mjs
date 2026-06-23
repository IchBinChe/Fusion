import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  main,
  measureCommands,
  readQuarantineCount,
  renderReport,
  topSlowestFiles,
} from "../test-velocity-baseline.mjs";

function nullStream() {
  return { write() {} };
}

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "fusion-test-velocity-"));
}

function makeTimings(count = 25) {
  const files = {};
  for (let index = 0; index < count; index += 1) {
    files[`packages/a/src/__tests__/case-${String(index).padStart(2, "0")}.test.ts`] = 100 + index;
  }
  files["packages/a/src/__tests__/tie-z.test.ts"] = 500;
  files["packages/a/src/__tests__/tie-a.test.ts"] = 500;
  return {
    packages: {
      "@pkg/b": {
        files: {
          "packages/b/src/__tests__/winner.test.ts": 1000,
        },
      },
      "@pkg/a": { files },
    },
  };
}

describe("topSlowestFiles", () => {
  it("returns exactly 20 rows in descending duration order with package attribution and stable ties", () => {
    const rows = topSlowestFiles(makeTimings(), 20);

    assert.equal(rows.length, 20);
    assert.deepEqual(rows[0], {
      file: "packages/b/src/__tests__/winner.test.ts",
      ms: 1000,
      package: "@pkg/b",
    });
    assert.deepEqual(rows.slice(1, 3).map((row) => row.file), [
      "packages/a/src/__tests__/tie-a.test.ts",
      "packages/a/src/__tests__/tie-z.test.ts",
    ]);
    assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].ms >= row.ms));
    assert.equal(rows[1].package, "@pkg/a");
  });
});

describe("readQuarantineCount", () => {
  it("counts entries by age bucket and flags deletion-due quarantines after 14 days", () => {
    const result = readQuarantineCount(
      {
        entries: [
          { file: "fresh.test.ts", quarantinedAt: "2026-06-15" },
          { file: "warning.test.ts", quarantinedAt: "2026-06-08" },
          { file: "due.test.ts", quarantinedAt: "2026-06-01" },
          { file: "unknown.test.ts", quarantinedAt: "not-a-date" },
        ],
      },
      { now: new Date("2026-06-17T12:00:00.000Z") },
    );

    assert.equal(result.total, 4);
    assert.deepEqual(result.byAgeBucket, {
      "0-6d": 1,
      "7-13d": 1,
      deletionDue: 1,
      unknown: 1,
    });
    assert.deepEqual(result.deletionDueEntries, [
      { file: "due.test.ts", quarantinedAt: "2026-06-01", ageDays: 16 },
    ]);
  });
});

describe("measureCommands", () => {
  it("runs the build preflight before measured lanes and excludes setup time from lane ms", async () => {
    const calls = [];
    let built = false;
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      commandRunner: async (measurement) => {
        calls.push(measurement.command === "pnpm" ? `pnpm ${measurement.args.join(" ")}` : measurement.label);
        if (measurement.args[0] === "build") {
          built = true;
          return { ms: 50_000, failure: null };
        }
        if (measurement.args[0] === "smoke:boot") {
          assert.equal(built, true, "boot smoke should only run after the build preflight creates CLI dist");
          return { ms: 406, failure: null };
        }
        if (measurement.args[0] === "test") return { ms: 7_300, failure: null };
        return { ms: 12_000, failure: null };
      },
    });

    assert.deepEqual(calls, ["pnpm build", "pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
    assert.equal(result.bootSmokeMs, 406);
    assert.equal(result.testMs, 7_300);
    assert.deepEqual(result.measurementFailures, []);
  });

  it("records preflight failure instead of silently attributing missing build output to boot smoke", async () => {
    const calls = [];
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      commandRunner: async (measurement) => {
        calls.push(`pnpm ${measurement.args.join(" ")}`);
        return {
          ms: null,
          failure: { label: measurement.label, status: "exit 1 after 400ms" },
        };
      },
    });

    assert.deepEqual(calls, ["pnpm build"]);
    assert.equal(result.gateMs, undefined);
    assert.equal(result.bootSmokeMs, undefined);
    assert.equal(result.testMs, undefined);
    assert.deepEqual(result.measurementFailures, [
      { label: "Build preflight (`pnpm build`)", status: "exit 1 after 400ms" },
    ]);
  });

  it("honors --skip-build-preflight-style opt out while still measuring lanes", async () => {
    const calls = [];
    const result = await measureCommands({
      timeoutMs: 10_000,
      cwd: "/repo",
      stdout: nullStream(),
      stderr: nullStream(),
      skipBuildPreflight: true,
      commandRunner: async (measurement) => {
        calls.push(`pnpm ${measurement.args.join(" ")}`);
        return { ms: 100 + calls.length, failure: null };
      },
    });

    assert.deepEqual(calls, ["pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
    assert.equal(result.gateMs, 101);
    assert.equal(result.bootSmokeMs, 102);
    assert.equal(result.testMs, 103);
  });
});

describe("main", () => {
  it("keeps report-only regeneration cheap by invoking neither preflight nor suites", async () => {
    const rootDir = tempRoot();
    try {
      const exitCode = await main([], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          throw new Error(`unexpected command: ${measurement.label}`);
        },
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /Report-only regeneration is cheap and does not run any suite/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("honors --skip-build-preflight while still measuring lanes", async () => {
    const rootDir = tempRoot();
    const calls = [];
    try {
      const exitCode = await main(["--measure", "--write-report", "--skip-build-preflight"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => {
          calls.push(`pnpm ${measurement.args.join(" ")}`);
          return { ms: 1_000 * calls.length, failure: null };
        },
      });

      assert.equal(exitCode, 0);
      assert.deepEqual(calls, ["pnpm test:gate", "pnpm smoke:boot", "pnpm test"]);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /Boot smoke wall-time \(`pnpm smoke:boot`\) \| 2\.0s/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("records preflight failure in the generated measurement failures section", async () => {
    const rootDir = tempRoot();
    try {
      const exitCode = await main(["--measure", "--write-report"], {
        rootDir,
        stdout: nullStream(),
        stderr: nullStream(),
        now: new Date("2026-06-21T12:00:00.000Z"),
        commandRunner: async (measurement) => ({
          ms: null,
          failure: { label: measurement.label, status: "exit 2 after 1.0s" },
        }),
      });

      assert.equal(exitCode, 0);
      const report = readFileSync(path.join(rootDir, "docs/test-velocity-baseline.md"), "utf8");
      assert.match(report, /- Build preflight \(`pnpm build`\): exit 2 after 1\.0s/);
      assert.doesNotMatch(report, /Boot smoke \(`pnpm smoke:boot`\):/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("renderReport", () => {
  it("includes metrics, slowest rows, quarantine count, and previous-run deltas", () => {
    const report = renderReport({
      gateMs: 12_000,
      bootSmokeMs: 2_000,
      testMs: 45_000,
      capturedAt: "2026-06-17T12:00:00.000Z",
      previous: {
        capturedAt: "2026-06-10T12:00:00.000Z",
        gateMs: 10_000,
        bootSmokeMs: 3_000,
        testMs: 50_000,
        quarantineCount: 3,
      },
      slowest: [
        { file: "packages/a/src/__tests__/slow.test.ts", package: "@pkg/a", ms: 3210 },
      ],
      quarantine: {
        total: 2,
        byAgeBucket: { "0-6d": 1, "7-13d": 1, deletionDue: 0, unknown: 0 },
        deletionDueEntries: [],
        deletionDueCount: 0,
      },
    });

    assert.match(report, /\| Merge gate wall-time \(`pnpm test:gate`\) \| 12\.0s \| \+2\.0s \|/);
    assert.match(report, /\| Boot smoke wall-time \(`pnpm smoke:boot`\) \| 2\.0s \| -1\.0s \|/);
    assert.match(report, /\| Changed-only test wall-time \(`pnpm test`\) \| 45\.0s \| -5\.0s \|/);
    assert.match(report, /\| Quarantine \/ flake count \| 2 \| -1 \|/);
    assert.match(report, /`packages\/a\/src\/__tests__\/slow\.test\.ts` \| @pkg\/a \| 3\.2s/);
    assert.match(report, /FN-6612 weekly test velocity: gate 12\.0s \(\+2\.0s\)/);
  });

  it("renders seed-baseline trend placeholders when there is no previous entry", () => {
    const report = renderReport({
      gateMs: 1_000,
      bootSmokeMs: null,
      testMs: 2_000,
      capturedAt: "2026-06-17T12:00:00.000Z",
      slowest: [],
      quarantine: { total: 0, byAgeBucket: {}, deletionDueEntries: [], deletionDueCount: 0 },
    });

    assert.match(report, /\| Previous \| _\(seed baseline\)_ \| — \| — \| — \| — \|/);
    assert.match(report, /\| Delta \| — \| n\/a \| n\/a \| n\/a \| n\/a \|/);
  });
});
