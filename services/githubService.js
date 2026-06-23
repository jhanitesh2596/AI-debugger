import { Octokit } from "@octokit/rest";
import dotenv from "dotenv";
dotenv.config();

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const envValue = (name) => (process.env[name] || "").trim();
const GITHUB_TOKEN =
  envValue("GITHUB_TOKEN") || envValue("GITHUB_OCTOKIT_TOKEN") || "";

const github = new Octokit({
  auth: GITHUB_TOKEN || undefined,
});

const repoInfoPromises = new Map();
const defaultTreeShaPromises = new Map();

function defaultTargetRepo() {
  return {
    owner: OWNER,
    repo: REPO,
  };
}

function repoKey(target = defaultTargetRepo()) {
  return `${target.owner || ""}/${target.repo || ""}`;
}

function normalizeSlackLink(value = "") {
  const text = String(value).trim();
  const match = text.match(/^<([^>|]+)(?:\|[^>]+)?>$/);
  return match ? match[1] : text;
}

function parseGitHubUrl(value = "") {
  const normalized = normalizeSlackLink(value);

  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    const refType = parts[2];
    const ref = parts[3];
    const path = ["blob", "tree"].includes(refType)
      ? parts.slice(4).join("/")
      : "";

    return {
      owner: parts[0],
      repo: parts[1],
      refType,
      ref,
      path,
    };
  } catch {
    return null;
  }
}

export function targetRepoFromIssue(issue) {
  const urlMatches = String(issue).match(/https:\/\/github\.com\/[^\s>|)]+/g);

  for (const url of urlMatches || []) {
    const parsed = parseGitHubUrl(url);
    if (parsed?.owner && parsed?.repo) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
      };
    }
  }

  return defaultTargetRepo();
}

