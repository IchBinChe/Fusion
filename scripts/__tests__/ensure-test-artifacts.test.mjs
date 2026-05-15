import test from "node:test";
import assert from "node:assert/strict";
import {
  detectMissingArtifacts,
  detectMissingOrStaleArtifacts,
  ensureTestArtifacts,
  REQUIRED_BUILD_PACKAGES,
} from "../ensure-test-artifacts.mjs";

test("detectMissingArtifacts returns missing package list", () => {
  const missing = detectMissingArtifacts("/repo", () => false);
  assert.equal(missing.length, REQUIRED_BUILD_PACKAGES.length);
  assert.equal(missing[0].name, "@fusion/core");
});

test("ensureTestArtifacts skips build when nothing is missing", () => {
  let called = false;
  const built = ensureTestArtifacts("/repo", () => {
    called = true;
  }, () => true);

  assert.equal(called, false);
  assert.deepEqual(built, []);
});

test("ensureTestArtifacts builds only missing packages", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.includes("fusion-plugin-openclaw-runtime"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});

test("detectMissingArtifacts flags @fusion/dashboard when dist/index.js is missing", () => {
  const missing = detectMissingArtifacts("/repo", (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion/dashboard"));
});

test("ensureTestArtifacts rebuilds @fusion/dashboard when its dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"),
  );

  assert.deepEqual(built, ["@fusion/dashboard"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion/dashboard", "build"]);
});

test("detectMissingArtifacts flags @fusion/engine when dist/index.js is missing", () => {
  const missing = detectMissingArtifacts("/repo", (fullPath) => !fullPath.endsWith("packages/engine/dist/index.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion/engine"));
});

test("ensureTestArtifacts rebuilds @fusion/engine when dist is missing", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("packages/engine/dist/index.js"),
  );

  assert.deepEqual(built, ["@fusion/engine"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion/engine", "build"]);
});

test("detectMissingArtifacts flags dependency-graph when dist/dashboard-view.js is missing", () => {
  const missing = detectMissingArtifacts(
    "/repo",
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
  );
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/dependency-graph"));
});

test("ensureTestArtifacts rebuilds dependency-graph for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/dependency-graph"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/dependency-graph", "build"]);
});

test("detectMissingArtifacts flags hermes when dist/index.js exists but dist/cli-spawn.js is missing", () => {
  const missing = detectMissingArtifacts("/repo", (fullPath) => !fullPath.endsWith("dist/cli-spawn.js"));
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/hermes-runtime"));
});

test("ensureTestArtifacts rebuilds hermes for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-hermes-runtime/dist/cli-spawn.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/hermes-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/hermes-runtime", "build"]);
});

test("detectMissingArtifacts flags openclaw when dist/index.js exists but transitive files are missing", () => {
  const missing = detectMissingArtifacts(
    "/repo",
    (fullPath) => fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/index.js"),
  );
  const names = missing.map((pkg) => pkg.name);

  assert.ok(names.includes("@fusion-plugin-examples/openclaw-runtime"));
});

test("ensureTestArtifacts rebuilds openclaw for incomplete dist artifacts", () => {
  const calls = [];
  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-openclaw-runtime/dist/runtime-adapter.js"),
  );

  assert.deepEqual(built, ["@fusion-plugin-examples/openclaw-runtime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "pnpm");
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/openclaw-runtime", "build"]);
});

function createStaleFsForPackage({ sourceDir, artifactPathFragment }, { artifactMtime = 1000, sourceMtime = 2000 } = {}) {
  const sourceFile = `${sourceDir}/index.ts`;

  const statFn = (fullPath) => {
    if (fullPath.includes(artifactPathFragment)) return { mtimeMs: artifactMtime };
    if (fullPath === sourceFile) return { mtimeMs: sourceMtime };
    return { mtimeMs: 0 };
  };

  const readdirFn = (dirPath) => {
    if (dirPath === sourceDir) {
      return [{ name: "index.ts", isDirectory: () => false }];
    }
    return [];
  };

  return { statFn, readdirFn };
}

function createStaleFs(pluginName, { artifactMtime = 1000, sourceMtime = 2000 } = {}) {
  const sourceDir = `/repo/plugins/${pluginName}/src`;

  return createStaleFsForPackage({ sourceDir, artifactPathFragment: "/dist/" }, { artifactMtime, sourceMtime });
}

test("detectMissingOrStaleArtifacts returns hermes when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion-plugin-examples/hermes-runtime"));
});

test("detectMissingOrStaleArtifacts does not flag hermes when dist is newer than src", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 4000,
    sourceMtime: 2000,
  });

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(!result.some((pkg) => pkg.name === "@fusion-plugin-examples/hermes-runtime"));
});

