/**
 * worktree-deps 纯 IO 工具单测：monorepo workspace 展开 / 锁文件漂移 / .bin shim 改写 / 初始化命令执行。
 * 不碰 git、不碰 task 状态，全在临时目录里跑。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTaskkillArgs,
  detectLockfileDrift,
  discoverDepDirs,
  expandWorkspaceDirs,
  parsePnpmWorkspaceYaml,
  readWorkspacePatterns,
  rewriteBinShimPaths,
  runSetupCommand,
  summarizeDepDirs,
} from "@/lib/server/worktree-deps";

const TMP = path.join(os.tmpdir(), `fe-worktree-deps-${Date.now()}`);
let n = 0;
const mk = async (): Promise<string> => {
  const d = path.join(TMP, `c${++n}`);
  await fs.mkdir(d, { recursive: true });
  return d;
};
const write = async (file: string, text = ""): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

beforeAll(async () => {
  await fs.mkdir(TMP, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("parsePnpmWorkspaceYaml", () => {
  it("块列表 / 引号 / 注释", () => {
    const yaml = [
      "# 注释",
      "packages:",
      "  # 子包",
      "  - 'apps/*'",
      '  - "packages/**"  # 行尾注释',
      "  - tools/cli",
      "",
      "catalog:",
      "  react: ^18",
    ].join("\n");
    expect(parsePnpmWorkspaceYaml(yaml)).toEqual([
      "apps/*",
      "packages/**",
      "tools/cli",
    ]);
  });

  it("行内数组", () => {
    expect(parsePnpmWorkspaceYaml("packages: ['a/*', \"b\"]\n")).toEqual([
      "a/*",
      "b",
    ]);
  });

  it("没有 packages 键 → 空", () => {
    expect(parsePnpmWorkspaceYaml("catalog:\n  a: 1\n")).toEqual([]);
  });
});

describe("readWorkspacePatterns", () => {
  it("package.json workspaces 数组 / {packages} 对象 / pnpm / lerna 合并去重，丢弃否定与越界", async () => {
    const repo = await mk();
    await write(
      path.join(repo, "package.json"),
      JSON.stringify({
        workspaces: { packages: ["apps/*", "!apps/legacy", "../evil", "/abs"] },
      }),
    );
    await write(
      path.join(repo, "pnpm-workspace.yaml"),
      "packages:\n  - ./apps/*\n  - libs/*\n",
    );
    await write(
      path.join(repo, "lerna.json"),
      JSON.stringify({ packages: ["libs/*", "tools/"] }),
    );
    expect(await readWorkspacePatterns(repo)).toEqual([
      "apps/*",
      "libs/*",
      "tools",
    ]);
  });

  it("非 monorepo / 损坏 package.json → 空", async () => {
    const repo = await mk();
    await write(path.join(repo, "package.json"), "{ not json");
    expect(await readWorkspacePatterns(repo)).toEqual([]);
  });
});

describe("expandWorkspaceDirs / discoverDepDirs", () => {
  it("`apps/**` + `packages/*` 只展开含 package.json 的目录、不进 node_modules / 点目录", async () => {
    const repo = await mk();
    await write(path.join(repo, "package.json"), "{}");
    await write(path.join(repo, "apps/a/package.json"), "{}");
    await write(path.join(repo, "apps/group/b/package.json"), "{}"); // ** 深一层
    await write(path.join(repo, "apps/no-pkg/readme.md"), "x"); // 无 package.json
    await write(path.join(repo, "apps/a/node_modules/dep/package.json"), "{}"); // 不进
    await write(path.join(repo, "apps/.hidden/package.json"), "{}"); // 点目录不进
    await write(path.join(repo, "packages/p/package.json"), "{}");
    await write(path.join(repo, "other/x/package.json"), "{}"); // 不在 workspace 内
    expect(
      await expandWorkspaceDirs(repo, ["apps/**", "packages/*"]),
    ).toEqual(["apps/a", "apps/group/b", "packages/p"]);
  });

  it("discoverDepDirs：根目录白名单在前 + 子包 node_modules（只算真实存在的）", async () => {
    const repo = await mk();
    await write(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
    );
    await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(repo, "vendor"), { recursive: true });
    await write(path.join(repo, "apps/web/package.json"), "{}");
    await fs.mkdir(path.join(repo, "apps/web/node_modules"), { recursive: true });
    await write(path.join(repo, "apps/api/package.json"), "{}"); // 没装子包依赖
    await write(path.join(repo, "packages/ui/package.json"), "{}");
    await fs.mkdir(path.join(repo, "packages/ui/node_modules"), {
      recursive: true,
    });
    expect(await discoverDepDirs(repo)).toEqual([
      "node_modules",
      "vendor",
      "apps/web/node_modules",
      "packages/ui/node_modules",
    ]);
  });

  it("非 monorepo 只返根目录白名单；.venv 绝不在内", async () => {
    const repo = await mk();
    await write(path.join(repo, "package.json"), "{}");
    await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(repo, ".venv"), { recursive: true });
    expect(await discoverDepDirs(repo)).toEqual(["node_modules"]);
  });

  it("子包 node_modules 数量封顶 64", async () => {
    const repo = await mk();
    await write(
      path.join(repo, "package.json"),
      JSON.stringify({ workspaces: ["pkgs/*"] }),
    );
    for (let i = 0; i < 80; i++) {
      const p = path.join(repo, "pkgs", `p${String(i).padStart(2, "0")}`);
      await write(path.join(p, "package.json"), "{}");
      await fs.mkdir(path.join(p, "node_modules"), { recursive: true });
    }
    const dirs = await discoverDepDirs(repo);
    expect(dirs).toHaveLength(64);
  });
});

describe("summarizeDepDirs", () => {
  it("根目录按名字、子包合并计数", () => {
    expect(
      summarizeDepDirs([
        "node_modules",
        "vendor",
        "apps/a/node_modules",
        "apps/b/node_modules",
      ]),
    ).toBe("node_modules + vendor + 子包 node_modules ×2");
    expect(summarizeDepDirs(["node_modules"])).toBe("node_modules");
  });
});

describe("detectLockfileDrift", () => {
  it("两边都有且内容不同才算漂移；一致 / 单边缺失都不算", async () => {
    const repo = await mk();
    const work = await mk();
    await write(path.join(repo, "yarn.lock"), "a\n");
    await write(path.join(work, "yarn.lock"), "b\n"); // 同长度不同内容
    await write(path.join(repo, "pnpm-lock.yaml"), "same\n");
    await write(path.join(work, "pnpm-lock.yaml"), "same\n");
    await write(path.join(repo, "package-lock.json"), "only-repo\n"); // 单边
    await write(path.join(work, "composer.lock"), "only-work\n"); // 单边
    expect(await detectLockfileDrift(repo, work)).toEqual(["yarn.lock"]);
  });

  it("长度不同直接判漂移", async () => {
    const repo = await mk();
    const work = await mk();
    await write(path.join(repo, "yarn.lock"), "aaaa\n");
    await write(path.join(work, "yarn.lock"), "a\n");
    expect(await detectLockfileDrift(repo, work)).toEqual(["yarn.lock"]);
  });
});

describe("rewriteBinShimPaths", () => {
  it("把 .bin 文本 shim 里的原仓绝对路径改成 worktree 路径；软链 / 二进制 / 边界不误伤", async () => {
    const root = await mk();
    const repo = path.join(root, "repo");
    const work = path.join(root, "wt");
    const nm = path.join(work, "node_modules");
    const bin = path.join(nm, ".bin");
    await fs.mkdir(bin, { recursive: true });
    const shim = [
      "#!/bin/sh",
      `export NODE_PATH="${repo}/node_modules/.pnpm/next/node_modules:${repo}/node_modules/.pnpm/b/node_modules"`,
      `# 相邻同前缀路径不能误伤：${repo}2/keep`,
      'exec node "$basedir/../next/dist/bin/next" "$@"',
    ].join("\n");
    await fs.writeFile(path.join(bin, "next"), shim, { mode: 0o755 });
    // 软链（npm / yarn 的 .bin）：不动
    await fs.writeFile(path.join(nm, "real.js"), "x");
    await fs.symlink("../real.js", path.join(bin, "link"));
    // 二进制：不动
    const binary = Buffer.concat([
      Buffer.from(repo),
      Buffer.from([0, 1, 2]),
    ]);
    await fs.writeFile(path.join(bin, "blob"), binary);

    const changed = await rewriteBinShimPaths(nm, [repo, repo], work);
    expect(changed).toBe(1);
    const out = await fs.readFile(path.join(bin, "next"), "utf8");
    expect(out).toContain(`NODE_PATH="${work}/node_modules/.pnpm/next/node_modules:${work}/node_modules/.pnpm/b/node_modules"`);
    expect(out).toContain(`${repo}2/keep`); // 边界：repo2 不是 repo
    expect((await fs.stat(path.join(bin, "next"))).mode & 0o111).not.toBe(0); // 保留可执行位
    expect((await fs.lstat(path.join(bin, "link"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(bin, "blob"))).toEqual(binary);
  });

  it("没有 .bin / 路径相同 → 0", async () => {
    const root = await mk();
    expect(await rewriteBinShimPaths(path.join(root, "nope"), ["/a"], "/b")).toBe(0);
    expect(await rewriteBinShimPaths(root, ["/a"], "/a")).toBe(0);
  });
});

describe("runSetupCommand", () => {
  const nodeCmd = (code: string): string =>
    `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;

  it("成功：cwd / ROOT_WORKTREE_PATH 正确，宿主注入变量与 GitLab token 被摘掉", async () => {
    const cwd = await mk();
    const prev = {
      PORT: process.env.PORT,
      FLOWSHIP_GITLAB_TOKEN: process.env.FLOWSHIP_GITLAB_TOKEN,
    };
    process.env.PORT = "8876";
    process.env.FLOWSHIP_GITLAB_TOKEN = "glpat-secret";
    try {
      const res = await runSetupCommand(
        nodeCmd(
          "require('fs').writeFileSync('out.json', JSON.stringify({cwd: process.cwd(), root: process.env.ROOT_WORKTREE_PATH, port: process.env.PORT ?? null, token: process.env.FLOWSHIP_GITLAB_TOKEN ?? null}))",
        ),
        cwd,
        { rootWorktreePath: "/orig/repo", timeoutMs: 30_000 },
      );
      expect(res.ok).toBe(true);
      expect(res.code).toBe(0);
      const out = JSON.parse(await fs.readFile(path.join(cwd, "out.json"), "utf8"));
      expect(await fs.realpath(out.cwd)).toBe(await fs.realpath(cwd));
      expect(out.root).toBe("/orig/repo");
      expect(out.port).toBeNull();
      expect(out.token).toBeNull();
    } finally {
      if (prev.PORT === undefined) delete process.env.PORT;
      else process.env.PORT = prev.PORT;
      if (prev.FLOWSHIP_GITLAB_TOKEN === undefined) {
        delete process.env.FLOWSHIP_GITLAB_TOKEN;
      } else process.env.FLOWSHIP_GITLAB_TOKEN = prev.FLOWSHIP_GITLAB_TOKEN;
    }
  });

  it("失败：返回退出码与输出末尾", async () => {
    const cwd = await mk();
    const res = await runSetupCommand(
      nodeCmd("console.error('boom-xyz'); process.exit(3)"),
      cwd,
      { rootWorktreePath: cwd, timeoutMs: 30_000 },
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe(3);
    expect(res.tail).toContain("boom-xyz");
  });

  it("超时：整组杀掉、timedOut=true", async () => {
    const cwd = await mk();
    const started = Date.now();
    const res = await runSetupCommand(nodeCmd("setInterval(()=>{},1000)"), cwd, {
      rootWorktreePath: cwd,
      timeoutMs: 400,
    });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("abort：aborted=true、进程被杀", async () => {
    const cwd = await mk();
    const ac = new AbortController();
    const p = runSetupCommand(nodeCmd("setInterval(()=>{},1000)"), cwd, {
      rootWorktreePath: cwd,
      timeoutMs: 60_000,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 200);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.ok).toBe(false);
  });
});

/**
 * F5-01：Windows 分支的超时 / 中止语义。
 * 只能在 mac / linux 上用注入的 `platform` + `killWinTree` 覆盖「该调用什么、等多久」的逻辑——
 * 真正的 `taskkill /T /F` 与 cmd.exe 孙进程占管道行为**未在 Windows 真机验证**。
 */
