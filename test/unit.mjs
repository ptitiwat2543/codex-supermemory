/**
 * Unit tests for codex-supermemory using Node's built-in test runner.
 * Run with: node --test test/unit.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import * as TOML from "@iarna/toml";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = join(tmpdir(), `csm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A child process that keeps the real HOME writes to ~/.codex-supermemory.log and can read the
// user's real key, so this suite never hands its own HOME on: every spawn that passes no env, or
// spreads process.env, inherits this throwaway one.
const SUITE_HOME = makeTmpDir();
process.on("exit", () => rmSync(SUITE_HOME, { recursive: true, force: true }));
process.env.HOME = SUITE_HOME;
process.env.USERPROFILE = SUITE_HOME;

// Set up a fake $HOME with an empty .codex/ subdir. Registers an `after` hook
// on `t` that nukes the temp dir even if the test throws, so failed assertions
// don't leak directories under /tmp.
function setupCodexHome(t) {
  const tmpDir = makeTmpDir();
  const codexDir = join(tmpDir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const configPath = join(codexDir, "config.toml");
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  return { tmpDir, codexDir, configPath };
}

// Each test gets its own HOME, so state one test leaves (a recall cooldown, say) never reaches the next.
function isolatedEnv(t, extra) {
  const { tmpDir } = setupCodexHome(t);
  return { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, ...extra };
}

function runCli(cliBin, cmd, tmpDir) {
  return spawnSync("node", [cliBin, cmd], {
    env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "sm_test" },
    encoding: "utf-8",
  });
}

function readToml(path) {
  return TOML.parse(readFileSync(path, "utf-8"));
}

function hash16(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function matchesHookCommand(command, script) {
  if (command === `node ${script}`) return true;

  const encoded = /^node -e "require\(Buffer\.from\('([A-Za-z0-9+/]+={0,2})','base64'\)\.toString\('utf-8'\)\)"$/.exec(command);
  if (!encoded || Buffer.from(encoded[1], "base64").toString("base64") !== encoded[1]) {
    return false;
  }
  return Buffer.from(encoded[1], "base64").toString("utf-8") === script;
}

function readGeneratedPetPng(path) {
  const png = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(data);
    }
    offset += 12 + length;
  }

  const scanlines = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      assert.equal(scanlines[y * stride], 0, "generated pet PNG must use filter 0");
      return [...scanlines.subarray(y * stride + 1 + x * 4, y * stride + 1 + x * 4 + 4)];
    },
  };
}

// Inline the stripPrivateContent logic (mirrors src/services/privacy.ts exactly)
function stripPrivateContent(s) {
  return s.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED]");
}

// ─── container tags ─────────────────────────────────────────────────────────

describe("container tags", () => {
  const tagsModule = new URL("../dist/services/tags.js", import.meta.url).href;

  function runGit(args, cwd) {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`
    );
    return result.stdout.trim();
  }

  function getPersonalTagFor(cwd, home, extraEnv = {}) {
    const script = `
      import { getPersonalTag } from ${JSON.stringify(tagsModule)};
      console.log(getPersonalTag(process.argv.at(-1)));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, cwd], {
      env: {
        ...process.env,
        HOME: home,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
        ...extraEnv,
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, `getPersonalTag failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  function runWithFakeGit(script, cwd, home, t) {
    const preloadPath = join(home, "fake-git-preload.cjs");
    writeFileSync(preloadPath, `
      const childProcess = require("node:child_process");
      const { syncBuiltinESMExports } = require("node:module");
      const originalExecSync = childProcess.execSync;
      childProcess.execSync = (command, options = {}) => {
        const text = String(command).trim();
        const state = globalThis.__fakeGitState;
        if (!text.startsWith("git ") || !state) return originalExecSync(command, options);
        const gitCommand = text.slice(4);
        state.calls.push({ command: gitCommand, cwd: options.cwd });
        if (state.failAll) throw new Error("fake git failure");
        if (gitCommand === "rev-parse --git-common-dir") return ".git\\n";
        if (gitCommand === "rev-parse --show-toplevel") return state.root + "\\n";
        if (gitCommand === "remote get-url origin") return state.remote + "\\n";
        if (gitCommand === "config user.email") return state.email + "\\n";
        throw new Error("unexpected fake git command: " + gitCommand);
      };
      syncBuiltinESMExports();
    `);
    return spawnSync("node", ["--require", preloadPath, "--input-type=module", "-e", script, cwd], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
  }

  test("canonical tag uses the shared git common directory for worktrees", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const repoDir = join(tmpDir, "repo");
    const worktreeDir = join(tmpDir, "worktree");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["config", "user.name", "Test User"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    runGit(["add", "README.md"], repoDir);
    runGit(["commit", "-m", "initial"], repoDir);
    runGit(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoDir);
    assert.equal(
      getPersonalTagFor(worktreeDir, homeDir),
      getPersonalTagFor(repoDir, homeDir),
    );
  });

  test("canonical tag can still isolate individual worktrees when requested", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const repoDir = join(tmpDir, "repo");
    const worktreeDir = join(tmpDir, "worktree");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["config", "user.name", "Test User"], repoDir);
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    runGit(["add", "README.md"], repoDir);
    runGit(["commit", "-m", "initial"], repoDir);
    runGit(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoDir);
    assert.notEqual(
      getPersonalTagFor(worktreeDir, homeDir, { SUPERMEMORY_ISOLATE_WORKTREES: "true" }),
      getPersonalTagFor(repoDir, homeDir),
    );
  });

  test("uses unified tags and includes all agent legacy reads", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const repoDir = join(tmpDir, "Example Project");
    const homeDir = join(tmpDir, "home");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    runGit(["init"], repoDir);
    runGit(["config", "user.email", "test@example.com"], repoDir);
    runGit(["remote", "add", "origin", "git@github.com:acme/Example.Project.git"], repoDir);
    const root = runGit(["rev-parse", "--show-toplevel"], repoDir);
    const script = `
      import { getTags } from ${JSON.stringify(tagsModule)};
      console.log(JSON.stringify(getTags(process.argv.at(-1))));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, repoDir], {
      env: {
        ...process.env,
        HOME: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const tags = JSON.parse(result.stdout);
    const pathHash = hash16(root);
    const projectHash = hash16("github.com/acme/example.project");
    const canonicalTag = `repo_example_project__${projectHash}`;
    assert.equal(tags.user, canonicalTag);
    assert.equal(tags.project, canonicalTag);
    assert.equal(tags.canonical, canonicalTag);
    assert.equal(tags.projectId, projectHash);
    assert.equal(tags.projectName, "Example.Project");
    assert.deepEqual(tags.personalReads, [
      canonicalTag,
      `user_project_${pathHash}`,
      `claudecode_project_${pathHash}`,
      `codex_user_${hash16("test@example.com")}`,
      `opencode_user_${hash16("test@example.com")}`,
      `cursor_user_${hash16("test@example.com")}`,
    ]);
    assert.deepEqual(tags.projectReads, [
      canonicalTag,
      "repo_example_project",
      `codex_project_${pathHash}`,
      ...[...new Set([hash16(repoDir), pathHash])].map(
        (hash) => `opencode_project_${hash}`,
      ),
      `cursor_project_${pathHash}`,
    ]);
  });

  test("preserves explicit Codex container overrides for shared writes", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const repoDir = join(tmpDir, "repo");
    const homeDir = join(tmpDir, "home");
    const codexDir = join(homeDir, ".codex");
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "supermemory.json"),
      JSON.stringify({
        userContainerTag: "shared_personal",
        projectContainerTag: "shared_project",
      }),
    );
    runGit(["init"], repoDir);

    const script = `
      import { getTags } from ${JSON.stringify(tagsModule)};
      console.log(JSON.stringify(getTags(process.argv.at(-1))));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, repoDir], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const tags = JSON.parse(result.stdout);
    assert.equal(tags.user, "shared_project");
    assert.equal(tags.project, "shared_project");
    assert.equal(tags.personalReads[0], "shared_project");
    assert.ok(tags.personalReads.includes("shared_personal"));
    assert.equal(tags.projectReads[0], "shared_project");
  });

  test("resolves all tags with at most five Git subprocesses per invocation", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const homeDir = join(tmpDir, "home");
    mkdirSync(homeDir, { recursive: true });
    const script = `
      globalThis.__fakeGitState = {
        calls: [],
        root: "/fixture/first-repo",
        remote: "git@github.com:acme/First.Project.git",
        email: "first@example.com",
      };
      const { getTags } = await import(${JSON.stringify(tagsModule)});
      const cwd = process.argv.at(-1);
      const first = getTags(cwd);
      const firstCalls = globalThis.__fakeGitState.calls.splice(0);
      globalThis.__fakeGitState.root = "/fixture/second-repo";
      globalThis.__fakeGitState.remote = "git@github.com:acme/Second.Project.git";
      globalThis.__fakeGitState.email = "second@example.com";
      const second = getTags(cwd);
      const secondCalls = globalThis.__fakeGitState.calls.splice(0);
      console.log(JSON.stringify({ first, firstCalls, second, secondCalls }));
    `;
    const result = runWithFakeGit(script, "/fixture/working", homeDir, t);
    assert.equal(result.status, 0, result.stderr);
    const { first, firstCalls, second, secondCalls } = JSON.parse(result.stdout);

    assert.equal(first.projectName, "First.Project");
    assert.equal(first.projectId, hash16("github.com/acme/first.project"));
    assert.ok(first.personalReads.includes(`codex_user_${hash16("first@example.com")}`));
    assert.equal(second.projectName, "Second.Project");
    assert.equal(second.projectId, hash16("github.com/acme/second.project"));
    assert.ok(second.personalReads.includes(`codex_user_${hash16("second@example.com")}`));
    assert.notDeepEqual(first, second);
    assert.ok(firstCalls.length <= 5, `first getTags() ran ${firstCalls.length} Git commands`);
    assert.ok(secondCalls.length <= 5, `second getTags() ran ${secondCalls.length} Git commands`);
    t.diagnostic(`getTags() Git command counts: first=${firstCalls.length}, second=${secondCalls.length}`);
  });

  test("does not retain failed Git resolution across getTags invocations", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const homeDir = join(tmpDir, "home");
    mkdirSync(homeDir, { recursive: true });
    const script = `
      globalThis.__fakeGitState = {
        calls: [],
        root: "/fixture/recovered-repo",
        remote: "git@github.com:acme/Recovered.Project.git",
        email: "recovered@example.com",
        failAll: true,
      };
      const { getTags } = await import(${JSON.stringify(tagsModule)});
      const cwd = process.argv.at(-1);
      const failed = getTags(cwd);
      const failedCalls = globalThis.__fakeGitState.calls.splice(0);
      globalThis.__fakeGitState.failAll = false;
      const recovered = getTags(cwd);
      const recoveredCalls = globalThis.__fakeGitState.calls.splice(0);
      console.log(JSON.stringify({ failed, failedCalls, recovered, recoveredCalls }));
    `;
    const result = runWithFakeGit(script, "/fixture/recoverable", homeDir, t);
    assert.equal(result.status, 0, result.stderr);
    const { failed, failedCalls, recovered, recoveredCalls } = JSON.parse(result.stdout);

    assert.equal(failed.projectName, "recoverable");
    assert.equal(recovered.projectName, "Recovered.Project");
    assert.equal(recovered.projectId, hash16("github.com/acme/recovered.project"));
    assert.ok(failedCalls.length > 0);
    assert.ok(recoveredCalls.length <= 5, `recovered getTags() ran ${recoveredCalls.length} Git commands`);
    t.diagnostic(`getTags() Git command counts after failure: failed=${failedCalls.length}, recovered=${recoveredCalls.length}`);
  });
});

describe("cross-container result merging", () => {
  const mergeModule = new URL("../dist/services/resultMerge.js", import.meta.url).href;

  test("globally ranks and deduplicates legacy results", () => {
    const script = `
      import { mergeSearchResponses } from ${JSON.stringify(mergeModule)};
      const merged = mergeSearchResponses([
        { success: true, results: [{ id: "old", memory: "A", similarity: 0.4 }] },
        { success: true, results: [
          { id: "best", memory: "B", similarity: 0.9 },
          { id: "new", memory: "A", similarity: 0.8 }
        ] }
      ], 10);
      console.log(JSON.stringify(merged.results.map((item) => item.id)));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["best", "new"]);
  });

  test("normalizes high-quality profile recall hits", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const long = "x".repeat(360);
      const merged = mergeProfileResults([{
        success: true,
        profile: { static: [], dynamic: [] },
        searchResults: { results: [
          { id: "memory", memory: "memory value", similarity: 0.99, metadata: { title: "Decision", filePath: "src/a.ts" } },
          { id: "chunk", memory: {}, chunk: "chunk value", similarity: 0.95 },
          { id: "content", content: "content value", similarity: 0.9 },
          { id: "text", text: "text value", similarity: 0.85 },
          { id: "context", context: "context value", similarity: 0.8 },
          { id: "sixth", memory: long, similarity: 0.75 },
          { id: "low", memory: "too weak", similarity: 0.54 },
          { id: "object", context: { value: "never stringify" }, similarity: 1 }
        ], total: 8 }
      }], 20);
      console.log(JSON.stringify(merged.searchResults.results));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.equal(results.length, 5);
    assert.deepEqual(results.map((item) => item.memory), [
      "memory value", "chunk value", "content value", "text value", "context value",
    ]);
    assert.equal(results[0].title, "Decision");
    assert.equal(results[0].filepath, "src/a.ts");
  });

  test("keeps full recall identities and accepts score-only hits", () => {
    const script = `
      import { mergeProfileResults } from ${JSON.stringify(mergeModule)};
      const prefix = "x".repeat(300);
      const first = prefix + " first ending";
      const second = prefix + " second ending";
      const merged = mergeProfileResults([{
        success: true,
        profile: { static: [], dynamic: [] },
        searchResults: { results: [
          { memory: "score only", score: 0.95 },
          { memory: first, similarity: 0.9 },
          { memory: second, similarity: 0.8 },
          { memory: "missing similarity" },
          { memory: "weak score only", score: 0.2 },
          { memory: "too weak", similarity: 0.54 }
        ], total: 6 }
      }], 5);
      console.log(JSON.stringify(merged.searchResults.results));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const results = JSON.parse(result.stdout);
    assert.deepEqual(results.map((item) => item.memory.slice(-13)), [
      "score only",
      " first ending",
      "second ending",
      "ng similarity",
    ]);
    assert.equal(results[0].score, 0.95);
    assert.ok(results[1].memory.length > 300);
    assert.notEqual(results[1].memory, results[2].memory);
    assert.ok(!results.some((item) => item.memory === "weak score only"));
  });
});

describe("hook recall search mode", () => {
  const hookModule = new URL("../dist/services/hookRecallClient.js", import.meta.url).href;

  function searchBodyFor(t, fileConfig) {
    const { tmpDir, codexDir } = setupCodexHome(t);
    if (fileConfig) writeFileSync(join(codexDir, "supermemory.json"), JSON.stringify(fileConfig));
    const script = `
      const bodies = [];
      const fetchImpl = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.pathname.endsWith("/search")) bodies.push(JSON.parse(init.body));
        const payload = url.pathname.endsWith("/profile")
          ? { profile: { static: [], dynamic: [] } }
          : { results: [], total: 0, searchTime: 1 };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      };
      const mod = await import(${JSON.stringify(hookModule)});
      const { getHookProfileWithSearchMany } = mod.default ?? mod;
      await getHookProfileWithSearchMany(["repo_mode_test"], "what does the catch block do", { fetchImpl, timeoutMs: 2000 });
      console.log(JSON.stringify(bodies));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_mode_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const bodies = JSON.parse(result.stdout);
    assert.equal(bodies.length, 1);
    return bodies[0];
  }

  test("defaults to memories search", (t) => {
    const body = searchBodyFor(t, { recallMode: "direct" });
    assert.equal(body.searchMode, "memories");
    assert.equal(body.threshold, 0.6);
  });

  test("uses hybrid search when recallSearchMode is hybrid", (t) => {
    const body = searchBodyFor(t, { recallMode: "direct", recallSearchMode: "hybrid" });
    assert.equal(body.searchMode, "hybrid");
    assert.equal(body.threshold, 0.6);
  });

  test("pauses recall after a 402 instead of asking on every prompt", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    writeFileSync(join(codexDir, "supermemory.json"), JSON.stringify({ recallMode: "direct" }));
    const script = `
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "payment required" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      };
      const mod = await import(${JSON.stringify(hookModule)});
      const { getHookProfileWithSearchMany } = mod.default ?? mod;
      const first = await getHookProfileWithSearchMany(["repo_limit_test"], "what changed", { fetchImpl, timeoutMs: 2000 });
      const callsAfterFirst = calls;
      const second = await getHookProfileWithSearchMany(["repo_limit_test"], "what changed", { fetchImpl, timeoutMs: 2000 });
      console.log(JSON.stringify({ first: first.success, second: second.success, callsAfterFirst, calls }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_limit_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.first, false);
    assert.equal(out.second, false);
    assert.ok(out.callsAfterFirst > 0);
    assert.equal(out.calls, out.callsAfterFirst);
    const cooldown = JSON.parse(readFileSync(join(tmpDir, ".codex-supermemory", "recall-cooldown.json"), "utf-8"));
    assert.equal(cooldown.status, 402);
    assert.ok(cooldown.until > Date.now());
  });

  test("ignores unknown recallSearchMode values", (t) => {
    const body = searchBodyFor(t, { recallMode: "direct", recallSearchMode: "chunks" });
    assert.equal(body.searchMode, "memories");
  });
});

describe("hook recall skips namespaces that are empty", () => {
  const hookModule = new URL("../dist/services/hookRecallClient.js", import.meta.url).href;

  // Recall reads ten namespaces per prompt and eight of them hold nothing, which spends search quota for no hits.
  function recall(t, { listStatus = 200, stateBefore, hangList = false, writeTags, tags = ["repo_full", "repo_empty"], timeoutMs = 2000 } = {}) {
    const { tmpDir } = setupCodexHome(t);
    const stateFile = join(tmpDir, ".codex-supermemory", "namespace-contents.json");
    if (stateBefore) {
      mkdirSync(join(tmpDir, ".codex-supermemory"), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(stateBefore(Date.now())));
    }
    const script = `
      const totals = { repo_full: 5, repo_empty: 0 };
      const calls = [];
      const fetchImpl = async (input) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        calls.push(url.pathname);
        const [, , ns, op, type] = url.pathname.split("/");
        const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        if (op === "list") {
          if (${hangList}) return new Promise(() => {});
          if (${listStatus} !== 200) return json({ error: "boom" }, ${listStatus});
          const n = totals[ns];
          return json({ memories: [], documents: [], chunks: [], pagination: { currentPage: 1, limit: 1, totalItems: type === "memories" ? n : 0, totalPages: n } });
        }
        return json(ns === "repo_full"
          ? { results: [{ id: "m1", memory: "chose drizzle", similarity: 0.9 }], total: 1, searchTime: 1 }
          : { results: [], total: 0, searchTime: 1 });
      };
      const mod = await import(${JSON.stringify(hookModule)});
      const { getHookProfileWithSearchMany } = mod.default ?? mod;
      const rounds = [];
      for (let i = 0; i < 2; i++) {
        calls.length = 0;
        const started = Date.now();
        const result = await getHookProfileWithSearchMany(${JSON.stringify(tags)}, "what did we pick",
          { fetchImpl, timeoutMs: ${timeoutMs}, writeTags: ${JSON.stringify(writeTags ?? [])} });
        rounds.push({ calls: [...calls].sort(), hits: result.searchResults?.results?.length ?? 0, success: result.success, elapsed: Date.now() - started });
      }
      console.log(JSON.stringify(rounds));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_empty_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    return { rounds: JSON.parse(result.stdout), state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf-8")) : {} };
  }

  test("checks contents once, then skips an empty namespace and stops listing a full one", (t) => {
    const { rounds, state } = recall(t);
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/search"));
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/list/memories"));
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/list/documents"));
    assert.deepEqual(rounds[1].calls, ["/ns/repo_full/search"]);
    assert.equal(rounds[1].hits, 1);
    assert.equal(state.repo_empty.empty, true);
    assert.equal(state.repo_full.empty, false);
  });

  test("searches an empty namespace again once its check is six hours old", (t) => {
    const old = (now) => ({ repo_empty: { empty: true, checkedAt: now - 6 * 60 * 60 * 1000 - 1 }, repo_full: { empty: false, checkedAt: now } });
    const { rounds, state } = recall(t, { stateBefore: old });
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/search"));
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/list/memories"));
    assert.ok(state.repo_empty.checkedAt > Date.now() - 60_000);
  });

  test("a failed list never marks a namespace empty and is not retried on every prompt", (t) => {
    const { rounds, state } = recall(t, { listStatus: 500 });
    assert.ok(rounds[1].calls.includes("/ns/repo_empty/search"));
    assert.ok(!rounds[1].calls.some((path) => path.includes("/list/")));
    assert.equal(rounds[1].hits, 1);
    assert.equal(state.repo_empty.empty, false);
  });

  test("a list call that hangs never holds the prompt past the recall budget", (t) => {
    const { rounds, state } = recall(t, { hangList: true, timeoutMs: 300 });
    assert.equal(rounds[0].hits, 1);
    assert.ok(rounds[0].elapsed < 1500, `took ${rounds[0].elapsed} ms`);
    assert.equal(state.repo_empty?.empty, false);
  });

  test("never skips a namespace this plugin writes to", (t) => {
    const marked = (now) => ({ repo_empty: { empty: true, checkedAt: now } });
    const { rounds } = recall(t, { stateBefore: marked, writeTags: ["repo_empty"] });
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/search"));
  });

  test("all namespaces empty is a successful recall with no hits", (t) => {
    const marked = (now) => ({ repo_empty: { empty: true, checkedAt: now } });
    const { rounds } = recall(t, { stateBefore: marked, tags: ["repo_empty"] });
    assert.equal(rounds[0].success, true);
    assert.equal(rounds[0].hits, 0);
    assert.deepEqual(rounds[0].calls, []);
  });

  test("a check dated in the future is not trusted", (t) => {
    const ahead = (now) => ({ repo_empty: { empty: true, checkedAt: now + 24 * 60 * 60 * 1000 } });
    const { rounds } = recall(t, { stateBefore: ahead });
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/search"));
  });

  test("a broken state file is ignored, not fatal", (t) => {
    const { rounds } = recall(t, { stateBefore: () => "not an object" });
    assert.ok(rounds[0].calls.includes("/ns/repo_empty/search"));
    assert.equal(rounds[0].success, true);
  });
});

describe("hook recall requests", () => {
  const hookModule = new URL("../dist/services/hookRecallClient.js", import.meta.url).href;

  // The prompt hook only injects search hits. A slow /profile used to hold the
  // hook and, past the 3 s abort, dropped search results that had arrived.
  test("asks only /search, not /profile, and keeps hits when /profile would hang", (t) => {
    const { tmpDir } = setupCodexHome(t);
    const script = `
      const paths = [];
      const fetchImpl = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        paths.push(url.pathname);
        if (url.pathname.endsWith("/profile")) {
          return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason)));
        }
        return new Response(JSON.stringify({ results: [{ id: "m1", memory: "chose drizzle", similarity: 0.9 }], total: 1, searchTime: 1 }),
          { status: 200, headers: { "content-type": "application/json" } });
      };
      const mod = await import(${JSON.stringify(hookModule)});
      const { getHookProfileWithSearchMany } = mod.default ?? mod;
      const result = await getHookProfileWithSearchMany(["repo_req_test"], "what does the catch block do", { fetchImpl, timeoutMs: 1500 });
      console.log(JSON.stringify({ paths, success: result.success, hits: result.searchResults?.results?.length ?? 0 }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_request_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout);
    // Content checks of a namespace seen for the first time are list calls, not /profile.
    assert.deepEqual(out.paths.filter((path) => !path.includes("/list/")), ["/ns/repo_req_test/search"]);
    assert.equal(out.paths.filter((path) => path.includes("/list/")).length, 2);
    assert.equal(out.success, true);
    assert.equal(out.hits, 1);
  });
});

describe("API v5 profile response validation", () => {
  const clientModule = new URL("../dist/services/client.js", import.meta.url).href;

  function readProfileResponse(profilePayload, t) {
    const { tmpDir } = setupCodexHome(t);
    const script = `
      const payload = JSON.parse(process.argv.at(-1));
      const requests = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        requests.push({ method: init.method ?? input.method ?? "GET", url: url.pathname });
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const { SupermemoryClient } = await import(${JSON.stringify(clientModule)});
      const client = new SupermemoryClient();
      const result = await client.getProfileWithSearch("repo_profile_test");
      console.log(JSON.stringify({ result, requests }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script, JSON.stringify(profilePayload)], {
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_profile_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  test("rejects a missing or malformed profile envelope instead of treating it as empty", (t) => {
    for (const payload of [
      {},
      { profile: null },
      { profile: [] },
      { profile: { dynamic: [] } },
      { profile: { static: [], dynamic: null } },
    ]) {
      const { result, requests } = readProfileResponse(payload, t);
      assert.equal(result.success, false, JSON.stringify(payload));
      assert.equal(result.profile, null);
      assert.match(result.error, /profile/i);
      assert.deepEqual(requests, [{ method: "POST", url: "/ns/repo_profile_test/profile" }]);
    }
  });

  test("rejects malformed static and dynamic facts instead of dropping them", (t) => {
    for (const profile of [
      { static: [null], dynamic: [] },
      { static: [{ id: "mem_missing_text" }], dynamic: [] },
      { static: [], dynamic: [42] },
      { static: ["   "], dynamic: [] },
    ]) {
      const { result } = readProfileResponse({ profile }, t);
      assert.equal(result.success, false, JSON.stringify(profile));
      assert.equal(result.profile, null);
      assert.match(result.error, /profile/i);
    }
  });

  test("accepts valid empty sections and preserves string and v5 memory facts", (t) => {
    const empty = readProfileResponse({ profile: { static: [], dynamic: [], buckets: {} } }, t);
    assert.equal(empty.result.success, true, JSON.stringify(empty));
    assert.deepEqual(empty.result.profile, { static: [], dynamic: [] });

    const populated = readProfileResponse({
      profile: {
        static: ["A string profile fact"],
        dynamic: [{ id: "mem_profile_1", memory: "A v5 object profile fact" }],
        buckets: {},
      },
    }, t);
    assert.equal(populated.result.success, true, JSON.stringify(populated));
    assert.deepEqual(populated.result.profile, {
      static: ["A string profile fact"],
      dynamic: ["A v5 object profile fact"],
    });
  });
});

describe("capture tracker", () => {
  const trackerModule = new URL("../dist/services/tracker.js", import.meta.url).href;
  const captureModule = new URL("../dist/services/capture.js", import.meta.url).href;

  test("reports a successful capture for the Stop hook notice", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const transcriptFile = join(homeDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [
          { type: "input_text", text: "Remember that " },
          { type: "input_text", text: "we use PostgreSQL." },
        ] } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Remember that we use PostgreSQL." } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [
          { type: "output_text", text: "Understood." },
        ] } }),
      ].join("\n"),
    );
    const script = `
      import { captureEntries } from ${JSON.stringify(captureModule)};
      let capturedContent = "";
      const client = { addMemory: async (content) => {
        capturedContent = content;
        return { success: true };
      } };
      const result = await captureEntries(
        "flush",
        client,
        "notice-session",
        ${JSON.stringify(transcriptFile)},
        {
          canonical: "repo_test__1234567890abcdef",
          project: "repo_test__1234567890abcdef",
          user: "repo_test__1234567890abcdef",
          projectName: "test",
          projectId: "1234567890abcdef",
        },
      );
      console.log(JSON.stringify({ result, capturedContent }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.deepEqual(captured.result, { status: "captured", entryCount: 2 });
    assert.match(captured.capturedContent, /1\. \[user\] Remember that we use PostgreSQL\./);
    assert.match(captured.capturedContent, /2\. \[assistant\] Understood\./);
    assert.equal(captured.capturedContent.match(/Remember that we use PostgreSQL\./g)?.length, 1);
  });

  test("serializes overlapping capture transactions and keeps the cursor monotonic", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const script = `
      import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
      import { homedir } from "node:os";
      import { join } from "node:path";
      import {
        getLastCapturedIndex,
        setLastCapturedIndex,
        withSessionCaptureLock,
      } from ${JSON.stringify(trackerModule)};
      const order = [];
      const first = withSessionCaptureLock("session", async () => {
        order.push("first-start");
        await new Promise((resolve) => setTimeout(resolve, 40));
        setLastCapturedIndex("session", 20);
        order.push("first-end");
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = withSessionCaptureLock("session", async () => {
        order.push("second");
        setLastCapturedIndex("session", 10);
      });
      const acquired = await Promise.all([first, second]);

      const trackerDir = join(homedir(), ".codex-supermemory", "trackers");
      mkdirSync(trackerDir, { recursive: true });
      const staleLock = join(trackerDir, "stale.capture.lock");
      writeFileSync(staleLock, process.pid + ":0:reused-pid");
      const staleTime = new Date(Date.now() - 40_000);
      utimesSync(staleLock, staleTime, staleTime);
      const reclaimed = await withSessionCaptureLock("stale", async () => {}, 250);

      console.log(JSON.stringify({ acquired, order, index: getLastCapturedIndex("session"), reclaimed }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      acquired: [true, true],
      order: ["first-start", "first-end", "second"],
      index: 20,
      reclaimed: true,
    });
  });
});

describe("hook SDK request bounds", () => {
  const clientModule = new URL("../dist/services/client.js", import.meta.url).href;

  test("aborts the SDK fetch without retries", (t) => {
    const script = `
      import { SupermemoryClient } from ${JSON.stringify(clientModule)};
      let calls = 0;
      let aborted = false;
      globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        calls += 1;
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      const started = Date.now();
      const result = await new SupermemoryClient().getProfileMany(
        ["repo_test"], undefined, { timeoutMs: 20 },
      );
      console.log(JSON.stringify({ success: result.success, calls, aborted, elapsed: Date.now() - started }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "sm_test" }),
      encoding: "utf-8",
      timeout: 1_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.equal(output.calls, 1);
    assert.equal(output.aborted, true);
    assert.ok(output.elapsed < 500, `bounded request took ${output.elapsed}ms`);
  });
});

describe("combined recall formatting", () => {
  const contextModule = new URL("../dist/services/context.js", import.meta.url).href;

  test("budgets both profile sections and truncates only display text", () => {
    const script = `
      import { formatCombinedContext } from ${JSON.stringify(contextModule)};
      const long = "z".repeat(320) + " durable ending";
      const result = formatCombinedContext({
        success: true,
        profile: { static: ["s1", "s2", "s3"], dynamic: ["d1", "d2", "d3"] },
        searchResults: { results: [{ memory: long, similarity: 0.9 }], total: 1 },
      }, 5, 2);
      console.log(JSON.stringify(result));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.text, /1\. ◪ s1/);
    assert.match(output.text, /3\. ◪ d1/);
    assert.doesNotMatch(output.text, /s3|d3|durable ending/);
    assert.match(output.text, /from supermemory/);
    assert.equal(output.newFacts.at(-1).endsWith("durable ending"), true);
  });
});

describe("session recall deduplication", () => {
  const factCacheModule = new URL("../dist/services/factCache.js", import.meta.url).href;

  test("stores only a bounded set of hashed fact identities", (t) => {
    const homeDir = makeTmpDir();
    t.after(() => rmSync(homeDir, { recursive: true, force: true }));
    const script = `
      import { addSeenFacts, getSeenFacts } from ${JSON.stringify(factCacheModule)};
      addSeenFacts("session", Array.from({ length: 550 }, (_, i) => \`fact \${i}\`));
      console.log(JSON.stringify([...getSeenFacts("session")]));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const facts = JSON.parse(result.stdout);
    assert.equal(facts.length, 500);
    assert.ok(facts.every((fact) => /^sha256:[0-9a-f]{64}$/.test(fact)));
    assert.ok(!facts.some((fact) => fact.includes("fact")));
  });
});

describe("direct recall policy", () => {
  const policyModule = new URL("../dist/services/recallPolicy.js", import.meta.url).href;
  const hookClientModule = new URL("../dist/services/hookRecallClient.js", import.meta.url).href;

  test("skips control and tiny prompts while capping substantive queries", () => {
    const script = `
      import { shouldRecallPrompt, prepareRecallQuery } from ${JSON.stringify(policyModule)};
      console.log(JSON.stringify({
        decisions: ["short", "/supermemory", "!shell command", "# heading text", "explain the cache design"].map(shouldRecallPrompt),
        queryLength: prepareRecallQuery("x".repeat(600)).length,
      }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      decisions: [false, false, false, false, true],
      queryLength: 500,
    });
  });

  test("aborts hook-only profile fetches and fails open", (t) => {
    const script = `
      import { getHookProfileWithSearchMany } from ${JSON.stringify(hookClientModule)};
      const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      const started = Date.now();
      const result = await getHookProfileWithSearchMany(["repo_test"], "substantive recall query", {
        timeoutMs: 20,
        fetchImpl,
      });
      console.log(JSON.stringify({ success: result.success, elapsed: Date.now() - started }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "sm_test" }),
      encoding: "utf-8",
      timeout: 1_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.success, false);
    assert.ok(output.elapsed < 500, `abort took ${output.elapsed}ms`);
  });

  test("uses 3s on api.supermemory.ai and 60s on self-hosted APIs", () => {
    const script = `
      import {
        hookRecallTimeoutMs,
        HOOK_RECALL_TIMEOUT_MS,
        SELF_HOSTED_HOOK_RECALL_TIMEOUT_MS,
      } from ${JSON.stringify(hookClientModule)};
      console.log(JSON.stringify({
        hosted: hookRecallTimeoutMs("https://api.supermemory.ai"),
        hostedSlash: hookRecallTimeoutMs("https://api.supermemory.ai/"),
        hostedCase: hookRecallTimeoutMs("https://API.SUPERMEMORY.AI"),
        loopback: hookRecallTimeoutMs("http://127.0.0.1:6767"),
        custom: hookRecallTimeoutMs("https://memory.example.com"),
        invalid: hookRecallTimeoutMs("not-a-url"),
        hostedMs: HOOK_RECALL_TIMEOUT_MS,
        selfHostedMs: SELF_HOSTED_HOOK_RECALL_TIMEOUT_MS,
      }));
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf-8" });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hostedMs, 3000);
    assert.equal(output.selfHostedMs, 60_000);
    assert.equal(output.hosted, 3000);
    assert.equal(output.hostedSlash, 3000);
    assert.equal(output.hostedCase, 3000);
    assert.equal(output.loopback, 60_000);
    assert.equal(output.custom, 60_000);
    assert.equal(output.invalid, 3000);
  });

  test("default recall timeout follows SUPERMEMORY_API_URL", (t) => {
    const script = `
      import { hookRecallTimeoutMs } from ${JSON.stringify(hookClientModule)};
      console.log(hookRecallTimeoutMs());
    `;
    const hosted = spawnSync("node", ["--input-type=module", "-e", script], {
      env: isolatedEnv(t, { SUPERMEMORY_API_URL: "https://api.supermemory.ai" }),
      encoding: "utf-8",
    });
    const selfHosted = spawnSync("node", ["--input-type=module", "-e", script], {
      env: isolatedEnv(t, { SUPERMEMORY_API_URL: "http://127.0.0.1:6767" }),
      encoding: "utf-8",
    });
    assert.equal(hosted.status, 0, hosted.stderr);
    assert.equal(selfHosted.status, 0, selfHosted.stderr);
    assert.equal(Number(hosted.stdout.trim()), 3000);
    assert.equal(Number(selfHosted.stdout.trim()), 60_000);
  });
});

// ─── session ids ────────────────────────────────────────────────────────────

describe("session ids", () => {
  const sessionModule = new URL("../dist/services/session.js", import.meta.url).href;

  function getSessionIdFor(providedSessionId, scope, isoDate) {
    const script = `
      import { getSessionId } from ${JSON.stringify(sessionModule)};
      const provided = process.argv[1] === "__null__" ? null : process.argv[1];
      console.log(getSessionId(provided, process.argv[2], new Date(process.argv[3])));
    `;
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        script,
        providedSessionId ?? "__null__",
        scope,
        isoDate,
      ],
      { encoding: "utf-8" }
    );
    assert.equal(result.status, 0, `getSessionId failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  test("uses Codex session_id when provided", () => {
    assert.equal(
      getSessionIdFor("s1", "codex_project_abc", "2026-05-17T05:59:00.000Z"),
      "s1"
    );
  });

  test("fallback session id is stable within the same 4-hour window", () => {
    const early = getSessionIdFor(null, "codex_project_abc", "2026-05-17T04:00:00.000Z");
    const late = getSessionIdFor(null, "codex_project_abc", "2026-05-17T07:59:59.999Z");

    assert.match(early, /^codex_[a-f0-9]{16}$/);
    assert.equal(early, late);
  });

  test("fallback session id changes at the next 4-hour window", () => {
    const current = getSessionIdFor(null, "codex_project_abc", "2026-05-17T07:59:59.999Z");
    const next = getSessionIdFor(null, "codex_project_abc", "2026-05-17T08:00:00.000Z");

    assert.notEqual(current, next);
  });

  test("fallback session id is scoped by project tag", () => {
    const first = getSessionIdFor(null, "codex_project_abc", "2026-05-17T04:00:00.000Z");
    const second = getSessionIdFor(null, "codex_project_def", "2026-05-17T04:00:00.000Z");

    assert.notEqual(first, second);
  });
});

// ─── stripPrivateContent ────────────────────────────────────────────────────

describe("stripPrivateContent", () => {
  test("leaves plain text unchanged", () => {
    assert.equal(stripPrivateContent("hello world"), "hello world");
  });

  test("redacts a single private block", () => {
    assert.equal(
      stripPrivateContent("before <private>secret</private> after"),
      "before [REDACTED] after"
    );
  });

  test("redacts multiple private blocks", () => {
    assert.equal(
      stripPrivateContent("<private>a</private> mid <private>b</private>"),
      "[REDACTED] mid [REDACTED]"
    );
  });

  test("redacts multiline private block", () => {
    assert.equal(stripPrivateContent("<private>\nline1\nline2\n</private>"), "[REDACTED]");
  });

  test("is case-insensitive", () => {
    assert.equal(stripPrivateContent("<PRIVATE>secret</PRIVATE>"), "[REDACTED]");
  });
});

describe("browser auth opener", () => {
  test("SessionStart owns browser authentication with a bounded window", () => {
    const authSource = readFileSync(new URL("../src/services/auth.ts", import.meta.url), "utf-8");
    const sessionStartSource = readFileSync(new URL("../src/hooks/session-start.ts", import.meta.url), "utf-8");
    assert.ok(authSource.includes("startAuthFlow(timeoutMs = AUTH_TIMEOUT)"));
    assert.ok(sessionStartSource.includes("startAuthFlow(getSessionStartAuthTimeoutMs())"));
    assert.ok(!existsSync(new URL("../src/skills/login.ts", import.meta.url)));
  });

  test("SessionStart keeps update notices out of model context", () => {
    const sessionStartSource = readFileSync(new URL("../src/hooks/session-start.ts", import.meta.url), "utf-8");
    const versionCheckSource = readFileSync(new URL("../src/services/version-check.ts", import.meta.url), "utf-8");
    assert.ok(sessionStartSource.includes("exitWithContext(context, combineContextParts(["));
    assert.ok(!sessionStartSource.includes("context,\n        updateNotice,"));
    assert.ok(!sessionStartSource.includes('exitWithContext(await updateCheck ?? ""'));
    assert.ok(!versionCheckSource.includes("[SUPERMEMORY UPDATE]"));
    assert.ok(versionCheckSource.includes("Run in your terminal:"));
  });
});

// ─── hooks.json format ──────────────────────────────────────────────────────

describe("entity context wiring", () => {
  test("client addMemory forwards entityContext into the API payload", () => {
    const content = readFileSync(new URL("../src/services/client.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("USER_ENTITY_CONTEXT"));
    assert.ok(content.includes("PROJECT_ENTITY_CONTEXT"));
    assert.ok(content.includes("entityContext?: string"));
    assert.ok(content.includes("payload.entityContext = options.entityContext"));
    assert.match(content, /human teammate would remember/);
    assert.match(content, /Transient Git state/);
  });

  test("automatic capture writes user entity context", () => {
    const content = readFileSync(new URL("../src/services/capture.ts", import.meta.url), "utf-8");
    assert.ok(content.includes("entityContext: USER_ENTITY_CONTEXT"));
    assert.ok(content.includes('sm_scope: "personal"'));
    assert.ok(content.includes("project: tags.projectName"));
  });

});

describe("hooks.json format", () => {
  test("wrapped hooks.json shape is valid JSON", () => {
    const recallScript = "/home/user/.codex/supermemory/recall.js";
    const flushScript = "/home/user/.codex/supermemory/flush.js";

    const hooksJson = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: `node ${recallScript}`, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: `node ${flushScript}`, timeout: 30, async: true }] }],
      },
    };
    const json = JSON.stringify(hooksJson, null, 2);
    const parsed = JSON.parse(json);

    assert.ok(parsed.hooks, "must have top-level hooks key");
    assert.ok(!parsed.UserPromptSubmit, "must NOT have UserPromptSubmit at top level");
    assert.ok(Array.isArray(parsed.hooks.UserPromptSubmit), "hooks.UserPromptSubmit must be an array");
    assert.equal(parsed.hooks.UserPromptSubmit[0].hooks[0].timeout, 5);
    assert.ok(Array.isArray(parsed.hooks.Stop), "hooks.Stop must be an array");
    assert.equal(parsed.hooks.Stop[0].hooks[0].type, "command");
    assert.equal(parsed.hooks.Stop[0].hooks[0].async, true);
  });

  test("dedup: adding same command twice results in exactly one entry", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    const hooks = { UserPromptSubmit: [] };

    function addRecall(h) {
      const hasRecall = h.UserPromptSubmit.some((g) =>
        g.hooks.some((e) => e.command === recallCmd)
      );
      if (!hasRecall) {
        const globalGroup = h.UserPromptSubmit.find((g) => !g.matcher);
        if (globalGroup) {
          globalGroup.hooks.push({ type: "command", command: recallCmd });
        } else {
          h.UserPromptSubmit.push({ hooks: [{ type: "command", command: recallCmd }] });
        }
      }
      return h;
    }

    addRecall(hooks);
    addRecall(hooks); // second call — should be no-op

    const total = hooks.UserPromptSubmit.flatMap((g) => g.hooks).filter(
      (e) => e.command === recallCmd
    );
    assert.equal(total.length, 1, "should have exactly one recall hook after two installs");
  });

  test("dedup: appends new global group when existing groups are all matcher-scoped", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    const hooks = {
      UserPromptSubmit: [
        { matcher: "shell", hooks: [{ type: "command", command: "other-hook" }] },
      ],
    };

    const hasRecall = hooks.UserPromptSubmit.some((g) =>
      g.hooks.some((e) => e.command === recallCmd)
    );
    if (!hasRecall) {
      const globalGroup = hooks.UserPromptSubmit.find((g) => !g.matcher);
      if (globalGroup) {
        globalGroup.hooks.push({ type: "command", command: recallCmd });
      } else {
        hooks.UserPromptSubmit.push({ hooks: [{ type: "command", command: recallCmd }] });
      }
    }

    assert.equal(hooks.UserPromptSubmit.length, 2, "should have two groups");
    assert.equal(hooks.UserPromptSubmit[0].matcher, "shell", "first group unchanged");
    assert.ok(!hooks.UserPromptSubmit[1].matcher, "second group has no matcher");
    assert.equal(hooks.UserPromptSubmit[1].hooks[0].command, recallCmd);
  });

  test("uninstall: removes hooks from all groups and drops empty groups", () => {
    const recallCmd = "/home/user/.codex/supermemory/recall.js";
    let hooks = {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: recallCmd }] },
        { matcher: "shell", hooks: [{ type: "command", command: "other" }] },
      ],
    };

    hooks.UserPromptSubmit = hooks.UserPromptSubmit
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => h.command !== recallCmd) }))
      .filter((g) => g.hooks.length > 0);

    assert.equal(hooks.UserPromptSubmit.length, 1, "empty group should be dropped");
    assert.equal(hooks.UserPromptSubmit[0].matcher, "shell", "matcher-scoped group preserved");
  });
});

// ─── integration: install/uninstall (skills + hooks) ──────────────────────
//
// These tests spawn the built CLI against a fake $HOME and assert on the
// resulting on-disk state. They depend on dist/cli.js — `npm test` runs
// `npm run build` first, so this should always be present when invoked
// through npm.

describe("integration: install/uninstall", () => {
  const cliBin = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

  test("generated pet badge reflects Codex states", () => {
    const pet = readGeneratedPetPng(fileURLToPath(new URL("../dist/pet/spritesheet.png", import.meta.url)));
    assert.equal(pet.width, 1536);
    assert.equal(pet.height, 1872);

    const accentAtRow = (row) => pet.pixel(17, row * 208 + 178);
    const running = accentAtRow(7);
    const ready = accentAtRow(8);
    const blocked = accentAtRow(5);
    const waiting = accentAtRow(6);

    assert.ok(running[2] > running[0] && running[2] > running[1], "running accent should be blue");
    assert.ok(ready[1] > ready[0] && ready[1] > ready[2], "ready accent should be green");
    assert.ok(blocked[0] > blocked[1] && blocked[0] > blocked[2], "blocked accent should be red");
    assert.ok(waiting[0] > waiting[1] && waiting[1] > waiting[2], "needs-input accent should be amber");
    assert.equal(pet.pixel(7 * 192 + 17, 178)[3], 0, "unused idle frames should be transparent");
  });

  test("install keeps status and index skills and registers hosted MCP", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    for (const legacy of ["supermemory-search", "supermemory-login", "supermemory-logout"]) {
      mkdirSync(join(codexDir, "skills", legacy), { recursive: true });
      writeFileSync(join(codexDir, "skills", legacy, "SKILL.md"), "legacy");
    }

    const result = runCli(cliBin, "install", tmpDir);
    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);

    const skillsDir = join(codexDir, "skills");
    assert.ok(existsSync(join(skillsDir, "supermemory-status", "SKILL.md")));
    assert.ok(existsSync(join(skillsDir, "supermemory-index", "SKILL.md")));
    assert.ok(!existsSync(join(codexDir, "supermemory", "index.js")));
    for (const legacy of ["supermemory-search", "supermemory-login", "supermemory-logout"]) {
      assert.ok(!existsSync(join(skillsDir, legacy)), `${legacy} should be removed`);
    }

    const toml = readToml(join(codexDir, "config.toml"));
    assert.equal(toml.mcp_servers.supermemory.command, "node");
    assert.deepEqual(toml.mcp_servers.supermemory.args, [
      join(codexDir, "supermemory", "mcp-proxy.js"),
    ]);
    assert.deepEqual(toml.mcp_servers.supermemory.env_vars, [
      "SUPERMEMORY_CODEX_API_KEY",
    ]);
    assert.equal(toml.tui.pet, "supermemory");
    assert.equal(toml.tui.pet_anchor, "screen-bottom");
    assert.ok(existsSync(join(codexDir, "pets", "supermemory", "pet.json")));
    assert.ok(existsSync(join(codexDir, "pets", "supermemory", "spritesheet.png")));
    const config = JSON.parse(readFileSync(join(codexDir, "supermemory.json"), "utf-8"));
    assert.equal(config.recallMode, "direct");
    assert.equal(config.captureEveryNTurns, 0);
  });

  test("install registers synchronous recall hooks and background capture", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const flushScript = join(codexDir, "supermemory", "flush.js");
    const flushCmd = `node ${flushScript}`;
    const encodedFlushCmd = `node -e "require(Buffer.from('${Buffer.from(flushScript, "utf-8").toString("base64")}','base64').toString('utf-8'))"`;
    assert.equal(matchesHookCommand(encodedFlushCmd, flushScript), true);
    assert.equal(matchesHookCommand(`${encodedFlushCmd} extra`, flushScript), false);
    assert.equal(matchesHookCommand(encodedFlushCmd, `${flushScript}.bak`), false);
    writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: flushCmd, timeout: 60 }] }],
      },
    }));

    const result = runCli(cliBin, "install", tmpDir);
    assert.equal(result.status, 0, result.stderr);

    const hooks = JSON.parse(readFileSync(hooksPath, "utf-8")).hooks;
    const stop = hooks.Stop.flatMap((group) => group.hooks)
      .find((hook) => matchesHookCommand(hook.command, flushScript));
    const recallScript = join(codexDir, "supermemory", "recall.js");
    const recall = hooks.UserPromptSubmit.flatMap((group) => group.hooks)
      .find((hook) => matchesHookCommand(hook.command, recallScript));
    const recallApproveScript = join(codexDir, "supermemory", "recall-approve.js");
    const recallApprove = hooks.PreToolUse.flatMap((group) => group.hooks)
      .find((hook) => matchesHookCommand(hook.command, recallApproveScript));
    const recallApproveGroup = hooks.PreToolUse.find((group) =>
      group.hooks.includes(recallApprove)
    );
    const sessionStartScript = join(codexDir, "supermemory", "session-start.js");
    const sessionStart = hooks.SessionStart.flatMap((group) => group.hooks)
      .find((hook) => matchesHookCommand(hook.command, sessionStartScript));

    assert.deepEqual(
      { async: stop.async, timeout: stop.timeout },
      { async: true, timeout: 30 },
    );
    assert.equal(recall.async, undefined);
    assert.equal(recall.timeout, 60);
    assert.equal(recallApprove.async, undefined);
    assert.equal(recallApprove.timeout, 5);
    assert.equal(recallApproveGroup.matcher, "^mcp__supermemory__");
    assert.ok(!existsSync(join(codexDir, "supermemory", "capture-turn.js")));
    assert.equal(sessionStart.async, undefined);
    assert.equal(sessionStart.timeout, 30);
  });

  test("uninstall removes skill directories", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);

    const installResult = runCli(cliBin, "install", tmpDir);
    assert.equal(installResult.status, 0, `install should exit 0: ${installResult.stderr}`);
    const uninstallResult = runCli(cliBin, "uninstall", tmpDir);
    assert.equal(uninstallResult.status, 0, `uninstall should exit 0: ${uninstallResult.stderr}`);

    const skillsDir = join(codexDir, "skills");
    assert.ok(!existsSync(join(skillsDir, "supermemory-status")));
    assert.ok(!existsSync(join(skillsDir, "supermemory-index")));
    assert.ok(!existsSync(join(codexDir, "pets", "supermemory")));
  });

  test("uninstall drops empty [features] section", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);

    const installResult = runCli(cliBin, "install", tmpDir);
    assert.equal(installResult.status, 0, `install should exit 0: ${installResult.stderr}`);
    const uninstallResult = runCli(cliBin, "uninstall", tmpDir);
    assert.equal(uninstallResult.status, 0, `uninstall should exit 0: ${uninstallResult.stderr}`);

    const raw = readFileSync(configPath, "utf-8");
    assert.ok(!raw.includes("[features]"), "stale [features] section should be removed on uninstall");
    const config = readToml(configPath);
    assert.ok(!config.features, "features table should not exist after uninstall");
  });

  test("install aborts and preserves config.toml when TOML parsing fails", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    const invalidConfig = 'model = "gpt-5"\n[features\ncodex_hooks = true\n';
    writeFileSync(configPath, invalidConfig);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /config\.toml/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(configPath, "utf-8"), invalidConfig);
  });

  test("uninstall aborts and preserves config.toml when TOML parsing fails", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    const invalidConfig = 'model = "gpt-5"\n[features\ncodex_hooks = true\n';
    writeFileSync(configPath, invalidConfig);

    const result = runCli(cliBin, "uninstall", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /config\.toml/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(configPath, "utf-8"), invalidConfig);
  });

  test("install aborts and preserves hooks.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const invalidHooks = '{ "hooks": { "Stop": [ }';
    writeFileSync(hooksPath, invalidHooks);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /hooks\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(hooksPath, "utf-8"), invalidHooks);
  });

  test("uninstall aborts and preserves hooks.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const hooksPath = join(codexDir, "hooks.json");
    const invalidHooks = '{ "hooks": { "Stop": [ }';
    writeFileSync(hooksPath, invalidHooks);

    const result = runCli(cliBin, "uninstall", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /hooks\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(hooksPath, "utf-8"), invalidHooks);
  });

  test("install aborts and preserves supermemory.json when JSON parsing fails", (t) => {
    const { tmpDir, codexDir } = setupCodexHome(t);
    const supermemoryPath = join(codexDir, "supermemory.json");
    const invalidConfig = '{ "apiKey": "sm_test", ';
    writeFileSync(supermemoryPath, invalidConfig);

    const result = runCli(cliBin, "install", tmpDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to parse/);
    assert.match(result.stderr, /supermemory\.json/);
    assert.match(result.stderr, /No changes were made/);
    assert.equal(readFileSync(supermemoryPath, "utf-8"), invalidConfig);
  });

  test("install merges into existing valid config.toml", (t) => {
    const { tmpDir, configPath } = setupCodexHome(t);
    writeFileSync(
      configPath,
      'model = "gpt-5"\n\n[features]\nweb_search = true\n\n[tui]\npet = "dewey"\npet_anchor = "composer"\n',
    );

    const result = runCli(cliBin, "install", tmpDir);

    assert.equal(result.status, 0, `install should exit 0: ${result.stderr}`);
    const config = readToml(configPath);
    assert.equal(config.model, "gpt-5");
    assert.equal(config.features.web_search, true);
    assert.equal(config.features.codex_hooks, undefined);
    assert.equal(config.mcp_servers.supermemory.command, "node");
    assert.equal(config.tui.pet, "dewey");
    assert.equal(config.tui.pet_anchor, "composer");
  });
});


// ─── recall hook output envelope ────────────────────────────────────────────

describe("recall hook output envelope", () => {
  const recallBin = fileURLToPath(new URL("../dist/hooks/recall.js", import.meta.url));

  // Recall must return login guidance without starting browser authentication.
  function runRecallUnconfigured(t, input) {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const result = spawnSync("node", [recallBin], {
      input,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
      timeout: 5_000,
    });
    return { result, tmpDir };
  }

  test("outputs hookSpecificOutput envelope when not configured", (t) => {
    const { result, tmpDir } = runRecallUnconfigured(
      t,
      JSON.stringify({ session_id: "s1", prompt: "hello" }),
    );
    const parsed = JSON.parse(result.stdout);
    assert.ok("hookSpecificOutput" in parsed, "must have hookSpecificOutput key");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
    assert.equal(
      existsSync(join(tmpDir, ".codex", "supermemory", ".auth-attempted")),
      false,
    );
  });

  test("emits no envelope on empty prompt (so Codex doesn't render an empty hook context line)", (t) => {
    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ session_id: "s1", prompt: "" }),
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "sm_test" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "", "empty context should produce empty stdout");
  });

  test("emits no envelope on malformed JSON input", (t) => {
    const result = spawnSync("node", [recallBin], {
      input: "not-json",
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "sm_test" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  test("never outputs bare additionalContext at top level (old wrong shape)", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    const parsed = JSON.parse(result.stdout);
    assert.ok(!("additionalContext" in parsed), "must NOT have top-level additionalContext");
  });

  test("exits with code 0", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

    const result = spawnSync("node", [recallBin], {
      input: JSON.stringify({ prompt: "test" }),
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});

describe("hosted MCP hooks", () => {
  const approveBin = fileURLToPath(new URL("../dist/hooks/recall-approve.js", import.meta.url));
  const proxyBin = fileURLToPath(new URL("../dist/hooks/mcp-proxy.js", import.meta.url));

  test("read-only searches show the query and are allowed", () => {
    const result = spawnSync("node", [approveBin], {
      input: JSON.stringify({
        tool_name: "mcp__supermemory__search_memory",
        tool_input: { query: "company employment full time" },
      }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.systemMessage, "◪ supermemory · recalling: company employment full time");
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    assert.deepEqual(output.hookSpecificOutput.updatedInput, {
      query: "company employment full time",
    });
  });

  test("MCP proxy fails clearly when SessionStart has not authenticated", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const result = spawnSync("node", [proxyBin], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.error.code, -32001);
    assert.match(output.error.message, /Start a new Codex task/);
  });
});

describe("search_hybrid local MCP tool", () => {
  const proxyModule = new URL("../dist/hooks/mcp-proxy.js", import.meta.url).href;

  // Runs the real proxy with fetch replaced, so neither MCP nor REST leaves the process.
  function runProxy(t, messages, searchStatus = 200) {
    const { tmpDir } = setupCodexHome(t);
    const script = `
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/search")) {
          return new Response(JSON.stringify(${searchStatus} === 200 ? {
            results: [
              { id: "c1", chunk: "catch block logs and returns", filepath: "ProcessRun.cs", similarity: 0.71 },
              { id: "m1", memory: "Decision recorded", similarity: 0.65 },
            ],
            total: 2,
            timing: 1,
          } : { error: "limit" }), { status: ${searchStatus}, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search_memory" }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      process.on("exit", () => process.stderr.write("CALLS" + JSON.stringify(calls)));
      await import(${JSON.stringify(proxyModule)});
    `;
    const result = spawnSync("node", ["--input-type=module", "-e", script], {
      input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        SUPERMEMORY_CODEX_API_KEY: "sm_test_hybrid_fixture",
        SUPERMEMORY_API_URL: "https://api.supermemory.ai",
        SUPERMEMORY_API_VERSION: "v5",
      },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stderr.slice(result.stderr.lastIndexOf("CALLS") + 5));
    const output = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { calls, output, tmpDir };
  }

  const hybridCall = (id) => ({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "search_hybrid", arguments: { query: "catch block", namespace: "repo_test" } },
  });

  test("lists search_hybrid with the hosted tools", (t) => {
    const { output } = runProxy(t, [{ jsonrpc: "2.0", id: 3, method: "tools/list" }]);
    assert.deepEqual(output[0].result.tools.map((tool) => tool.name), ["search_memory", "search_hybrid"]);
  });

  test("answers search_hybrid locally with a hybrid REST search", (t) => {
    const { calls, output } = runProxy(t, [hybridCall(4)]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/ns/repo_test/search");
    assert.equal(calls[0].body.searchMode, "hybrid");
    assert.equal(calls[0].body.threshold, 0.6);
    assert.equal(calls[0].body.rerank, "none");
    assert.equal(calls[0].body.rewriteQuery, false);
    assert.equal(output[0].result.isError, false);
    assert.match(output[0].result.content[0].text, /\[chunk 71%\] catch block logs and returns \(ProcessRun\.cs\)/);
    assert.match(output[0].result.content[0].text, /\[memory 65%\] Decision recorded/);
  });

  test("search_hybrid stops calling after a 402", (t) => {
    const first = runProxy(t, [hybridCall(5), hybridCall(6)], 402);
    assert.equal(first.calls.length, 1);
    assert.equal(first.output[0].result.isError, true);
    assert.match(first.output[1].result.content[0].text, /paused after a usage limit/);
    const cooldown = JSON.parse(readFileSync(join(first.tmpDir, ".codex-supermemory", "recall-cooldown.json"), "utf-8"));
    assert.equal(cooldown.status, 402);
  });
});

// ─── flush hook — Stop payload handling ──────────────────────────────────────

describe("flush hook Stop payload", () => {
  const flushBin = fileURLToPath(new URL("../dist/hooks/flush.js", import.meta.url));

  test("exits 0 with no transcript_path", (t) => {
    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({ session_id: "s1", transcript_path: null }),
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 when not configured", (t) => {
    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({ session_id: "s1", cwd: "/tmp" }),
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 on malformed JSON input", (t) => {
    const result = spawnSync("node", [flushBin], {
      input: "not-json",
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("exits 0 without API key even when transcript exists (smoke test)", (t) => {
    const tmpDir = makeTmpDir();
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    const transcriptFile = join(tmpDir, "transcript.jsonl");
    writeFileSync(
      transcriptFile,
      [
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "What is 2+2?" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "assistant_output_text", text: "4" } }),
      ].join("\n")
    );

    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({
        session_id: "s1",
        transcript_path: transcriptFile,
        cwd: tmpDir,
      }),
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });

  test("does not crash when transcript_path points to nonexistent file", (t) => {
    const result = spawnSync("node", [flushBin], {
      input: JSON.stringify({
        session_id: "s1",
        transcript_path: "/nonexistent/path/transcript.jsonl",
      }),
      env: isolatedEnv(t, { SUPERMEMORY_CODEX_API_KEY: "" }),
      encoding: "utf-8",
    });
    assert.equal(result.status, 0);
  });
});

// ─── status skill ───────────────────────────────────────────────────────────

describe("status skill", () => {
  const statusBin = fileURLToPath(new URL("../dist/skills/status.js", import.meta.url));

  // Run a script with a fresh empty $HOME (no config file) and an empty
  // SUPERMEMORY_CODEX_API_KEY so isConfigured() is false. Returns the spawn result.
  function runSkillUnconfigured(t, bin, args) {
    const tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, ".codex"), { recursive: true });
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [bin, ...args], {
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
  }

  function runStatusWithConfig(t, config) {
    const tmpDir = makeTmpDir();
    const codexDir = join(tmpDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, "supermemory.json"), JSON.stringify(config));
    t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
    return spawnSync("node", [statusBin], {
      env: { PATH: process.env.PATH, HOME: tmpDir, USERPROFILE: tmpDir, SUPERMEMORY_CODEX_API_KEY: "" },
      encoding: "utf-8",
    });
  }

  test("status prints disconnected state and exits 0 when no API key", (t) => {
    const result = runSkillUnconfigured(t, statusBin, []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Connected: no/);
    assert.match(result.stdout, /Start a new Codex task/);
  });

  test("status reports auto-recall off when auto recall is disabled", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: false, captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: off/);
  });

  test("status maps legacy enabled auto-recall to direct mode", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: true, captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: direct \(substantive prompts\)/);
  });

  test("status preserves advisory recall mode", (t) => {
    const result = runStatusWithConfig(t, { recallMode: "advisory", captureEveryNTurns: 0 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-recall: advisory/);
  });

  test("status reports turn-stop capture regardless of legacy cadence", (t) => {
    const result = runStatusWithConfig(t, { autoRecallEveryPrompt: false, captureEveryNTurns: 5, autoSaveEveryTurns: 3 });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Auto-capture: after completed turns/);
  });
});

// ─── formatCombinedContext — interleaved memory merging ──────────────────────

describe("formatCombinedContext interleaving", () => {
  // Simulate the formatCombinedContext interleaving logic inline to test without
  // importing the ESM module (which is bundled into CJS by esbuild).
  function interleaveMemories(userMemories, projectMemories, maxMemories) {
    const allMemories = [];
    let ui = 0;
    let pi = 0;
    while (allMemories.length < maxMemories && (ui < userMemories.length || pi < projectMemories.length)) {
      if (ui < userMemories.length) {
        allMemories.push(userMemories[ui++]);
      }
      if (allMemories.length < maxMemories && pi < projectMemories.length) {
        allMemories.push(projectMemories[pi++]);
      }
    }
    return allMemories;
  }

  test("interleaves user and project memories evenly", () => {
    const user = ["u1", "u2", "u3"];
    const project = ["p1", "p2", "p3"];
    const result = interleaveMemories(user, project, 6);
    assert.deepEqual(result, ["u1", "p1", "u2", "p2", "u3", "p3"]);
  });

  test("limits total to maxMemories while preserving both sources", () => {
    const user = ["u1", "u2", "u3", "u4", "u5"];
    const project = ["p1", "p2", "p3", "p4", "p5"];
    const result = interleaveMemories(user, project, 5);
    // Should interleave: u1, p1, u2, p2, u3
    assert.equal(result.length, 5);
    assert.ok(result.some(m => m.startsWith("u")), "must include user memories");
    assert.ok(result.some(m => m.startsWith("p")), "must include project memories");
  });

  test("project memories not dropped when user has many results", () => {
    const user = ["u1", "u2", "u3", "u4", "u5", "u6"];
    const project = ["p1", "p2"];
    const result = interleaveMemories(user, project, 5);
    // Should interleave: u1, p1, u2, p2, u3
    assert.ok(result.includes("p1"), "project memory p1 must be included");
    assert.ok(result.includes("p2"), "project memory p2 must be included");
  });

  test("handles empty project memories", () => {
    const user = ["u1", "u2", "u3"];
    const project = [];
    const result = interleaveMemories(user, project, 5);
    assert.deepEqual(result, ["u1", "u2", "u3"]);
  });

  test("handles empty user memories", () => {
    const user = [];
    const project = ["p1", "p2", "p3"];
    const result = interleaveMemories(user, project, 5);
    assert.deepEqual(result, ["p1", "p2", "p3"]);
  });

  test("handles both empty", () => {
    const result = interleaveMemories([], [], 5);
    assert.deepEqual(result, []);
  });
});

// ─── memory deduplication across canonical and legacy containers ─────────────

describe("memory deduplication", () => {
  function dedupKey(id, text) {
    const normalized = text.toLowerCase().trim();
    if (normalized) return `content:${normalized}`;
    return id ? `id:${id}` : "";
  }

  test("deduplicates by id when available", () => {
    const seen = new Set();
    const memories = [
      { id: "mem-1", memory: "React components" },
      { id: "mem-1", memory: "react components" }, // same id, different casing
      { id: "mem-2", memory: "Vue components" },
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 2, "should deduplicate identical content");
  });

  test("falls back to content-based dedup when id is missing", () => {
    const seen = new Set();
    const memories = [
      { memory: "React components" },
      { memory: "react components" }, // same content, different casing
      { memory: "Vue components" },
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 2, "should deduplicate by lowercased content");
  });

  test("deduplicates legacy copies when ids differ but content matches", () => {
    const seen = new Set();
    const memories = [
      { id: "mem-1", memory: "React components" },
      { id: "mem-2", memory: "React components" }, // different id, same content
    ];

    const result = memories.filter(m => {
      const key = dedupKey(m.id, m.memory);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    assert.equal(result.length, 1, "should keep one logical memory");
  });
});
