import { Octokit } from "@octokit/rest";
import { Ollama } from "ollama";
import dotenv from "dotenv";
dotenv.config();

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;

const github = new Octokit({
  auth: process.env.GITHUB_OCTOKIT_TOKEN,
});

// const searchRepo = async (query) => {
//   const q = `${query} repo:${OWNER}/${REPO}`;

//   const res = await github.search.code({
//     q,
//     per_page: 10,
//   });

//   console.log(res)

//   return res.data?.url
// }

// async function readFile(path) {
//   const res = await github.repos.getContent({
//     owner: OWNER,
//     repo: REPO,
//     path,
//   });

//   if (!("content" in res.data)) {
//     throw new Error("Not a file");
//   }

//   const content = Buffer.from(res.data.content, "base64").toString("utf8");

//   return {
//     path,
//     content,
//   };
// }

// async function runDebugger(issue) {
//   console.log("Issue:", issue);

//   // Example manual flow:
//   const file = await searchRepo(issue);
//   console.log("Relevant Files:", file);

//   if (file) {
//     const file = await readFile(file);
//     console.log("File Content:", file.content.slice(0, 300));
//   }
//   console.log("Recent Commits:", recent);
// }

// export async function createPR(branch) {
//   const pr = await octokit.pulls.create({
//     owner: process.env.GITHUB_OWNER,
//     repo: process.env.GITHUB_REPO,

//     title: "AI Fix: Bug detected",

//     head: branch,

//     base: "main",

//     body: "AI generated fix",
//   });

//   return pr.data.html_url;
// }

// export {
//   runDebugger
// }

/**
 * Autonomous GitHub Debug Agent (Node.js + Ollama + GitHub)
 *
 * npm i @octokit/rest axios
 *
 * ENV:
 * GITHUB_TOKEN=xxxx
 *
 * Runs:
 * node agent.js
 */

/* =====================================================
   OLLAMA CONFIG
===================================================== */

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL = "gpt-oss:20b";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "List files/folders in repository path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read repository file content",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchCode",
      description:
        "Search for text, symbols, or identifiers inside file contents (GitHub code search). Returns matching file paths—then use readFile on them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recentCommits",
      description: "Get latest repository commits",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

/* =====================================================
   TOOLS
===================================================== */

async function listFiles(path = "") {
  const res = await github.repos.getContent({
    owner: OWNER,
    repo: REPO,
    path,
  });

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

async function getTreeBlobPaths() {
  const tree = await github.git.getTree({
    owner: OWNER,
    repo: REPO,
    tree_sha: "HEAD",
    recursive: "true",
  });

  return tree.data.tree
    .filter((x) => x.type === "blob")
    .map((x) => x.path)
    .filter(isScannableSourcePath);
}

async function searchCodePathFallback(query) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const files = await getTreeBlobPaths();

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
async function searchCodeByScanningFiles(query) {
  const trimmed = query.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || !OWNER || !REPO) {
    return [];
  }

  const paths = await getTreeBlobPaths();
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
          const text = await readFile(path);
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
async function searchCode(query) {
  const trimmed = query.trim();
  if (!trimmed || !OWNER || !REPO) {
    return [];
  }

  const repoScope = `repo:${OWNER}/${REPO}`;
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

  const scanned = await searchCodeByScanningFiles(trimmed);
  if (scanned.length) {
    return scanned;
  }

  return searchCodePathFallback(trimmed);
}

async function readFile(path) {
  const res = await github.repos.getContent({
    owner: OWNER,
    repo: REPO,
    path,
  });

  if (!("content" in res.data)) return "Not a file";

  return Buffer.from(res.data.content, "base64").toString("utf8");
}

async function recentCommits() {
  const res = await github.repos.listCommits({
    owner: OWNER,
    repo: REPO,
    per_page: 5,
  });

  return res.data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
  }));
}

/* =====================================================
   OLLAMA CALL
===================================================== */

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST,
  headers: {
    Authorization: `Bearer ${process.env.OLLAMA_AUTH_TOKEN}`,
  },
});

async function askLLM(messages, enableTools = true) {
  try {
    const payload = {
      model: MODEL,
      messages,
      stream: false,
      options: {
        temperature: 0.2,
      },
    };

    if (enableTools) {
      payload.tools = TOOLS;
    } else {
      // Prefer user-visible `content` on the final turn (reasoning models otherwise leave it empty).
      payload.think = false;
    }

    const res = await ollama.chat(payload);

    const msg = res.message || {};
    // Reasoning models (e.g. gpt-oss) often return empty `content` and put text in `thinking`.
    const text =
      (msg.content && String(msg.content).trim()) ||
      (msg.thinking && String(msg.thinking).trim()) ||
      "";

    return {
      role: msg.role || "assistant",
      content: text,
      tool_calls: msg.tool_calls || [],
    };
  } catch (error) {
    console.error("askLLM error:", error.message);

    return {
      role: "assistant",
      content: "Model request failed.",
      tool_calls: [],
    };
  }
}

/* =====================================================
   TOOL EXECUTOR
===================================================== */

async function runTool(action, args) {
  switch (action) {
    case "listFiles":
      return await listFiles(args.path || "");

    case "searchCode":
      return await searchCode(args.query);

    case "readFile": {
      const p = args.path;
      const text = await readFile(p);
      if (text === "Not a file") {
        return { path: p, error: "Not a file or directory" };
      }
      return { path: p, content: text };
    }

    case "recentCommits":
      return await recentCommits();

    default:
      return "Unknown tool";
  }
}