describe("runSetupCommand · Windows 分支（注入 platform / killWinTree）", () => {
  const nodeCmd = (code: string): string =>
    `"${process.execPath}" -e "${code.replace(/"/g, '\\"')}"`;
  /** 起一个把 stdout/stderr 管道原样继承给孙进程的命令：父进程被杀后孙进程仍占着管道 */
  const grandchildHoldsPipeCmd = nodeCmd(
    "const {spawn}=require('child_process'); const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); require('fs').writeFileSync('gpid.txt',String(g.pid)); setInterval(()=>{},1000)",
  );
  const killPid = (pid: number): void => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
  };
  const readGrandchildPid = async (cwd: string): Promise<number | null> => {
    try {
      return Number(await fs.readFile(path.join(cwd, "gpid.txt"), "utf8")) || null;
    } catch {
      return null;
    }
  };

  it("超时：走注入的 killWinTree（拿到子进程 pid）；孙进程占着管道也在宽限期后按「已终止」结算", async () => {
    const cwd = await mk();
    const killed: number[] = [];
    const started = Date.now();
    try {
      const res = await runSetupCommand(grandchildHoldsPipeCmd, cwd, {
        rootWorktreePath: cwd,
        timeoutMs: 600,
        platform: "win32",
        settleGraceMs: 400,
        // 只杀直接子进程（模拟 child.kill() 杀不到孙进程的场景）：孙进程继续占着管道、close 不会来
        killWinTree: (pid) => {
          killed.push(pid);
          killPid(pid);
        },
      });
      expect(killed).toHaveLength(1);
      expect(res.timedOut).toBe(true);
      expect(res.aborted).toBe(false);
      expect(res.ok).toBe(false);
      expect(res.code).toBeNull();
      // 600ms 超时 + 400ms 宽限；给负载留足余量，但必须远小于「等孙进程自己退出」
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      const g = await readGrandchildPid(cwd);
      if (g) killPid(g);
    }
  }, 30_000);

  it("abort：同样走 killWinTree + 宽限结算（aborted=true）", async () => {
    const cwd = await mk();
    const ac = new AbortController();
    const killed: number[] = [];
    try {
      const p = runSetupCommand(grandchildHoldsPipeCmd, cwd, {
        rootWorktreePath: cwd,
        timeoutMs: 60_000,
        signal: ac.signal,
        platform: "win32",
        settleGraceMs: 400,
        killWinTree: (pid) => {
          killed.push(pid);
          killPid(pid);
        },
      });
      // 等孙进程真起来（pid 文件出现）再中止
      const deadline = Date.now() + 10_000;
      while (!(await readGrandchildPid(cwd)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      ac.abort();
      const res = await p;
      expect(killed).toHaveLength(1);
      expect(res.aborted).toBe(true);
      expect(res.timedOut).toBe(false);
      expect(res.ok).toBe(false);
    } finally {
      const g = await readGrandchildPid(cwd);
      if (g) killPid(g);
    }
  }, 30_000);

  it("killWinTree 失败（taskkill 不存在 / 进程已不在）→ 退化为直接 child.kill，不必干等宽限期", async () => {
    const cwd = await mk();
    const started = Date.now();
    const res = await runSetupCommand(nodeCmd("setInterval(()=>{},1000)"), cwd, {
      rootWorktreePath: cwd,
      timeoutMs: 400,
      platform: "win32",
      // 宽限期给得很长：能在几秒内返回只可能是回退的 child.kill 让 close 正常到达
      settleGraceMs: 25_000,
      killWinTree: async () => {
        throw new Error("taskkill 不可用");
      },
    });
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it("正常结束不受影响：不调 killWinTree、不等宽限期", async () => {
    const cwd = await mk();
    let called = 0;
    const res = await runSetupCommand(nodeCmd("process.exit(0)"), cwd, {
      rootWorktreePath: cwd,
      timeoutMs: 30_000,
      platform: "win32",
      settleGraceMs: 25_000,
      killWinTree: () => {
        called++;
      },
    });
    expect(res.ok).toBe(true);
    expect(res.code).toBe(0);
    expect(called).toBe(0);
  });

  it("默认的 Windows 杀法是 taskkill /PID <pid> /T /F（与 wk-gate / preview-manager 一致）", () => {
    expect(buildTaskkillArgs(4321)).toEqual(["/PID", "4321", "/T", "/F"]);
  });
});
