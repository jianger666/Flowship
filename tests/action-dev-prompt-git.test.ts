/**
 * prompts/action-dev.md 直推联调的 git 流程契约（review #10）
 *
 * 任务工作区是 `git worktree`、与用户主仓共享分支 refs：在里面 `git checkout -B "$DEV" "origin/$DEV"`
 * 会把用户主仓同名本地 dev 分支一并重置成 origin、并在主仓留下「已暂存的反向 diff」，随手 commit 就会
 * 把同事已合入 dev 的提交回滚掉。所以直推必须走 detached HEAD：
 *   fetch → checkout --detach origin/$DEV → merge --no-ff $FEATURE → push origin HEAD:refs/heads/$DEV → checkout $FEATURE
 *
 * 这里是 prompt 文本契约（agent 照文本执行、文本一改回去就是回归）+ 用真 git 在 worktree 里跑一遍
 * 文本里的命令序列，证明它确实不会动主仓的本地 dev 分支。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const read = (name: string): string => readFileSync(path.join(PROMPTS_DIR, name), "utf8");

/** 抽出所有 ``` 围栏代码块（带语言标记的首行去掉） */
const fencedBlocks = (text: string): string[] => {
  const blocks: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  return blocks;
};

const dev = read("action-dev.md");
const devBlocks = fencedBlocks(dev);

/** 「流程 A」直推脚本块 / push 块 */
const directScript = devBlocks.find((b) => b.includes('git merge --no-ff "$FEATURE"'));
const directPush = devBlocks.find((b) => b.includes("git push origin") && b.includes("pushed origin/$DEV"));

