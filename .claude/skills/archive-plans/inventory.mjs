#!/usr/bin/env node
// Inventories docs/plans/archive/*.md: git-add date (oldest first) and any
// inbound links from outside docs/plans/archive/. Run with no args.
//
// Usage: node .claude/skills/archive-plans/inventory.mjs [--keep N]

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const archiveDir = path.join(repoRoot, "docs", "plans", "archive");

const keepArgIndex = process.argv.indexOf("--keep");
const keepCount =
  keepArgIndex !== -1 ? Number(process.argv[keepArgIndex + 1]) : 10;

const mdFiles = readdirSync(archiveDir).filter((f) => f.endsWith(".md"));

function firstAddDate(relPath) {
  const out = execFileSync(
    "git",
    [
      "log",
      "--diff-filter=A",
      "--follow",
      "--format=%aI",
      "--",
      relPath,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
  const lines = out.split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "1970-01-01T00:00:00Z";
}

const entries = mdFiles.map((f) => {
  const rel = path
    .join("docs", "plans", "archive", f)
    .split(path.sep)
    .join("/");
  return { file: f, rel, addedAt: firstAddDate(rel) };
});

entries.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1)); // newest first

// Find inbound links: grep the whole repo (excluding node_modules, vendor,
// dist, and the archive dir itself) for "docs/plans/archive/<file>".
function findBacklinks(fileName) {
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "--fixed-strings",
        `docs/plans/archive/${fileName}`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    ).trim();
  } catch {
    return []; // git grep exits 1 when there are no matches
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => !p.startsWith("docs/plans/archive/"))
    .filter((p) => !p.includes("/.package/") && !p.includes("release/"));
}

for (const e of entries) {
  e.backlinks = findBacklinks(e.file);
}

const keep = entries.slice(0, keepCount);
const candidates = entries.slice(keepCount);
const referencedCandidates = candidates.filter((e) => e.backlinks.length);
const plainCandidates = candidates.filter((e) => !e.backlinks.length);

console.log(
  JSON.stringify(
    {
      totalArchived: entries.length,
      keepCount,
      keep: keep.map((e) => e.file),
      candidatesToZip: plainCandidates.map((e) => e.file),
      candidatesNeedingExtraction: referencedCandidates.map((e) => ({
        file: e.file,
        backlinks: e.backlinks,
      })),
    },
    null,
    2,
  ),
);
