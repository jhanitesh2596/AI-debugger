import { Ollama } from "ollama";
import {
  applyUnifiedDiff,
  commitPush,
  createBranch,
  getLocalRepoPath,
  isLocalRepoAvailable,
} from "./services/gitService.js";
import dotenv from "dotenv";
dotenv.config();

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST,
  headers: {
    Authorization: `Bearer ${process.env.OLLAMA_AUTH_TOKEN}`,
  },
});

const MODEL = process.env.OLLAMA_MODEL || "gpt-oss:20b";

function messageText(msg) {
  const m = msg || {};
  return (
    (m.content && String(m.content).trim()) ||
    (m.thinking && String(m.thinking).trim()) ||
    ""
  );
}

function stripMarkdownFences(text) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z0-9]*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  return t.trim();
}

/**
 * Combines GitHub debug findings with an optional local patch workflow.
 */
export async function analyze(issue, code) {
  const diagnosisBlock = `*Diagnosis (from repo inspection)*\n${code}`;

  try {
    const response = await ollama.chat({
      model: MODEL,

      messages: [
        {
          role: "system",

          content: `You are a senior debugging engineer.

Return ONLY a valid unified git diff patch (begin with "diff --git").

Rules:
• Output ONLY the git diff — no markdown fences, no explanation before or after the diff
• Minimal fix only; modify only necessary lines
• If you cannot produce a patch, return a single line: NO_PATCH

Issue:
${issue}

Context from repository investigation:
${code}
`,
        },
      ],

      stream: false,
      options: { temperature: 0.2 },
    });

    const raw = messageText(response.message);
    const cleaned = stripMarkdownFences(raw);
    const diff = cleaned.includes("NO_PATCH") ? "" : cleaned;

    if (!diff || !diff.includes("diff --git")) {
      return `${diagnosisBlock}\n\n*Suggested patch:* Model did not return an applyable diff. Fix manually or retry.`;
    }

    if (!isLocalRepoAvailable()) {
      const hint = getLocalRepoPath();
      return `${diagnosisBlock}\n\n*Suggested patch:*\n\`\`\`\n${diff}\n\`\`\`\n\n_To auto-apply and push, clone your repo to \`${hint}\` or set \`LOCAL_REPO_PATH\` in \`.env\`._`;
    }

    const branch = createBranch();
    if (!branch) {
      return `${diagnosisBlock}\n\n*Suggested patch:*\n\`\`\`\n${diff}\n\`\`\`\n\n_Local clone missing or not a git repo._`;
    }

    const applied = applyUnifiedDiff(diff);
    if (!applied) {
      return `${diagnosisBlock}\n\n*Suggested patch (apply failed — try manually):*\n\`\`\`\n${diff}\n\`\`\``;
    }

    const pushed = commitPush(branch);
    if (!pushed) {
      return `${diagnosisBlock}\n\nPatch applied locally on branch \`${branch}\` but nothing was committed (check git state).`;
    }

    return `${diagnosisBlock}\n\nPatch applied and pushed on branch \`${branch}\`. Open GitHub and create a pull request from that branch.`;
  } catch (err) {
    console.log("AI pipeline failed:", err);

    return `${diagnosisBlock}\n\n*Patch step failed:* ${err.message}`;
  }
}