describe("action-dev.md 直推：detached HEAD、不碰本地 dev 分支（review #10）", () => {
  it("找得到直推脚本块与 push 块（文档结构没被改乱）", () => {
    expect(directScript).toBeDefined();
    expect(directPush).toBeDefined();
  });

  it("直推脚本：fetch → checkout --detach origin/$DEV → merge feature，且 detach 在 merge 之前", () => {
    const s = directScript!;
    const iFetch = s.indexOf('git fetch origin "$DEV"');
    const iDetach = s.indexOf('git checkout --detach "origin/$DEV"');
    const iMerge = s.indexOf('git merge --no-ff "$FEATURE"');
    expect(iFetch).toBeGreaterThanOrEqual(0);
    expect(iDetach).toBeGreaterThan(iFetch);
    expect(iMerge).toBeGreaterThan(iDetach);
  });

  it("所有代码块里没有任何会创建 / 重置 / 移动本地 $DEV 分支的命令", () => {
    const mutating = /git\s+(?:checkout\s+-[Bb]|branch\s+-[fFmM]|reset\b|update-ref\b)[^\n]*\$\{?DEV\b/;
    for (const block of devBlocks) {
      expect(block).not.toMatch(mutating);
      // 旧写法的两个特征串
      expect(block).not.toContain('checkout -B "$DEV"');
      expect(block).not.toContain('"$DEV":"$DEV"');
    }
  });

  it("正文里提到 `checkout -B \"$DEV\"` 的每一行都是在「禁止」它（铁律 / 反例 / 注释）", () => {
    const lines = dev.split("\n").filter((l) => l.includes('checkout -B "$DEV"'));
    expect(lines.length).toBeGreaterThan(0); // 铁律 + 反例 + 脚本注释至少要讲清为什么不能
    for (const l of lines) {
      expect(l).toMatch(/不许|不要|绝不|❌|⚠️|不能/);
    }
  });

  it("push 块：push 的是 HEAD、目标写全名 refs/heads/$DEV，之后 checkout 回 $FEATURE", () => {
    const p = directPush!;
    expect(p).toContain('git push origin HEAD:"refs/heads/$DEV"');
    expect(p).not.toMatch(/--force|\s-f\s|--force-with-lease/);
    // push 被拒与成功两条路径都要回 feature（至少 2 次 checkout "$FEATURE"）
    expect(p.match(/git checkout "\$FEATURE"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // HEAD_SHA 要在切回 feature 之前取（否则取到的是 feature 的 sha）
    expect(p.indexOf("HEAD_SHA=$(git rev-parse HEAD)")).toBeLessThan(
      p.lastIndexOf('git checkout "$FEATURE"'),
    );
  });

  it("冲突处理：直推 AI 解 = 解标记 → add → commit → push HEAD:refs/heads/$DEV → 回 $FEATURE；不再说「本地 dev 分支」", () => {
    const line = dev.split("\n").find((l) => l.includes("直推模式 + 选 AI 解"));
    expect(line).toBeDefined();
    const iCommit = line!.indexOf("git commit --no-edit");
    const iPush = line!.indexOf('git push origin HEAD:"refs/heads/$DEV"');
    const iBack = line!.indexOf('git checkout "$FEATURE"');
    expect(iCommit).toBeGreaterThan(0);
    expect(iPush).toBeGreaterThan(iCommit);
    expect(iBack).toBeGreaterThan(iPush);
    expect(line).toContain("detached HEAD");
    expect(line).not.toContain('"$DEV":"$DEV"');
    // 不能再让 agent「已在本地 dev 分支上」操作（提到「别新建本地 dev 分支」是禁止语境、允许）
    expect(line).not.toContain("已在本地 dev 分支");
    expect(line).toContain("别新建本地 dev 分支");
    // 选自己解：abort → 回 feature
    const manual = dev.split("\n").find((l) => l.includes("选自己解"));
    expect(manual).toContain("git merge --abort");
    expect(manual).toContain('git checkout "$FEATURE"');
  });

  it("不引入 `&&` 命令链（PowerShell 5.x 不支持）：代码块里没有、正文里也没有 git … && git …", () => {
    for (const block of devBlocks) expect(block).not.toContain("&&");
    expect(dev).not.toMatch(/git[^\n`]*&&\s*git/);
  });

  it("提 PR 模式的 __conflict 一次性分支保持原样（agent 自建的 feature__conflict、不是用户的 dev 分支）", () => {
    expect(dev).toContain('git checkout -B "${FEATURE}__conflict" "origin/$DEV"');
  });

  it("全部 prompts/*.md：凡 `checkout -B` 只允许落在 agent 自建的 __conflict 分支上、或出现在禁止语境里", () => {
    for (const f of readdirSync(PROMPTS_DIR).filter((n) => n.endsWith(".md"))) {
      const text = read(f);
      for (const line of text.split("\n")) {
        // 只看「checkout -B <目标>」这种带目标的用法；纯文字提到 `checkout -B`（后面直接是反引号）不算
        const m = line.match(/checkout\s+-B\s+("[^"]+"|[^\s`]+)/);
        if (!m) continue;
        const ok =
          /CONFLICT|__conflict/.test(m[1]) || /不许|不要|绝不|❌|不能/.test(line);
        expect(ok, `${f}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("action-ship.md 的 `checkout -B \"$CONFLICT\"` 目标确实是 ${FEATURE}__conflict（一次性、可重置）", () => {
    const ship = read("action-ship.md");
    expect(ship).toContain('CONFLICT="${FEATURE}__conflict"');
    expect(ship).toContain('git checkout -B "$CONFLICT" "origin/$TARGET"');
  });

  it("运行时 [DEV_PUSH_MODE] 指令（task-prompts.ts）与 prompt 一致：不再叫 agent「切本地 dev」", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/server/task-prompts.ts"), "utf8");
    expect(src).not.toContain("本地基于 origin/dev 切 dev");
    expect(src).not.toContain("在本地 dev 上 AI 智能解");
    expect(src).toContain("git checkout --detach origin/<dev>");
  });
});

describe("按 prompt 里的命令序列在真 worktree 里跑一遍：主仓本地 dev 分支纹丝不动", () => {
  const ROOT = mkdtempSync(path.join(os.tmpdir(), "fs-dev-prompt-"));
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

  /** origin(bare) + 主仓 clone（用户的主仓、本地 develop 停在旧提交）+ 同事后来推到 origin/develop 的新提交 + 任务 worktree */
  const setup = (name: string) => {
    const base = path.join(ROOT, name);
    const origin = path.join(base, "origin.git");
    const main = path.join(base, "main");
    const colleague = path.join(base, "colleague");
    const wt = path.join(base, "task-wt");
    execFileSync("git", ["init", "--bare", "-b", "develop", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", origin, main], { stdio: "pipe" });
    git(main, "symbolic-ref", "HEAD", "refs/heads/develop");
    writeFileSync(path.join(main, "base.txt"), "base\n");
    git(main, "add", "-A");
    git(main, "commit", "-m", "base");
    git(main, "push", "-u", "origin", "develop");
    // 用户主仓本地 develop 停在 base；同事随后向 origin/develop 推了一个新提交
    execFileSync("git", ["clone", origin, colleague], { stdio: "pipe" });
    git(colleague, "checkout", "develop");
    writeFileSync(path.join(colleague, "colleague.txt"), "from colleague\n");
    git(colleague, "add", "-A");
    git(colleague, "commit", "-m", "colleague work");
    git(colleague, "push", "origin", "develop");
    // 任务 worktree：feature 分支（从 base 起）+ 一个 feature 提交
    git(main, "worktree", "add", "-b", "feature/x", wt, "develop");
    writeFileSync(path.join(wt, "feature.txt"), "feature work\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "feature work");
    return { origin, main, wt };
  };

  it("detached 流程：origin/develop 带上 feature、主仓本地 develop / index / 工作区都没变、worktree 回到 feature", () => {
    const { origin, main, wt } = setup("detach-ok");
    const localDevBefore = git(main, "rev-parse", "develop");
    const statusBefore = git(main, "status", "--porcelain");

    // —— 以下就是 action-dev.md 流程 A 的命令序列（DEV / FEATURE 取值同文档）——
    const DEV = "develop";
    const FEATURE = git(wt, "rev-parse", "--abbrev-ref", "HEAD");
    expect(FEATURE).toBe("feature/x");
    git(wt, "fetch", "origin", DEV);
    git(wt, "checkout", "--detach", `origin/${DEV}`);
    git(wt, "merge", "--no-ff", FEATURE, "-m", `merge ${FEATURE} into ${DEV}（联调）`);
    git(wt, "push", "origin", `HEAD:refs/heads/${DEV}`);
    const headSha = git(wt, "rev-parse", "HEAD");
    git(wt, "checkout", FEATURE);

    // 远程 develop = 同事提交 + feature 合入（merge commit）
    expect(git(origin, "rev-parse", DEV)).toBe(headSha);
    const files = git(origin, "ls-tree", "-r", "--name-only", DEV).split("\n");
    expect(files).toEqual(expect.arrayContaining(["base.txt", "colleague.txt", "feature.txt"]));
    // worktree 回到 feature 分支（不是 detached）
    expect(git(wt, "branch", "--show-current")).toBe(FEATURE);
    // 主仓：本地 develop 没被重置、没有「已暂存的反向 diff」
    expect(git(main, "rev-parse", "develop")).toBe(localDevBefore);
    expect(git(main, "status", "--porcelain")).toBe(statusBefore);
    expect(git(main, "diff", "--cached", "--stat")).toBe("");
  });

  it("对照（旧写法）：主仓正检出 develop 时，worktree 里 checkout -B develop origin/develop 会重置共享的 develop 并让主仓出现反向暂存 diff", () => {
    const { main, wt } = setup("legacy-bad");
    // 用户主仓就停在 develop 上（最常见）、本地 develop 比 origin 旧
    git(main, "checkout", "develop");
    expect(git(main, "status", "--porcelain")).toBe("");
    git(wt, "fetch", "origin", "develop");
    let accepted = true;
    try {
      git(wt, "checkout", "-B", "develop", "origin/develop");
    } catch {
      // 较新的 git 可能直接拒绝「分支已在别处检出」——那旧写法就是失败而不是破坏，下面无需再断言
      accepted = false;
    }
    if (accepted) {
      // review #10 的现场：主仓 develop 被改写、主仓 index / 工作区还停在旧版本 → 「已暂存的 colleague.txt 删除」
      expect(git(main, "rev-parse", "develop")).toBe(git(wt, "rev-parse", "origin/develop"));
      expect(git(main, "status", "--porcelain")).toMatch(/^D\s+colleague\.txt/m);
    }
  });

  it("冲突分支：detached 上 merge 冲突 → 解 → commit → push → 回 feature；自己解则 abort → 回 feature", () => {
    const base = path.join(ROOT, "conflict");
    const origin = path.join(base, "origin.git");
    const main = path.join(base, "main");
    const colleague = path.join(base, "colleague");
    const wt = path.join(base, "task-wt");
    execFileSync("git", ["init", "--bare", "-b", "develop", origin], { stdio: "pipe" });
    execFileSync("git", ["clone", origin, main], { stdio: "pipe" });
    git(main, "symbolic-ref", "HEAD", "refs/heads/develop");
    writeFileSync(path.join(main, "shared.txt"), "base\n");
    git(main, "add", "-A");
    git(main, "commit", "-m", "base");
    git(main, "push", "-u", "origin", "develop");
    execFileSync("git", ["clone", origin, colleague], { stdio: "pipe" });
    git(colleague, "checkout", "develop");
    writeFileSync(path.join(colleague, "shared.txt"), "colleague\n");
    git(colleague, "commit", "-am", "colleague edit");
    git(colleague, "push", "origin", "develop");
    git(main, "worktree", "add", "-b", "feature/y", wt, "develop");
    writeFileSync(path.join(wt, "shared.txt"), "feature\n");
    git(wt, "commit", "-am", "feature edit");
    const localDevBefore = git(main, "rev-parse", "develop");

    git(wt, "fetch", "origin", "develop");
    git(wt, "checkout", "--detach", "origin/develop");
    expect(() => git(wt, "merge", "--no-ff", "feature/y", "-m", "merge")).toThrow();
    // 选自己解：abort + 回 feature
    git(wt, "merge", "--abort");
    git(wt, "checkout", "feature/y");
    expect(git(wt, "branch", "--show-current")).toBe("feature/y");
    expect(git(wt, "status", "--porcelain")).toBe("");

    // 选 AI 解：再来一遍、就地解冲突标记 → add → commit → push → 回 feature
    git(wt, "checkout", "--detach", "origin/develop");
    expect(() => git(wt, "merge", "--no-ff", "feature/y", "-m", "merge")).toThrow();
    writeFileSync(path.join(wt, "shared.txt"), "colleague+feature\n");
    expect(() => git(wt, "diff", "--check")).not.toThrow();
    git(wt, "add", "-A");
    git(wt, "commit", "--no-edit");
    git(wt, "push", "origin", "HEAD:refs/heads/develop");
    const pushed = git(wt, "rev-parse", "HEAD");
    git(wt, "checkout", "feature/y");

    expect(git(origin, "rev-parse", "develop")).toBe(pushed);
    expect(git(origin, "show", "develop:shared.txt")).toBe("colleague+feature");
    expect(git(wt, "branch", "--show-current")).toBe("feature/y");
    expect(git(main, "rev-parse", "develop")).toBe(localDevBefore);
  });
});
