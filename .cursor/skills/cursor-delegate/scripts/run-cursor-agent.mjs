#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { loadCursorApiKey } from "./credential-store.mjs";
import {
  loadCursorSdk,
  SDK_RUNTIME_DIRECTORY,
  withCursorSdkRuntimeEntrypoint,
} from "./sdk-runtime.mjs";

const MODEL_ID = "composer-2.5";
const MODEL_PARAMS = [{ id: "fast", value: "true" }];
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 2_000;
const MAX_CAPTURE_CHARS = 12_000;

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = exitCode;
}

function usage(message, exitCode = 2) {
  emit(
    {
      ok: false,
      error: message,
      usage:
        "run-cursor-agent.mjs --workspace <path> (--task <text> | --task-file <path>) [--max-attempts 1..4] [--check]",
    },
    exitCode,
  );
}

function boundedInteger(raw, fallback, minimum, maximum, label) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function compactText(value, maximum = MAX_CAPTURE_CHARS) {
  const text = String(value ?? "").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, maximum)}\n…[truncated ${text.length - maximum} characters]`;
}

function command(workspace, args) {
  try {
    return compactText(
      execFileSync("git", ["-C", workspace, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } catch {
    return "";
  }
}

function gitSnapshot(workspace) {
  return {
    branch: command(workspace, ["branch", "--show-current"]),
    head: command(workspace, ["rev-parse", "HEAD"]),
    status: command(workspace, ["status", "--short"]),
    diffStat: command(workspace, ["diff", "--stat"]),
  };
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    message: compactText(error?.message ?? error, 2_000),
    code: error?.code,
    status: error?.status,
    requestId: error?.requestId,
    operation: error?.operation,
    isRetryable: error?.isRetryable,
  };
}

function shouldRetry(error) {
  if (error?.status === 401 || error?.status === 403) return false;
  if (error?.code === "INVALID_ARGUMENT" || error?.code === "AUTHENTICATION_ERROR") {
    return false;
  }
  return error?.isRetryable !== false;
}

function buildPrompt(task) {
  return `You are the implementation worker for a bounded repository task.

Complete the task directly in the current workspace. Inspect the repository, make the smallest coherent change, run relevant deterministic checks, and repair failures when reasonable.

Hard constraints:
- You are already the delegated worker. Do not invoke cursor-delegate, Cursor SDK delegation, or any nested agent; perform the task directly.
- Preserve all pre-existing user changes and avoid unrelated edits.
- Do not commit, push, create or switch branches, open pull requests, reset, clean, stash, or rewrite Git history.
- Do not read or write outside the workspace.
- Do not access, print, or modify credentials, tokens, keychains, or environment secrets.
- Do not perform deployments, releases, network mutations, or external communication.
- Do not claim a test or manual verification was completed unless you actually performed it.
- If the task requires a forbidden action or an unavailable human decision, stop and report it as a blocker.

Keep the final response compact and use exactly these headings:
STATUS
SUMMARY
FILES_CHANGED
CHECKS
RISKS_OR_BLOCKERS

