import { afterEach, describe, expect, it } from "vitest";
import { checkDiffVolume } from "../../merger-diff-volume-gate.js";
import { makeReliabilityFixture, hasGit, git } from "./_helpers.js";

const describeIfGit = hasGit ? describe : describe.skip;

describeIfGit("reliability interactions: merge strategy + overlap", () => {
  const fixtures: Array<Awaited<ReturnType<typeof makeReliabilityFixture>>> = [];
  afterEach(async () => { while (fixtures.length) await fixtures.pop()!.cleanup(); });

  it.skip("Case 6: auto strategy keeps multi-commit branch history", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C6", settings: { directMergeCommitStrategy: "auto" } });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-c6");
    await fx.writeAndCommit("src/a.txt", "1\n", "fix: one");
    await fx.writeAndCommit("src/b.txt", "2\n", "fix: two");
    await fx.writeAndCommit("src/c.txt", "3\n", "fix: three");
    await fx.checkout("main");
    await fx.store.updateTask(fx.task.id, { branch: "fusion/fn-4361-c6", column: "in-review", steps: [{ name: "impl", status: "done" }] } as any);

    await fx.mergeTask();
    const subjects = git(fx.rootDir, "git log --format=%s -n 3");
    expect(subjects).toContain("fix: one");
    expect(subjects).toContain("fix: two");
    expect(subjects).toContain("fix: three");
  });

  it("Case 7: diff-volume gate detects dropped branch contribution", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-C7" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-c7");
    await fx.writeAndCommit("packages/core/src/drop.ts", Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n", "feat: branch volume");
    await fx.checkout("main");
    const base = git(fx.rootDir, "git rev-parse HEAD");
    git(fx.rootDir, "git merge --squash fusion/fn-4361-c7");
    git(fx.rootDir, "git reset HEAD -- packages/core/src/drop.ts");

    await expect(checkDiffVolume({
      rootDir: fx.rootDir,
      branch: "fusion/fn-4361-c7",
      integrationTargetSha: base,
      minLines: 20,
      threshold: 0.2,
      allowlistGlobs: [],
      taskId: fx.task.id,
    })).rejects.toMatchObject({ name: "DiffVolumeRegressionError" });
  });

  it("Additional: diff-volume gate runs before later invariant checks on empty staged set", async () => {
    const fx = await makeReliabilityFixture({ taskId: "FN-4361-MX" });
    fixtures.push(fx);
    await fx.createBranch("fusion/fn-4361-mx");
    await fx.writeAndCommit("src/mx.txt", Array.from({ length: 40 }, (_, i) => `x${i}`).join("\n") + "\n", "feat: mx");
    await fx.checkout("main");
    const base = git(fx.rootDir, "git rev-parse HEAD");
    git(fx.rootDir, "git merge --squash fusion/fn-4361-mx");
    git(fx.rootDir, "git reset HEAD -- src/mx.txt");
    await expect(checkDiffVolume({ rootDir: fx.rootDir, branch: "fusion/fn-4361-mx", integrationTargetSha: base, minLines: 20, threshold: 0.2, allowlistGlobs: [], taskId: fx.task.id })).rejects.toBeTruthy();
  });
});
