/**
 * File Scope parsing and validation helpers.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: function bodies are byte-identical to their
 * pre-extraction form. store.ts re-imports these helpers.
 *
 * FNXC:FileScopeClassification 2026-07-21-12:00:
 * isValidFileScopeEntry is owned by file-scope-classification.ts so create/update
 * validation and extractEffectiveWriteScopeFromPrompt cannot drift. Root-level
 * files with extensions (global.json, Directory.Packages.props, MyApp.slnx) must
 * pass both paths — GitHub issue bodies that declare them were failing import.
 */
export { isValidFileScopeEntry } from "../file-scope-classification.js";
import { isValidFileScopeEntry } from "../file-scope-classification.js";

export function extractFileScopeTokens(content: string): string[] {
  const headingMatch = content.match(/^##\s+File\s+Scope\s*$/m);

  if (!headingMatch) return [];

  const startIdx = headingMatch.index! + headingMatch[0].length;
  const rest = content.slice(startIdx);
  const nextHeading = rest.search(/\n##?\s/);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const tokens: string[] = [];
  const backtickRegex = /`([^`]+)`/g;
  let match;
  while ((match = backtickRegex.exec(section)) !== null) {
    tokens.push(match[1]);
  }

  return tokens;
}

export function validateFileScopeInPromptContent(prompt: string): { valid: string[]; invalid: string[] } {
  const tokens = extractFileScopeTokens(prompt);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (isValidFileScopeEntry(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

export function sanitizeFileScopeInPromptContent(prompt: string): { sanitized: string; dropped: string[]; kept: string[] } {
  const headingMatch = prompt.match(/^##\s+File\s+Scope\s*$/m);
  if (!headingMatch) {
    return { sanitized: prompt, dropped: [], kept: [] };
  }

  const startIdx = headingMatch.index! + headingMatch[0].length;
  const rest = prompt.slice(startIdx);
  const nextHeading = rest.search(/\n##?\s/);
  const endIdx = nextHeading === -1 ? prompt.length : startIdx + nextHeading;
  const section = prompt.slice(startIdx, endIdx);
  const { valid: kept, invalid: dropped } = validateFileScopeInPromptContent(prompt);
  if (dropped.length === 0) {
    return { sanitized: prompt, dropped, kept };
  }

  const sanitizedSection = section
    .split("\n")
    .filter((line) => {
      const tokens = Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1]);
      if (tokens.length === 0) return true;
      return tokens.every((token) => isValidFileScopeEntry(token));
    })
    .join("\n");

  return {
    sanitized: `${prompt.slice(0, startIdx)}${sanitizedSection}${prompt.slice(endIdx)}`,
    dropped,
    kept,
  };
}