TASK
${task}`;
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      workspace: { type: "string" },
      task: { type: "string" },
      "task-file": { type: "string" },
      "max-attempts": { type: "string" },
      "base-delay-ms": { type: "string" },
      check: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
} catch (error) {
  usage(error.message);
  process.exit();
}

let maxAttempts;
let baseDelayMs;
try {
  maxAttempts = boundedInteger(
    parsed.values["max-attempts"],
    DEFAULT_MAX_ATTEMPTS,
    1,
    4,
    "--max-attempts",
  );
  baseDelayMs = boundedInteger(
    parsed.values["base-delay-ms"],
    DEFAULT_BASE_DELAY_MS,
    250,
    30_000,
    "--base-delay-ms",
  );
} catch (error) {
  usage(error.message);
  process.exit();
}

if (process.env.CURSOR_DELEGATE_ACTIVE === "1") {
  emit(
    {
      ok: false,
      error: "Nested cursor-delegate invocation is blocked",
      nestedInvocationBlocked: true,
    },
    3,
  );
  process.exit();
}

const credential = loadCursorApiKey();
const apiKey = credential.apiKey;

if (parsed.values.check) {
  try {
    await loadCursorSdk();
    emit({
      ok: true,
      sdk: "@cursor/sdk",
      sdkRuntime: SDK_RUNTIME_DIRECTORY,
      model: MODEL_ID,
      fast: true,
      credentialConfigured: Boolean(apiKey),
      credentialSource: credential.source,
      node: process.version,
    });
  } catch (error) {
    emit(
      {
        ok: false,
        error: "Cursor SDK could not be loaded; run scripts/configure-key.mjs",
        detail: safeError(error),
      },
      1,
    );
  }
  process.exit();
}

process.env.CURSOR_DELEGATE_ACTIVE = "1";

if (!apiKey) {
  emit(
    {
      ok: false,
      error: "Cursor SDK credential is not configured",
      hint:
        "Run scripts/configure-key.mjs once; use --storage file for sandbox-friendly cross-platform storage, or set CURSOR_API_KEY.",
    },
    2,
  );
  process.exit();
}

if (!parsed.values.workspace) {
  usage("--workspace is required");
  process.exit();
}

const workspace = resolve(parsed.values.workspace);
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  usage(`workspace is not a directory: ${workspace}`);
  process.exit();
}

if (parsed.values.task && parsed.values["task-file"]) {
  usage("use either --task or --task-file, not both");
  process.exit();
}

let task = parsed.values.task?.trim();
if (parsed.values["task-file"]) {
  const taskFile = resolve(parsed.values["task-file"]);
  if (!existsSync(taskFile) || !statSync(taskFile).isFile()) {
    usage(`task file does not exist: ${taskFile}`);
    process.exit();
  }
  task = readFileSync(taskFile, "utf8").trim();
}

if (!task) {
  usage("--task or --task-file is required");
  process.exit();
}

const before = gitSnapshot(workspace);
const failures = [];
let finalResult;
let attempts = 0;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  attempts = attempt;
  try {
    // SDK 默认 SQLite 写用户级 stateRoot，宿主沙箱常因此报 unable to open
    // database file。委派是一次性运行，用 OS 临时目录的 JSONL store 更可移植，
    // 也不会在仓库或用户目录留下 agent 会话状态。
    const storeRoot = mkdtempSync(join(tmpdir(), "cursor-delegate-store-"));
    let result;
    try {
      result = await withCursorSdkRuntimeEntrypoint(async () => {
        const { Agent, JsonlLocalAgentStore } = await loadCursorSdk();
        const agent = await Agent.create({
          apiKey,
          model: { id: MODEL_ID, params: MODEL_PARAMS },
          local: {
            cwd: workspace,
            store: new JsonlLocalAgentStore(storeRoot),
            sandboxOptions: { enabled: true },
          },
        });
        try {
          const run = await agent.send(buildPrompt(task));
          return await run.wait();
        } finally {
          await agent[Symbol.asyncDispose]?.();
        }
      });
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }

    if (result.status !== "finished") {
      const runError = new Error(
        `Cursor run ended with status ${result.status}: ${result.result ?? "no result"}`,
      );
      runError.code = "CURSOR_RUN_NOT_FINISHED";
      throw runError;
    }

    finalResult = result;
    break;
  } catch (error) {
    failures.push({ attempt, ...safeError(error) });
    if (attempt >= maxAttempts || !shouldRetry(error)) break;

    const delayMs = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
    process.stderr.write(
      `Cursor attempt ${attempt}/${maxAttempts} failed; retrying in ${delayMs}ms\n`,
    );
    await sleep(delayMs);
  }
}

const after = gitSnapshot(workspace);
const git = {
  branchBefore: before.branch,
  branchAfter: after.branch,
  branchChanged: before.branch !== after.branch,
  headBefore: before.head,
  headAfter: after.head,
  historyChanged: before.head !== after.head,
  status: after.status,
  diffStat: after.diffStat,
};

if (!finalResult) {
  emit(
    {
      ok: false,
      model: MODEL_ID,
      fast: true,
      sandboxEnabled: true,
      attempts,
      failures,
      git,
      fallbackUsed: false,
    },
    1,
  );
  process.exit();
}

emit({
  ok: true,
  model: finalResult.model ?? { id: MODEL_ID, params: MODEL_PARAMS },
  fast: true,
  sandboxEnabled: true,
  attempts,
  status: finalResult.status,
  result: compactText(finalResult.result),
  durationMs: finalResult.durationMs,
  usage: finalResult.usage,
  git,
  fallbackUsed: false,
});
