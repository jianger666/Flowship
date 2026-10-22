/**
 * vitest 环境隔离（2026-10-09 事故：agent shell 继承了正式数据目录，跑测试误标了别的聊天「已中断」）。
 *
 * 分四层：
 *   A. applyHermeticEnv / assertEnvNotAppData 的纯逻辑；
 *   B. 当前这个测试进程的实际环境（setupFiles 真的生效了）；
 *   C. 接线契约（配置里有 setupFiles、setup 文件接了 beforeEach 断言）；
 *   D. 端到端：用「继承了桌面包数据目录」的环境真拉起一个 vitest，检查假的桌面包数据没被动过——
 *      事故的根因是环境传递 + 模块加载时钉死 DATA_DIR，单元测试看不见，只能真跑一遍。
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { isAppUserDataPath } from "@/lib/server/app-data-dir";
import { HOST_INJECTED_ENV_KEYS } from "@/lib/server/host-env";
import { isValidMetaShape } from "@/lib/server/task-fs-core";
import {
  applyHermeticEnv,
  applyHermeticGitEnv,
  assertEnvNotAppData,
  HERMETIC_GIT_IDENTITY,
  type EnvBag,
} from "./helpers/hermetic-env";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO, rel), "utf-8");

const APP_DATA_DIR = "/Users/me/Library/Application Support/fe-ai-flow/data";

describe("A · applyHermeticEnv（纯逻辑）", () => {
  it("剔除全部宿主注入变量，FLOWSHIP_DATA_DIR 换成新建的临时目录", () => {
    const env: EnvBag = {
      FLOWSHIP_DATA_DIR: APP_DATA_DIR,
      PORT: "8876",
      HOSTNAME: "127.0.0.1",
      ELECTRON_RUN_AS_NODE: "1",
      __NEXT_PRIVATE_STANDALONE_CONFIG: "{}",
      PATH: "/usr/bin",
      HOME: "/Users/me",
    };
    const r = applyHermeticEnv(env, () => "/tmp/hermetic-1");

    expect(env.FLOWSHIP_DATA_DIR).toBe("/tmp/hermetic-1");
    expect(r.dataDir).toBe("/tmp/hermetic-1");
    for (const key of HOST_INJECTED_ENV_KEYS) {
      if (key === "FLOWSHIP_DATA_DIR") continue;
      expect(env[key]).toBeUndefined();
    }
    // 与宿主无关的变量原样保留
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/me");
    // 回报：继承到了桌面包的数据目录 = 这次隔离确实挡住了一次事故
    expect(r.inheritedDataDir).toBe(APP_DATA_DIR);
    expect(r.inheritedAppData).toBe(true);
    expect(r.stripped).toEqual(
      expect.arrayContaining([
        "FLOWSHIP_DATA_DIR",
        "PORT",
        "HOSTNAME",
        "ELECTRON_RUN_AS_NODE",
        "__NEXT_PRIVATE_STANDALONE_CONFIG",
      ]),
    );
  });

  it("没继承任何东西也照样给一个临时数据目录（不再回落共享的 cwd/data）", () => {
    const env: EnvBag = { PATH: "/usr/bin" };
    const r = applyHermeticEnv(env, () => "/tmp/hermetic-2");
    expect(env.FLOWSHIP_DATA_DIR).toBe("/tmp/hermetic-2");
    expect(r.inheritedDataDir).toBeUndefined();
    expect(r.inheritedAppData).toBe(false);
    expect(r.stripped).toEqual([]);
  });

  it("继承到的是别的普通目录：一样换掉（测试结果不该取决于谁启动了我）", () => {
    const env: EnvBag = { FLOWSHIP_DATA_DIR: "/tmp/someone-elses" };
    const r = applyHermeticEnv(env, () => "/tmp/hermetic-3");
    expect(env.FLOWSHIP_DATA_DIR).toBe("/tmp/hermetic-3");
    expect(r.inheritedAppData).toBe(false);
  });

  it("每次调用各拿各的目录（不共享）", () => {
    let n = 0;
    const a = applyHermeticEnv({}, () => `/tmp/h-${++n}`);
    const b = applyHermeticEnv({}, () => `/tmp/h-${++n}`);
    expect(a.dataDir).not.toBe(b.dataDir);
  });
});

describe("A · applyHermeticGitEnv（git 配置隔离）", () => {
  it("全局配置指向 os.devNull、不读系统配置、禁交互提示，并给兜底提交身份", () => {
    const env: EnvBag = {
      GIT_CONFIG_GLOBAL: "/Users/me/.gitconfig-with-gpgsign",
      GIT_AUTHOR_NAME: "someone-else",
    };
    applyHermeticGitEnv(env);
    expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    for (const k of [
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_NAME",
    ] as const) {
      expect(env[k]).toBe(HERMETIC_GIT_IDENTITY.name);
    }
    for (const k of [
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_EMAIL",
    ] as const) {
      expect(env[k]).toBe(HERMETIC_GIT_IDENTITY.email);
    }
  });

  it("applyHermeticEnv 一并做 git 隔离（setupFiles 只调这一个入口）", () => {
    const env: EnvBag = { GIT_CONFIG_GLOBAL: "/Users/me/.gitconfig" };
    applyHermeticEnv(env, () => "/tmp/hermetic-git");
    expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_AUTHOR_NAME).toBe(HERMETIC_GIT_IDENTITY.name);
  });

  it("端到端：全局配置开了 commit.gpgsign（签名程序必失败）+ 没配身份，隔离后 git commit 仍成功", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-hermetic-git-"));
    try {
      const badGlobal = path.join(root, "gitconfig");
      fs.writeFileSync(
        badGlobal,
        "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n",
        "utf-8",
      );
      const repo = path.join(root, "repo");
      fs.mkdirSync(repo);
      const run = (env: NodeJS.ProcessEnv, ...args: string[]): string =>
        // stdio 全管道：对照组的「gpg failed to sign」是预期失败、别灌进测试输出
        execFileSync("git", args, {
          cwd: repo,
          env,
          encoding: "utf-8",
          stdio: "pipe",
        });

      // 对照：没隔离时同一份全局配置确实会让 commit 失败（证明这条用例有牙，不是在测空气）
      const dirty: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: badGlobal,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t.local",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t.local",
      };
      run(dirty, "init", "-q", "-b", "main");
      expect(() =>
        run(dirty, "commit", "-q", "--allow-empty", "-m", "x"),
      ).toThrow();

      // 隔离后（含丢掉身份）：commit 成功
      const hermetic: NodeJS.ProcessEnv = { ...dirty };
      for (const k of [
        "GIT_AUTHOR_NAME",
        "GIT_AUTHOR_EMAIL",
        "GIT_COMMITTER_NAME",
        "GIT_COMMITTER_EMAIL",
      ]) {
        delete hermetic[k];
      }
      applyHermeticGitEnv(hermetic as EnvBag);
      run(hermetic, "commit", "-q", "--allow-empty", "-m", "x");
      expect(run(hermetic, "log", "-1", "--format=%s").trim()).toBe("x");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("A · assertEnvNotAppData", () => {
  it("FLOWSHIP_DATA_DIR 指向桌面包数据目录（正式 / test 包）→ 抛错，并指明路径", () => {
    expect(() =>
      assertEnvNotAppData({ FLOWSHIP_DATA_DIR: APP_DATA_DIR }),
    ).toThrow(/桌面包的数据目录.*fe-ai-flow\/data/);
    expect(() =>
      assertEnvNotAppData({
        FLOWSHIP_DATA_DIR:
          "/Users/me/Library/Application Support/fe-ai-flow-test/data",
      }),
    ).toThrow(/桌面包的数据目录/);
  });

  it("临时目录 / 未设置 → 放行", () => {
    expect(() =>
      assertEnvNotAppData({ FLOWSHIP_DATA_DIR: "/tmp/flowship-x" }),
    ).not.toThrow();
    expect(() => assertEnvNotAppData({})).not.toThrow();
  });
});

describe("B · 当前测试进程的实际环境（setupFiles 真的生效了）", () => {
  it("FLOWSHIP_DATA_DIR 是 tmp 下新建的目录，不是桌面包的数据目录", () => {
    const dir = process.env.FLOWSHIP_DATA_DIR;
    expect(dir).toBeTruthy();
    expect(isAppUserDataPath(dir)).toBe(false);
    expect(dir!.startsWith(os.tmpdir())).toBe(true);
    expect(fs.statSync(dir!).isDirectory()).toBe(true);
  });

  it("宿主注入变量一个都没有（除了被换成临时目录的 FLOWSHIP_DATA_DIR）", () => {
    for (const key of HOST_INJECTED_ENV_KEYS) {
      if (key === "FLOWSHIP_DATA_DIR") continue;
      expect(process.env[key], key).toBeUndefined();
    }
  });

  it("git 配置已隔离：本机 / 系统的全局配置（commit.gpgsign、core.excludesfile 等）一条都读不到", () => {
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(os.devNull);
    expect(process.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
    // 子进程（继承本进程 env）里真的读不到任何全局配置，而不只是「变量设了」
    const listed = spawnSync("git", ["config", "--global", "--list"], {
      encoding: "utf-8",
    });
    expect(listed.stdout.trim()).toBe("");
    const gpg = spawnSync("git", ["config", "--get", "commit.gpgsign"], {
      encoding: "utf-8",
    });
    expect(gpg.stdout.trim()).toBe("");
  });
});

describe("C · 接线契约", () => {
  it("vitest.config.ts 注册了 setupFiles → tests/setup/hermetic-env.ts，且文件存在", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toMatch(/setupFiles:\s*\[\s*["']\.\/tests\/setup\/hermetic-env\.ts["']\s*\]/);
    expect(fs.existsSync(path.join(REPO, "tests/setup/hermetic-env.ts"))).toBe(true);
  });

  it("setup 文件：import 前先 applyHermeticEnv(process.env)，每个测试前 assertEnvNotAppData，结束清目录", () => {
    const src = read("tests/setup/hermetic-env.ts");
    expect(src).toMatch(/applyHermeticEnv\(\s*process\.env/);
    expect(src).toMatch(/beforeEach\(\s*\(\)\s*=>\s*\{[\s\S]*assertEnvNotAppData\(process\.env\)/);
    expect(src).toMatch(/afterAll\(/);
    expect(src).toMatch(/fs\.rmSync\(dataDir/);
  });

  it("setup 文件名不带 .test：不会被 include 当成测试收集", () => {
    expect(fs.existsSync(path.join(REPO, "tests/setup/hermetic-env.test.ts"))).toBe(false);
  });
});

describe("D · 端到端：继承了桌面包数据目录的环境真跑 vitest，桌面包数据原样不动", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  });

  it("事故现场复现：假的桌面包数据目录里有个 running 的聊天，探针测试跑完它没被标 error", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowship-hermetic-e2e-"));
    roots.push(root);
    // 假的「正式包」数据目录：长得跟真的一样（<appData>/fe-ai-flow/data），但在临时目录里，真数据不受牵连
    const fakeData = path.join(root, "Library", "Application Support", "fe-ai-flow", "data");
    expect(isAppUserDataPath(fakeData)).toBe(true);

    const taskId = "t_hermetic_running";
    const taskPath = path.join(fakeData, "tasks", taskId);
    fs.mkdirSync(taskPath, { recursive: true });
    const meta = {
      id: taskId,
      title: "假的正式聊天（running）",
      mode: "chat",
      repoStatus: "developing",
      runStatus: "running",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1,
      updatedAt: 1,
    };
    // 种子必须是 boot-recovery 会认的合法 meta，否则「没被标 error」什么也证明不了
    expect(isValidMetaShape(meta)).toBe(true);
    const metaFile = path.join(taskPath, "meta.json");
    const metaText = JSON.stringify(meta, null, 2);
    fs.writeFileSync(metaFile, metaText, "utf-8");

    // 子进程环境 = agent shell 的样子：继承宿主注入的变量（含指向「正式包」的 FLOWSHIP_DATA_DIR）
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith("VITEST") || k === "TEST") delete env[k];
    }
    Object.assign(env, {
      FLOWSHIP_DATA_DIR: fakeData,
      PORT: "8876",
      HOSTNAME: "127.0.0.1",
    });

    const vitestBin = path.join(REPO, "node_modules", "vitest", "vitest.mjs");
    const r = spawnSync(
      process.execPath,
      [vitestBin, "run", "tests/hermetic-probe.test.ts"],
      { cwd: REPO, env, encoding: "utf-8", timeout: 120_000 },
    );
    const log = `${r.stdout}\n${r.stderr}`;

    // 探针自己的断言通过（DATA_DIR 被隔离到临时目录）
    expect(r.status, log).toBe(0);
    expect(log).toMatch(/2 passed/);
    // 假的桌面包数据一个字节都没动：meta 原样、没有追加 [boot-recovery] 事件
    expect(fs.readFileSync(metaFile, "utf-8")).toBe(metaText);
    expect(fs.existsSync(path.join(taskPath, "events.jsonl"))).toBe(false);
    expect(fs.readdirSync(path.join(fakeData, "tasks"))).toEqual([taskId]);
  }, 150_000);
});