function looksLikeStructuredDiagnosis(text) {
  return /root\s*cause\s*:/i.test(text) && /evidence\s*:/i.test(text);
}

/**
 * Summarize tool outputs so the final LLM cannot claim "no evidence" when tools already returned paths/code.
 */
function buildGroundTruthFromHistory(history) {
  const searchHits = new Set();
  const readFiles = [];
  const errors = [];

  for (const m of history) {
    if (m.role !== "tool") {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }

    if (parsed?.path && typeof parsed.content === "string") {
      const snippet = parsed.content.replace(/\s+/g, " ").slice(0, 280);
      readFiles.push(
        `${parsed.path} (read ${parsed.content.length} chars): …${snippet}…`,
      );
      continue;
    }

    if (parsed?.path && parsed?.error) {
      errors.push(`${parsed.path}: ${parsed.error}`);
      continue;
    }

    if (Array.isArray(parsed) && parsed[0]) {
      const first = parsed[0];
      // searchCode: [{ path: "..." }] only — listFiles always includes name + type
      if (first.path && !first.name && !first.sha) {
        for (const item of parsed) {
          if (item.path) {
            searchHits.add(item.path);
          }
        }
        continue;
      }
    }
  }

  const lines = [];
  if (searchHits.size) {
    lines.push(
      `Files matched by searchCode (GitHub indexed content): ${[...searchHits].join(", ")}`,
    );
  }
  if (readFiles.length) {
    lines.push("Files read via readFile:");
    lines.push(...readFiles);
  }
  if (errors.length) {
    lines.push(`Tool errors: ${errors.join("; ")}`);
  }

  if (!lines.length) {
    return "No search hits or file reads were recorded in this session.";
  }

  return lines.join("\n");
}

/* =====================================================
   DEBUG LOOP
===================================================== */

async function debugIssue(issue) {
  const MAX_STEPS = 8;
  const seenCalls = new Set();

  const history = [
    {
      role: "system",
      content: `
You are a senior software debugging agent.

Goal:
Find likely cause of bugs in GitHub repositories quickly.

Available tools:
- searchCode(query)
- readFile(path)
- listFiles(path)
- recentCommits()

Rules:
1. Prefer searchCode first to find symbols or strings in source files.
2. After searchCode returns paths, call readFile on the most relevant file(s)—you must read source before diagnosing.
3. Do not repeat same tool calls.
4. Max 8 tool rounds.
5. If uncertain, still provide best likely diagnosis.
6. Do not reply with plans or narration alone—call tools until you have read relevant files.
7. Your Evidence must match tool results. Never claim "no evidence" or "symbol not found" if searchCode or readFile already returned that symbol or file.
8. Final answer format (only after you have used tools or the repo is empty):

Root Cause:
Evidence:
Fix:
Confidence:
`,
    },
    {
      role: "user",
      content: issue,
    },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`\nSTEP ${step + 1}`);

    const res = await askLLM(history, true);

    console.log("MODEL:", res);

    /**
     * Final answer directly — only after tools ran or the model already used the required format.
     * Otherwise gpt-oss often returns a "plan" in natural language and never calls tools.
     */
    if (!res.tool_calls?.length && res.content?.trim()) {
      const hasToolEvidence = history.some((m) => m.role === "tool");
      if (hasToolEvidence || looksLikeStructuredDiagnosis(res.content)) {
        return res.content;
      }
      history.push({
        role: "assistant",
        content: res.content,
      });
      history.push({
        role: "user",
        content: `You must call the repository tools now (searchCode, readFile, listFiles, or recentCommits) with real arguments. Do not describe what you will do—invoke a tool immediately.`,
      });
      continue;
    }

    /**
     * Tool calling mode
     */
    if (res.tool_calls?.length) {
      history.push({
        role: "assistant",
        content: res.content || "",
        tool_calls: res.tool_calls,
      });

      let repeated = true;

      for (const call of res.tool_calls) {
        const toolName = call.function.name;

        const args =
          typeof call.function.arguments === "string"
            ? JSON.parse(call.function.arguments)
            : call.function.arguments || {};

        const signature = `${toolName}:${JSON.stringify(args)}`;

        if (!seenCalls.has(signature)) {
          repeated = false;
        }

        seenCalls.add(signature);

        console.log("TOOL:", toolName, args);

        let result;

        try {
          result = await runTool(toolName, args);
        } catch (err) {
          result = { error: err.message };
        }

        history.push({
          role: "tool",
          content: JSON.stringify(result).slice(0, 12000),
        });
      }

      /**
       * If repeating same calls, stop exploring
       */
      if (repeated) {
        break;
      }

      continue;
    }

    break;
  }

  /**
   * Forced Final Answer (TOOLS DISABLED)
   */
  const groundTruth = buildGroundTruthFromHistory(history);

  const final = await askLLM(
    [
      ...history,
      {
        role: "user",
        content: `
GROUND TRUTH FROM TOOLS (must appear in Evidence; do not contradict):
${groundTruth}

No more tool calls allowed.

Based on the issue and the evidence above, give your BEST final diagnosis.

Use format:

Root Cause:
Evidence:
Fix:
Confidence:
`,
      },
    ],
    false,
  );

  return final.content || "Unable to determine confidently.";
}

export { debugIssue };
