#!/usr/bin/env node
/**
 * Fusion issue triage classifier.
 *
 * Assigns an existing `area/*` label to unlabelled issues, or `needs-triage` when unsure.
 * Never creates labels, never removes labels, never comments.
 *
 * Modes:
 *   --eval <ground-truth.json>   classify a fixed set and score against known answers; writes nothing
 *   --dry-run                    classify live issues and print what would be applied; writes nothing
 *   (default)                    classify live issues and apply labels
 *
 * Env: GROQ_API_KEY, GITHUB_TOKEN, TARGET_REPO (owner/repo)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const TARGET = process.env.TARGET_REPO || 'IchBinChe/Fusion';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.TRIAGE_MODEL || 'llama-3.3-70b-versatile';

// Below this, we abstain to needs-triage instead of applying an area label.
const CONFIDENCE_THRESHOLD = Number(process.env.TRIAGE_THRESHOLD || 0.6);
const MAX_AREA_LABELS = 2;
const BODY_CHAR_LIMIT = 4000;
const WRITE_INTERVAL_MS = 1100;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = flag('--dry-run');
const EVAL_FILE = flagValue('--eval');
const LIMIT = Number(flagValue('--limit') || 50);

// ---------------------------------------------------------------- GitHub

/**
 * Note: @actions/github does not bundle retry or throttling, and neither does plain fetch.
 * Rate limiting has to be handled here or not at all. GitHub signals it three different
 * ways — primary limit (x-ratelimit-remaining: 0), secondary limit (retry-after), and abuse
 * detection (403 with neither) — so we honour whichever header is present and back off.
 */
async function gh(path, init = {}, attempt = 1) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GH_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });

  const rateLimited =
    res.status === 429 ||
    (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') ||
    (res.status === 403 && res.headers.get('retry-after'));

  if (rateLimited && attempt <= 3) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const resetAt = Number(res.headers.get('x-ratelimit-reset'));
    const waitMs = retryAfter
      ? retryAfter * 1000
      : resetAt
        ? Math.max(0, resetAt * 1000 - Date.now())
        : 2 ** attempt * 1000;
    console.warn(`rate limited on ${path}; waiting ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
    return gh(path, init, attempt + 1);
  }

  if (res.status >= 500 && attempt <= 3) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    return gh(path, init, attempt + 1);
  }

  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function fetchAllowedLabels() {
  const labels = await gh(`/repos/${TARGET}/labels?per_page=100`);
  return new Set(labels.map((l) => l.name));
}

async function fetchUnlabelledIssues(limit) {
  // `no:label` via search keeps us from paging the whole repo.
  const q = encodeURIComponent(`repo:${TARGET} is:issue is:open no:label`);
  const res = await gh(`/search/issues?q=${q}&per_page=${Math.min(limit, 100)}`);
  return res.items.filter((i) => !i.pull_request);
}

/**
 * addLabels — never setLabels. setLabels replaces the whole set and would wipe human work.
 *
 * Paced deliberately. GitHub's secondary rate limits allow 80 content-creating requests per
 * minute and 500 per hour, they are shared with anything the same account does in the web UI,
 * there is no header or endpoint to check remaining budget, and the documented consequence of
 * ignoring them is having the integration banned. The docs ask for at least one second between
 * write requests, so that is what we do.
 */
async function addLabels(issueNumber, labels) {
  const res = await gh(`/repos/${TARGET}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels }),
  });
  await new Promise((r) => setTimeout(r, WRITE_INTERVAL_MS));
  return res;
}

// ---------------------------------------------------------------- sanitising

/**
 * Issue text is untrusted input. Strip the channels used to hide instructions from
 * a human reviewer while still reaching the model.
 */
function sanitise(text) {
  if (!text) return '';
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')        // HTML comments — invisible in the rendered UI
    .replace(/[​-‍﻿⁠]/g, '') // zero-width characters
    .slice(0, BODY_CHAR_LIMIT);
}

const BACK_REFERENCE = /^\s*#(\d+)\b.{0,40}$/;

/** "#2114 n'est pas résolu" carries no classifiable content of its own. */
function backReferenceTarget(title) {
  const m = title.match(BACK_REFERENCE);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- model

const LABEL_DEFINITIONS = readFileSync(join(HERE, 'labels.md'), 'utf8');

function buildPrompt(areaLabels, issue) {
  return [
    {
      role: 'system',
      content:
        `You classify GitHub issues for the Fusion project into exactly one product area.\n\n` +
        `${LABEL_DEFINITIONS}\n\n` +
        `You may only choose from these labels: ${areaLabels.join(', ')}\n` +
        `Never invent a label. Never choose a label not in that list.\n\n` +
        `Roughly half of these issues are written in French. Do NOT mark issues as low quality, ` +
        `spam, or incomplete purely because they are not in English or have imperfect grammar.\n\n` +
        `Respond with JSON only: {"area": "<label or null>", "confidence": <0..1>, "why": "<max 15 words>"}\n` +
        `Set area to null when two areas fit equally and no precedence rule resolves it, or when ` +
        `the text is too thin to classify. Abstaining is correct and expected; a wrong area label ` +
        `is worse than none.`,
    },
    {
      role: 'user',
      content: `Title: ${sanitise(issue.title)}\n\nBody:\n${sanitise(issue.body) || '(empty)'}`,
    },
  ];
}

async function classify(areaLabels, issue, attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: buildPrompt(areaLabels, issue),
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  });

  if (res.status === 429 && attempt <= 3) {
    const wait = Number(res.headers.get('retry-after') || 5) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return classify(areaLabels, issue, attempt + 1);
  }
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);

  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return { area: null, confidence: 0, why: 'unparseable model output' };
  }
}

