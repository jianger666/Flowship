/**
 * computeWorktreeFingerprint 集成测试（对真实临时 git 仓）
 *
 * 背景：V0.11.x 把指纹从「sh -c 跑多行 POSIX 脚本」重写成纯 Node execFile git
 * （Windows 没有 sh、旧实现在 Windows 静默失效）。本测试锁语义不回归：
 * 干净仓稳定、tracked 改动 / untracked 新增 / untracked 内容变化都要引起指纹变化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-fingerprint-it-${Date.now()}`);
process.env.FE_AI_FLOW_DATA_DIR = path.join(TMP_ROOT, "data");

import { computeWorktreeFingerprint } from "@/lib/server/action-checks";

const REPO = path.join(TMP_ROOT, "repo");

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

beforeAll(async () => {
  await fs.mkdir(REPO, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "t");
  await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
  await fs.writeFile(path.join(REPO, ".gitignore"), "ignored.txt\n");
  git("add", "-A");
  git("commit", "-m", "init");
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("computeWorktreeFingerprint 真 git 集成", () => {
  it("干净工作区：指纹非空且稳定（连算两次一致）", async () => {
    const a = await computeWorktreeFingerprint(REPO);
    const b = await computeWorktreeFingerprint(REPO);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("tracked 文件改动 → 指纹变化、还原后回到基线", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    await fs.writeFile(path.join(REPO, "a.txt"), "changed\n");
    expect(await computeWorktreeFingerprint(REPO)).not.toBe(baseline);
    await fs.writeFile(path.join(REPO, "a.txt"), "hello\n");
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
  });

  it("新增 untracked 文件 → 指纹变化；内容再变 → 指纹继续变化", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    const newFile = path.join(REPO, "b.txt");
    await fs.writeFile(newFile, "v1\n");
    const withUntracked = await computeWorktreeFingerprint(REPO);
    expect(withUntracked).not.toBe(baseline);
    // 路径集不变、只有内容变——靠 hash-object 部分才能感知（status hash 感知不到）
    await fs.writeFile(newFile, "v2\n");
    expect(await computeWorktreeFingerprint(REPO)).not.toBe(withUntracked);
    await fs.rm(newFile);
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
  });

  it("gitignore 的文件不进指纹", async () => {
    const baseline = await computeWorktreeFingerprint(REPO);
    await fs.writeFile(path.join(REPO, "ignored.txt"), "noise\n");
    expect(await computeWorktreeFingerprint(REPO)).toBe(baseline);
    await fs.rm(path.join(REPO, "ignored.txt"));
  });

  it("非 git 目录 → null（无法比对、不拦）", async () => {
    const plainDir = path.join(TMP_ROOT, "not-a-repo");
    await fs.mkdir(plainDir, { recursive: true });
    expect(await computeWorktreeFingerprint(plainDir)).toBeNull();
  });
});
