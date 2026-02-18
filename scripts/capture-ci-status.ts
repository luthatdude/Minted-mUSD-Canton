import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

type WorkflowRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
};

function getRepo(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    const m = remote.match(/github\.com[:/](.+\/.+?)(?:\.git)?$/);
    if (m?.[1]) return m[1];
  } catch {
    // Ignore and use default below.
  }
  return "luthatdude/Minted-mUSD-Canton";
}

function getBranch(): string {
  if (process.env.CI_BRANCH) return process.env.CI_BRANCH;
  return execSync("git branch --show-current", { encoding: "utf8" }).trim();
}

async function main() {
  const repo = getRepo();
  const branch = getBranch();
  const workflowName = process.env.CI_WORKFLOW_NAME || "CI";
  const maxRuns = Number(process.env.CI_MAX_RUNS || "20");

  const url = `https://api.github.com/repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${maxRuns}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "minted-ci-status-capture",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { workflow_runs: WorkflowRun[] };
  const runs = payload.workflow_runs || [];
  const run = runs.find((r) => r.name === workflowName) || runs[0];

  if (!run) {
    throw new Error(`No workflow runs found for branch ${branch} in ${repo}`);
  }

  const outDir = path.resolve(process.cwd(), "artifacts/test-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = process.env.OUTPUT_FILE
    ? path.resolve(process.cwd(), process.env.OUTPUT_FILE)
    : path.join(outDir, "ci-latest-status.log");

  const lines = [
    `timestamp=${new Date().toISOString()}`,
    `repo=${repo}`,
    `branch=${branch}`,
    `workflow=${run.name}`,
    `run_id=${run.id}`,
    `status=${run.status}`,
    `conclusion=${run.conclusion ?? "null"}`,
    `head_sha=${run.head_sha}`,
    `created_at=${run.created_at}`,
    `updated_at=${run.updated_at}`,
    `run_url=${run.html_url}`,
    `status_gate=${run.conclusion === "success" ? "PASS" : "FAIL"}`,
  ];

  fs.writeFileSync(outFile, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote CI status evidence: ${outFile}`);

  if (process.env.ALLOW_NON_GREEN !== "true" && run.conclusion !== "success") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
