import { Ollama } from "ollama";
import dotenv from "dotenv";
import {
  fileLinksFromIssue,
  readFile,
  runTool,
  targetRepoFromIssue,
} from "./githubService.js";

dotenv.config();

const MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";
const MAX_STEPS = 8;

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
        "Search for text, symbols, or identifiers inside file contents. Returns matching file paths; then use readFile on them.",
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
      payload.think = false;
    }

    const res = await ollama.chat(payload);
    const msg = res.message || {};
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

function looksLikeStructuredDiagnosis(text) {
  return /root\s*cause\s*:/i.test(text) && /evidence\s*:/i.test(text);
}

function looksLikeNoAccessAnswer(text) {
  return /don['’]?t have access|cannot access|can['’]?t read|share the contents/i.test(
    text,
  );
}

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
        `${parsed.path} (read ${parsed.content.length} chars): ...${snippet}...`,
      );
      continue;
    }

    if (parsed?.path && parsed?.error) {
      errors.push(`${parsed.path}: ${parsed.error}`);
      continue;
    }

    if (Array.isArray(parsed) && parsed[0]?.path && !parsed[0].name) {
      for (const item of parsed) {
        if (item.path) {
          searchHits.add(item.path);
        }
      }
    }
  }

  const lines = [];
  if (searchHits.size) {
    lines.push(`Files matched by searchCode: ${[...searchHits].join(", ")}`);
  }
  if (readFiles.length) {
    lines.push("Files read via readFile:");
    lines.push(...readFiles);
  }
  if (errors.length) {
    lines.push(`Tool errors: ${errors.join("; ")}`);
  }

  return lines.length
    ? lines.join("\n")
    : "No search hits or file reads were recorded in this session.";
}

function systemPrompt(target) {
  return `
You are a senior software debugging agent.

Goal:
Find likely cause of bugs or explain repository files/functions using real GitHub evidence.

Target repository:
${target.owner || "(missing owner)"}/${target.repo || "(missing repo)"}

Available tools:
- searchCode(query)
- readFile(path)
- listFiles(path)
- recentCommits()

Rules:
1. Prefer searchCode first to find symbols or strings in source files.
2. After searchCode returns paths, call readFile on the most relevant file(s).
3. Do not repeat same tool calls.
4. Max ${MAX_STEPS} tool rounds.
5. Do not claim missing evidence if searchCode or readFile already returned it.
6. For error/debug requests, answer with Root Cause, Evidence, Fix, Confidence.
7. For file/function info requests, answer with Summary, Files/Functions, Details, Confidence.
`;
}

async function preReadLinkedFiles(issue) {
  const evidence = [];

  for (const file of fileLinksFromIssue(issue)) {
    try {
      const content = await readFile(file.path, {
        owner: file.owner,
        repo: file.repo,
      });
      evidence.push(
        `FILE ${file.owner}/${file.repo}/${file.path}\n${content.slice(0, 12000)}`,
      );
    } catch (err) {
      evidence.push(
        `FILE ${file.owner}/${file.repo}/${file.path}\nERROR: ${err.message}`,
      );
    }
  }

  return evidence;
}

export async function debugIssue(issue) {
  const seenCalls = new Set();
  const target = targetRepoFromIssue(issue);
  const preReadEvidence = await preReadLinkedFiles(issue);

  const history = [
    { role: "system", content: systemPrompt(target) },
    { role: "user", content: issue },
  ];

  if (preReadEvidence.length) {
    history.push({
      role: "user",
      content: `Pre-read repository evidence from GitHub links in the user request:

${preReadEvidence.join("\n\n")}

Use this evidence directly. Do not say you lack access if file content or a concrete GitHub error is present.`,
    });
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    console.log(`\nSTEP ${step + 1}`);

    const res = await askLLM(history, true);
    console.log("MODEL:", res);

    if (!res.tool_calls?.length && res.content?.trim()) {
      const hasToolEvidence = history.some((m) => m.role === "tool");
      const hasRepoEvidence = hasToolEvidence || preReadEvidence.length > 0;

      if (hasRepoEvidence && looksLikeNoAccessAnswer(res.content)) {
        history.push({ role: "assistant", content: res.content });
        history.push({
          role: "user",
          content:
            "You already have repository evidence. Give the final answer from that evidence. If there was a GitHub error, report the exact error.",
        });
        continue;
      }

      if (hasToolEvidence || looksLikeStructuredDiagnosis(res.content)) {
        return res.content;
      }

      history.push({ role: "assistant", content: res.content });
      history.push({
        role: "user",
        content:
          "You must call the repository tools now with real arguments. Do not describe what you will do; invoke a tool immediately.",
      });
      continue;
    }

    if (!res.tool_calls?.length) {
      break;
    }

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
        result = await runTool(toolName, args, target);
      } catch (err) {
        result = { error: err.message };
      }

      history.push({
        role: "tool",
        content: JSON.stringify(result).slice(0, 12000),
      });
    }

    if (repeated) {
      break;
    }
  }

  const final = await askLLM(
    [
      ...history,
      {
        role: "user",
        content: `
GROUND TRUTH FROM TOOLS:
${buildGroundTruthFromHistory(history)}

No more tool calls allowed. Give your best final answer from the evidence.
`,
      },
    ],
    false,
  );

  return final.content || "Unable to determine confidently.";
}
