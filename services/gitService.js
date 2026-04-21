import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveRepoPath() {
  const fromEnv = process.env.LOCAL_REPO_PATH;
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve(__dirname, "../../repo/word-game-FE");
}

export function isLocalRepoAvailable() {
  const repo = resolveRepoPath();
  return fs.existsSync(path.join(repo, ".git"));
}

export function getLocalRepoPath() {
  return resolveRepoPath();
}

/**
 * @returns {string | null} branch name, or null if no local clone
 */
export function createBranch() {
  const REPO = resolveRepoPath();
  if (!fs.existsSync(path.join(REPO, ".git"))) {
    return null;
  }

  const branch = "ai-fix-" + Date.now();

  execSync(`git -C "${REPO}" checkout -b ${branch}`);

  return branch;
}

/**
 * Write unified diff and apply it in the repo.
 * @returns {boolean}
 */
export function applyUnifiedDiff(diffText) {
  const REPO = resolveRepoPath();
  if (!fs.existsSync(path.join(REPO, ".git"))) {
    return false;
  }

  const trimmed = diffText.trim();
  if (!trimmed || !trimmed.includes("diff --git")) {
    return false;
  }

  const patchFile = path.join(REPO, `.ai-patch-${Date.now()}.diff`);

  try {
    fs.writeFileSync(patchFile, trimmed, "utf8");
    execSync(`git -C "${REPO}" apply --whitespace=nowarn "${patchFile}"`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (err) {
    console.error("git apply failed:", err.message);
    return false;
  } finally {
    try {
      fs.unlinkSync(patchFile);
    } catch {
      /* ignore */
    }
  }
}

export function commitPush(branch) {
  const REPO = resolveRepoPath();

  if (!fs.existsSync(path.join(REPO, ".git"))) {
    return false;
  }

  const status = execSync(`git -C "${REPO}" status --porcelain`).toString();

  if (!status) {
    console.log("No changes");

    return false;
  }

  execSync(`git -C "${REPO}" add .`);

  execSync(`git -C "${REPO}" commit -m "AI bug fix"`);

  execSync(`git -C "${REPO}" push origin ${branch}`);

  return true;
}
