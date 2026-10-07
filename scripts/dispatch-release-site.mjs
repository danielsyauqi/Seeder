const token = process.env.SEEDER_WEB_DISPATCH_TOKEN;
const repo = process.env.SEEDER_WEB_REPO;
const tag = process.env.RELEASE_TAG;

if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo || "")) {
  throw new Error("Landing page dispatch credentials are missing or invalid.");
}
if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) {
  throw new Error("Expected a vX.Y.Z release tag.");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "seeder-release-workflow",
  "X-GitHub-Api-Version": "2026-03-10",
};
let lastRequestAt = 0;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers.get("retry-after");
  const seconds = Number(retryAfter);
  const headerDelay = Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : retryAfter
      ? Math.max(0, Date.parse(retryAfter) - Date.now())
      : 0;
  return Math.max(2_000 * 2 ** attempt + Math.random() * 500, headerDelay);
}

async function github(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await delay(Math.max(0, 2_000 - (Date.now() - lastRequestAt)));
    lastRequestAt = Date.now();

    let response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(retryDelay(null, attempt));
      continue;
    }

    const quotaReached =
      response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after"));
    if (response.status === 429 || quotaReached || response.status >= 500) {
      if (attempt === 4) throw new Error(`GitHub API returned HTTP ${response.status}.`);
      await delay(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}.`);
    return response.json();
  }
  throw new Error("GitHub API request did not complete.");
}

const dispatch = await github(
  `/repos/${repo}/actions/workflows/deploy-release.yml/dispatches`,
  { method: "POST", body: JSON.stringify({ ref: "main", inputs: { tag } }) },
);
const runId = dispatch.workflow_run_id;
if (!Number.isInteger(runId)) {
  throw new Error("GitHub did not return the landing page workflow run ID.");
}

for (let attempt = 0; attempt < 40; attempt++) {
  await delay(attempt < 8 ? 15_000 : 30_000);
  const run = await github(`/repos/${repo}/actions/runs/${runId}`);
  if (run.status !== "completed") continue;
  if (run.conclusion !== "success") {
    throw new Error(`Landing page deployment finished with ${run.conclusion}.`);
  }
  console.log(`Landing page deployment completed for ${tag}.`);
  process.exit(0);
}

throw new Error("Landing page deployment did not finish within the wait window.");