test("detectMissingOrStaleArtifacts covers all example plugins for staleness", async (t) => {
  const cases = [
    ["fusion-plugin-hermes-runtime", "@fusion-plugin-examples/hermes-runtime"],
    ["fusion-plugin-openclaw-runtime", "@fusion-plugin-examples/openclaw-runtime"],
    ["fusion-plugin-paperclip-runtime", "@fusion-plugin-examples/paperclip-runtime"],
  ];

  for (const [pluginName, pkgName] of cases) {
    await t.test(pkgName, () => {
      const { statFn, readdirFn } = createStaleFs(pluginName, { artifactMtime: 1000, sourceMtime: 3000 });
      const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
      assert.ok(result.some((pkg) => pkg.name === pkgName));
    });
  }
});

test("detectMissingOrStaleArtifacts flags @fusion/engine when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFsForPackage(
    { sourceDir: "/repo/packages/engine/src", artifactPathFragment: "packages/engine/dist/" },
    { artifactMtime: 1000, sourceMtime: 3000 },
  );

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion/engine"));
});

test("detectMissingOrStaleArtifacts flags dependency-graph when dist artifact is older than src", () => {
  const { statFn, readdirFn } = createStaleFsForPackage(
    {
      sourceDir: "/repo/plugins/fusion-plugin-dependency-graph/src",
      artifactPathFragment: "plugins/fusion-plugin-dependency-graph/dist/",
    },
    { artifactMtime: 1000, sourceMtime: 3000 },
  );

  const result = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);
  assert.ok(result.some((pkg) => pkg.name === "@fusion-plugin-examples/dependency-graph"));
});

test("detectMissingOrStaleArtifacts merges missing and stale results without duplicates", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  const result = detectMissingOrStaleArtifacts(
    "/repo",
    (fullPath) => !fullPath.endsWith("packages/dashboard/dist/index.js"),
    statFn,
    readdirFn,
  );

  const names = result.map((pkg) => pkg.name);
  assert.ok(names.includes("@fusion/dashboard"));
  assert.ok(names.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(new Set(names).size, names.length);
});

test("detectMissingArtifacts alias returns same value as detectMissingOrStaleArtifacts", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  const aliasResult = detectMissingArtifacts("/repo", () => true, statFn, readdirFn);
  const directResult = detectMissingOrStaleArtifacts("/repo", () => true, statFn, readdirFn);

  assert.deepEqual(aliasResult.map((pkg) => pkg.name), directResult.map((pkg) => pkg.name));
});

test("ensureTestArtifacts invokes rebuild command for stale package", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });
  const calls = [];

  const built = ensureTestArtifacts(
    "/repo",
    (cmd, args, cwd) => calls.push({ cmd, args, cwd }),
    () => true,
    statFn,
    readdirFn,
  );

  assert.ok(built.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--filter", "@fusion-plugin-examples/hermes-runtime", "build"]);
});

test("ensureTestArtifacts writes detailed FN-4232/FN-4605 remediation block to stderr on rebuild failure", () => {
  const { statFn, readdirFn } = createStaleFs("fusion-plugin-hermes-runtime", {
    artifactMtime: 1000,
    sourceMtime: 3000,
  });

  let stderr = "";
  let exitCode = null;

  const built = ensureTestArtifacts(
    "/repo",
    undefined,
    () => true,
    statFn,
    readdirFn,
    {
      spawnFn: () => ({ status: 2 }),
      exitFn: (code) => {
        exitCode = code;
      },
      stderrWrite: (chunk) => {
        stderr += String(chunk);
        return true;
      },
    },
  );

  assert.ok(built.includes("@fusion-plugin-examples/hermes-runtime"));
  assert.equal(exitCode, 2);
  assert.match(stderr, /@fusion-plugin-examples\/hermes-runtime/);
  assert.match(stderr, /\[test-bootstrap\] stale \(src newer than dist\): plugins\/fusion-plugin-hermes-runtime\/dist\/index.js/);
  assert.match(stderr, /\[test-bootstrap\] stale \(src newer than dist\): plugins\/fusion-plugin-hermes-runtime\/dist\/cli-spawn.js/);
  assert.match(stderr, /pnpm install --frozen-lockfile/);
  assert.match(stderr, /FN-4232, FN-4605/);
});

test("ensureTestArtifacts remediation labels missing artifact paths", () => {
  let stderr = "";
  let exitCode = null;

  const built = ensureTestArtifacts(
    "/repo",
    undefined,
    (fullPath) => !fullPath.endsWith("plugins/fusion-plugin-dependency-graph/dist/dashboard-view.js"),
    () => ({ mtimeMs: 1_000 }),
    () => [],
    {
      spawnFn: () => ({ status: 3 }),
      exitFn: (code) => {
        exitCode = code;
      },
      stderrWrite: (chunk) => {
        stderr += String(chunk);
        return true;
      },
    },
  );

  assert.ok(built.includes("@fusion-plugin-examples/dependency-graph"));
  assert.equal(exitCode, 3);
  assert.match(stderr, /\[test-bootstrap\] missing: plugins\/fusion-plugin-dependency-graph\/dist\/dashboard-view.js/);
});