/**
 * The model's answer is a suggestion. This is the boundary that makes a successful prompt
 * injection worth at most a wrong-but-valid label.
 */
function decide(verdict, allowed) {
  // Match case-insensitively and trimmed, then map back to the label's real casing.
  // A model that answers "Area/Chat " is picking a valid label badly, not picking an
  // invalid one — dropping it would lose recall without buying any safety.
  const canonical = new Map([...allowed].map((l) => [l.trim().toLowerCase(), l]));
  const picked = [verdict?.area]
    .filter((l) => typeof l === 'string')
    .map((l) => canonical.get(l.trim().toLowerCase()))
    .filter(Boolean)
    .slice(0, MAX_AREA_LABELS);

  const confident = Number(verdict?.confidence || 0) >= CONFIDENCE_THRESHOLD;
  if (picked.length && confident) return { labels: picked, abstained: false };
  return { labels: ['needs-triage'], abstained: true };
}

// ---------------------------------------------------------------- runs

async function runEval(file) {
  const truth = JSON.parse(readFileSync(file, 'utf8'));
  const allowed = await fetchAllowedLabels();
  const areaLabels = [...allowed].filter((l) => l.startsWith('area/'));

  let correct = 0, abstained = 0, wrong = 0;
  const mistakes = [];

  for (const entry of truth.slice(0, LIMIT)) {
    const verdict = await classify(areaLabels, entry, 1).catch((e) => ({ area: null, confidence: 0, why: e.message }));
    const { labels, abstained: didAbstain } = decide(verdict, allowed);
    if (didAbstain) {
      abstained++;
    } else if (labels[0] === entry.expected) {
      correct++;
    } else {
      wrong++;
      mistakes.push({ n: entry.number, expected: entry.expected, got: labels[0], why: verdict.why });
    }
    process.stdout.write(didAbstain ? '.' : labels[0] === entry.expected ? '+' : 'x');
  }

  const scored = correct + wrong;
  console.log(`\n\nEvaluated ${truth.slice(0, LIMIT).length} issues`);
  console.log(`  correct   ${correct}`);
  console.log(`  wrong     ${wrong}`);
  console.log(`  abstained ${abstained}`);
  if (scored) console.log(`  precision (of those it answered): ${((correct / scored) * 100).toFixed(1)}%`);
  console.log(`  coverage  (share it answered):          ${((scored / (scored + abstained)) * 100).toFixed(1)}%`);
  if (mistakes.length) {
    console.log('\nMistakes:');
    for (const m of mistakes) console.log(`  #${m.n} expected ${m.expected}, got ${m.got} — ${m.why}`);
  }
}

async function runLive() {
  const allowed = await fetchAllowedLabels();
  const areaLabels = [...allowed].filter((l) => l.startsWith('area/'));
  if (!areaLabels.length) throw new Error(`No area/* labels exist on ${TARGET}; nothing to assign.`);

  const issues = await fetchUnlabelledIssues(LIMIT);
  console.log(`${TARGET}: ${issues.length} unlabelled issue(s), ${areaLabels.length} area labels available\n`);

  for (const issue of issues) {
    const ref = backReferenceTarget(issue.title);
    if (ref) {
      // Inherit rather than guess. If the parent has no area either, abstain.
      const parent = await gh(`/repos/${TARGET}/issues/${ref}`).catch(() => null);
      const parentArea = parent?.labels?.map((l) => l.name).find((n) => n.startsWith('area/'));
      const labels = parentArea ? [parentArea] : ['needs-triage'];
      console.log(`#${issue.number} → ${labels.join(', ')}  (back-reference to #${ref})`);
      if (!DRY_RUN) await addLabels(issue.number, labels);
      continue;
    }

    const verdict = await classify(areaLabels, issue).catch((e) => ({ area: null, confidence: 0, why: e.message }));
    const { labels } = decide(verdict, allowed);
    console.log(`#${issue.number} → ${labels.join(', ')}  (${(verdict.confidence ?? 0).toFixed(2)}) ${verdict.why || ''}`);
    if (!DRY_RUN) await addLabels(issue.number, labels);
  }

  if (DRY_RUN) console.log('\n(dry run — nothing was written)');
}

// ---------------------------------------------------------------- main

if (!GH_TOKEN) throw new Error('GITHUB_TOKEN is required');
if (!GROQ_KEY) throw new Error('GROQ_API_KEY is required');

await (EVAL_FILE ? runEval(EVAL_FILE) : runLive());