export function fileLinksFromIssue(issue) {
  const urlMatches = String(issue).match(/https:\/\/github\.com\/[^\s>|)]+/g);
  const seen = new Set();
  const files = [];

  for (const url of urlMatches || []) {
    const parsed = parseGitHubUrl(url);
    if (parsed?.refType !== "blob" || !parsed.path) {
      continue;
    }

    const key = `${parsed.owner}/${parsed.repo}/${parsed.path}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    files.push({
      owner: parsed.owner,
      repo: parsed.repo,
      path: parsed.path,
    });
  }

  return files;
}

function pathFromGitHubInput(value) {
  const parsed = parseGitHubUrl(value);
  if (parsed?.path) {
    return parsed.path;
  }

  return normalizeSlackLink(value).replace(/^\/+/, "");
}

function githubAccessError(operation, err, target = defaultTargetRepo()) {
  const status = err.status || err.response?.status;

  if (!target.owner || !target.repo) {
    return new Error(
      `GitHub ${operation} failed: set GITHUB_OWNER and GITHUB_REPO.`,
    );
  }

  if (status === 401) {
    return new Error(
      `GitHub ${operation} failed: token is invalid or expired. Set GITHUB_OCTOKIT_TOKEN or GITHUB_TOKEN.`,
    );
  }

  if (status === 403) {
    return new Error(
      `GitHub ${operation} failed: token lacks permission or hit a rate limit. For private repos, use a token with repository contents access.`,
    );
  }

  if (status === 404) {
    const tokenHint = GITHUB_TOKEN
      ? "The repository was not found or the token does not have access."
      : "The repository may be private. Set GITHUB_OCTOKIT_TOKEN or GITHUB_TOKEN with access to it.";

    return new Error(`GitHub ${operation} failed: ${tokenHint}`);
  }

  return new Error(`GitHub ${operation} failed: ${err.message}`);
}

async function withGitHubAccess(operation, target, request) {
  try {
    return await request();
  } catch (err) {
    throw githubAccessError(operation, err, target);
  }
}

async function getRepoInfo(target = defaultTargetRepo()) {
  const key = repoKey(target);

  if (!repoInfoPromises.has(key)) {
    repoInfoPromises.set(
      key,
      withGitHubAccess("repository lookup", target, () =>
        github.repos.get({
          owner: target.owner,
          repo: target.repo,
        }),
      ),
    );
  }

  const res = await repoInfoPromises.get(key);
  return res.data;
}

async function getDefaultTreeSha(target = defaultTargetRepo()) {
  const key = repoKey(target);

  if (!defaultTreeShaPromises.has(key)) {
    defaultTreeShaPromises.set(
      key,
      (async () => {
        const repo = await getRepoInfo(target);
        const branch = repo.default_branch;

        const ref = await withGitHubAccess("default branch lookup", target, () =>
          github.git.getRef({
            owner: target.owner,
            repo: target.repo,
            ref: `heads/${branch}`,
          }),
        );

        const commit = await withGitHubAccess(
          "default branch commit lookup",
          target,
          () =>
            github.git.getCommit({
              owner: target.owner,
              repo: target.repo,
              commit_sha: ref.data.object.sha,
            }),
        );

        return commit.data.tree.sha;
      })(),
    );
  }

  return defaultTreeShaPromises.get(key);
}

/* =====================================================
   GITHUB TOOLS
===================================================== */

async function listFiles(path = "", target = defaultTargetRepo()) {
  const cleanPath = pathFromGitHubInput(path);
  const res = await withGitHubAccess("list files", target, () =>
    github.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path: cleanPath,
    }),
  );

  if (!Array.isArray(res.data)) return [];

  return res.data.map((x) => ({
    name: x.name,
    path: x.path,
    type: x.type,
  }));
}

const SOURCE_FILE_RE = /\.(tsx?|jsx?|mjs|cjs|vue|svelte)$/i;

const SKIP_PATH_SUBSTR = [
  "node_modules/",
  "/dist/",
  "/build/",
  "/.next/",
  "coverage/",
  "/vendor/",
  ".min.js",
];

function isScannableSourcePath(p) {
  if (!SOURCE_FILE_RE.test(p)) {
    return false;
  }
  const lower = p.toLowerCase();
  return !SKIP_PATH_SUBSTR.some((s) => lower.includes(s));
}

async function getTreeBlobPaths(target = defaultTargetRepo()) {
  const treeSha = await getDefaultTreeSha(target);
  const tree = await withGitHubAccess("repository tree lookup", target, () =>
    github.git.getTree({
      owner: target.owner,
      repo: target.repo,
      tree_sha: treeSha,
      recursive: "true",
    }),
  );

  return tree.data.tree
    .filter((x) => x.type === "blob")
    .map((x) => x.path)
    .filter(isScannableSourcePath);
}

async function searchCodePathFallback(query, target = defaultTargetRepo()) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const files = await getTreeBlobPaths(target);

  if (!terms.length) {
    return files.slice(0, 10).map((path) => ({ path }));
  }

  return files
    .filter((p) => terms.some((term) => p.toLowerCase().includes(term)))
    .slice(0, 10)
    .map((path) => ({ path }));
}

/**
 * GitHub /search/code is best-effort only (indexing, qualifiers, org settings). This scans
 * file contents via the Contents API so symbols like handleKeyPress are actually found.
 */
async function searchCodeByScanningFiles(query, target = defaultTargetRepo()) {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || !target.owner || !target.repo) {
    return [];
  }

  const paths = await getTreeBlobPaths(target);
  const maxFilesToScan = 400;
  const maxHits = 30;
  const batchSize = 6;
  const hits = [];
  const seen = new Set();

  const slice = paths.slice(0, maxFilesToScan);

  for (let i = 0; i < slice.length && hits.length < maxHits; i += batchSize) {
    const batch = slice.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          const text = await readFile(path, target);
          if (text === "Not a file" || typeof text !== "string") {
            return null;
          }
          if (text.includes(trimmed) || text.toLowerCase().includes(lower)) {
            return path;
          }
        } catch (err) {
          console.error("readFile in scan:", path, err.message);
        }
        return null;
      }),
    );

    for (const path of results) {
      if (path && !seen.has(path)) {
        seen.add(path);
        hits.push({ path });
      }
    }
  }

  if (hits.length) {
    console.log(
      `searchCode: blob scan found ${hits.length} file(s) for "${trimmed}"`,
    );
  }

  return hits;
}

/**
 * GitHub code search API + blob scan fallback + path-only fallback.
 */
async function searchCode(query, target = defaultTargetRepo()) {
  const trimmed = query.trim();
  if (!trimmed || !target.owner || !target.repo) {
    return [];
  }

  const parsed = parseGitHubUrl(trimmed);
  if (parsed?.path) {
    return [{ path: parsed.path }];
  }

  const repoScope = `repo:${target.owner}/${target.repo}`;
  // Simplest queries first — overly strict qualifiers often return 0 hits.
  const queries = [
    `${trimmed} ${repoScope}`,
    `${trimmed} in:file ${repoScope}`,
    `"${trimmed}" ${repoScope}`,
    `${trimmed} language:TypeScript ${repoScope}`,
    `${trimmed} extension:tsx ${repoScope}`,
  ];

  const seen = new Set();
  const out = [];

  for (const q of queries) {
    try {
      const res = await github.search.code({
        q,
        per_page: 30,
      });

      for (const item of res.data.items || []) {
        if (item.path && !seen.has(item.path)) {
          seen.add(item.path);
          out.push({ path: item.path });
        }
      }
    } catch (err) {
      console.error("search.code failed:", q, err.message);
    }

    if (out.length >= 25) {
      break;
    }
  }

  if (out.length) {
    console.log(
      `searchCode: GitHub API returned ${out.length} path(s) for "${trimmed}"`,
    );
    return out.slice(0, 30);
  }

  console.warn(
    `searchCode: GitHub /search/code returned 0 for "${trimmed}" — scanning repository files`,
  );

  const scanned = await searchCodeByScanningFiles(trimmed, target);
  if (scanned.length) {
    return scanned;
  }

  return searchCodePathFallback(trimmed, target);
}

export async function readFile(path, target = defaultTargetRepo()) {
  const cleanPath = pathFromGitHubInput(path);
  const res = await withGitHubAccess("read file", target, () =>
    github.repos.getContent({
      owner: target.owner,
      repo: target.repo,
      path: cleanPath,
    }),
  );

  if (!("content" in res.data)) return "Not a file";

  return Buffer.from(res.data.content, "base64").toString("utf8");
}

async function recentCommits(target = defaultTargetRepo()) {
  const res = await withGitHubAccess("recent commits lookup", target, () =>
    github.repos.listCommits({
      owner: target.owner,
      repo: target.repo,
      per_page: 5,
    }),
  );

  return res.data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
  }));
}

/* =====================================================
   TOOL EXECUTOR
===================================================== */

export async function runTool(action, args, target = defaultTargetRepo()) {
  switch (action) {
    case "listFiles":
      return await listFiles(args.path || "", target);

    case "searchCode":
      return await searchCode(args.query, target);

    case "readFile": {
      const p = args.path;
      const text = await readFile(p, target);
      if (text === "Not a file") {
        return { path: p, error: "Not a file or directory" };
      }
      return { path: pathFromGitHubInput(p), content: text };
    }

    case "recentCommits":
      return await recentCommits(target);

    default:
      return "Unknown tool";
  }
}
