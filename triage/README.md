# Issue triage

Assigns an existing `area/*` label to unlabelled issues, or `needs-triage` when unsure.

- `labels.md` — area definitions and the precedence rules. The classifier reads this;
  it is the thing to edit when classification is wrong.
- `classify.mjs` — the classifier.
- `eval/ground-truth.json` — 119 real Fusion issues with a reference area, for scoring.

## Why it is shaped this way

**Cron, not `issues: opened`.** A workflow only receives issue events for the repo it lives in,
and the eventual target is a repo we do not control. A schedule also removes the
attacker-controlled trigger behind the 2026 prompt-injection incidents.

**The model's answer is a suggestion, not an action.** `decide()` intersects it with the live
label list before anything is written, so a successful prompt injection is worth at most a
wrong-but-valid label — not a new label, not a removed one, not a comment.

**`addLabels`, never `setLabels`.** `setLabels` replaces the whole set and would erase
labels a human applied.

**Labels only, no comments.** Around half of Fusion's issues are French; a commenting bot
would reply in English to their authors.

**Abstention is a correct outcome.** Measured on real data: 21% of issues fit two areas
equally and 8% cannot be classified from the title at all. A classifier that always answers
is lying about one in four issues.

## Running it

```bash
export GITHUB_TOKEN=...        # needs issues:write on the target
export GROQ_API_KEY=...        # free tier: 14,400 req/day; this needs ~26/day
export TARGET_REPO=IchBinChe/Fusion

node triage/classify.mjs --eval triage/eval/ground-truth.json --limit 30   # score, writes nothing
node triage/classify.mjs --dry-run                                        # live issues, writes nothing
node triage/classify.mjs                                                  # applies labels
```

## On the eval numbers

`ground-truth.json` is a *reference* classification produced by a model reading titles, not a
human-verified answer key. Scoring against it measures agreement, not correctness. Published
work puts the realistic ceiling for this task at ~0.83 F1 on three classes, and finds human
issue labels themselves are wrong about a third of the time — so treat a high score as
"behaving sanely", not "solved". A human-labelled sample is what would make these numbers real.
