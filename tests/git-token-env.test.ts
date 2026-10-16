/**
 * GitLab PAT 改走环境变量（S03-04 根治）：agent 不再 `jq -r .gitToken <dataRoot>/config.json`
 *
 * 钉六件事：
 *   A. syncGitTokenEnv：设置 / 覆盖 / 清除 / 空白 / 非字符串——无 token 必须 delete、不留空串；
 *   B. syncGitTokenEnvFromSettingsResult：ok / missing / error 三态（error 不动 env）；
 *   C. env 通道：变量名不在 HOST_INJECTED_ENV_KEYS、stripHostInjectedEnv() 保留它；
 *      pi 的 shell 工具真能继承到、旁路只读 shell 摘掉；测试进程的 hermetic 环境不带真 token；
 *   D. 「GitLab 访问」提示文案：引用环境变量、不含 `jq -r .gitToken` / config.json 路径，
 *      PowerShell 写法、origin 不可信警告；
 *   E. prompt 预算裁剪后的占位文案同样不回退到读 config.json；
 *   F. 全仓 prompts / skills 里没有「从 config.json 读 gitToken」的指令；
 *   G. 脱敏兜底没变弱：event-secret-redact 仍从 config.json 读 gitToken 精确值脱敏。
 * 会话启动路径后 env 有值的端到端用例在 tests/session-git-trust.test.ts（要整套会话 harness）。
 *
 * 只用假 token；每个用例后还原 process.env。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GITLAB_TOKEN_ENV_NAME,
  syncGitTokenEnv,
  syncGitTokenEnvFromSettingsResult,
} from "@/lib/server/git-token-env";
import {
  HOST_INJECTED_ENV_KEYS,
  stripHostInjectedEnv,
} from "@/lib/server/host-env";
import {
  buildGitlabAccessDirective,
  buildSuperPromptWithBudget,
} from "@/lib/server/task-prompts";
import type { Task } from "@/lib/types";

import { applyHermeticEnv } from "./helpers/hermetic-env";

const FAKE_TOKEN = "glpat-FAKE-ENV-CHANNEL-TOKEN";
const ORIGINAL = process.env[GITLAB_TOKEN_ENV_NAME];
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

beforeEach(() => {
  delete process.env[GITLAB_TOKEN_ENV_NAME];
});

const restoreEnv = (): void => {
  if (ORIGINAL === undefined) delete process.env[GITLAB_TOKEN_ENV_NAME];
  else process.env[GITLAB_TOKEN_ENV_NAME] = ORIGINAL;
};
afterEach(restoreEnv);
afterAll(restoreEnv);

// ---------------------------------------------------------------------------
// A. syncGitTokenEnv
// ---------------------------------------------------------------------------

describe("A · syncGitTokenEnv", () => {
  it("变量名固定为 FLOWSHIP_GITLAB_TOKEN（提示词 / 脱敏注释 / 测试都引同一个常量）", () => {
    expect(GITLAB_TOKEN_ENV_NAME).toBe("FLOWSHIP_GITLAB_TOKEN");
  });

  it("非空 token → 写入 process.env；首尾空白 trim 掉", () => {
    syncGitTokenEnv(FAKE_TOKEN);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_TOKEN);

    syncGitTokenEnv(`  ${FAKE_TOKEN}-2\n`);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(`${FAKE_TOKEN}-2`);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["空串", ""],
    ["纯空白", "  \n\t "],
    ["数字", 12345],
    ["对象", { token: FAKE_TOKEN }],
  ])("无效值（%s）→ 清除变量，而不是留空串", (_name, value) => {
    process.env[GITLAB_TOKEN_ENV_NAME] = "stale-should-be-cleared";
    syncGitTokenEnv(value);
    // 必须是「不存在」：空串变量会让 `[ -n "$FLOWSHIP_GITLAB_TOKEN" ]` 误判已配置
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBeUndefined();
  });

  it("用户在设置页改 token / 清空 token：env 跟着更新", () => {
    syncGitTokenEnv("old-token");
    syncGitTokenEnv("new-token");
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe("new-token");
    syncGitTokenEnv("");
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B. syncGitTokenEnvFromSettingsResult
// ---------------------------------------------------------------------------

describe("B · syncGitTokenEnvFromSettingsResult", () => {
  it("ok + 有 gitToken → 写入", () => {
    syncGitTokenEnvFromSettingsResult({
      status: "ok",
      settings: { gitToken: ` ${FAKE_TOKEN} ` },
    } as never);
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_TOKEN);
  });

  it("ok 但没有 / 空 gitToken → 清除", () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = "stale";
    syncGitTokenEnvFromSettingsResult({ status: "ok", settings: {} } as never);
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);

    process.env[GITLAB_TOKEN_ENV_NAME] = "stale";
    syncGitTokenEnvFromSettingsResult({
      status: "ok",
      settings: { gitToken: "   " },
    } as never);
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });

  it("missing（首次安装、没有 config.json）→ 确定没有 token、清除", () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = "stale";
    syncGitTokenEnvFromSettingsResult({ status: "missing" });
    expect(GITLAB_TOKEN_ENV_NAME in process.env).toBe(false);
  });

  it("error（损坏 / 权限等瞬时读失败）→ 不动 env：读不到不等于用户清空了 token", () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_TOKEN;
    syncGitTokenEnvFromSettingsResult({ status: "error", reason: "boom" });
    expect(process.env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// C. env 通道：agent shell 能继承到
// ---------------------------------------------------------------------------

describe("C · env 继承", () => {
  it("变量名不在宿主注入黑名单里（加进去 pi shell 就拿不到 token）", () => {
    expect(
      (HOST_INJECTED_ENV_KEYS as readonly string[]).includes(GITLAB_TOKEN_ENV_NAME),
    ).toBe(false);
  });

  it("stripHostInjectedEnv() 剔宿主变量但保留 GitLab token 变量", () => {
    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_TOKEN;
    const prevPort = process.env.PORT;
    process.env.PORT = "3999"; // 宿主注入变量：必须被剔
    try {
      const env = stripHostInjectedEnv();
      expect(env[GITLAB_TOKEN_ENV_NAME]).toBe(FAKE_TOKEN);
      expect(env.PORT).toBeUndefined();
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it("pi 的 shell 工具里 `$FLOWSHIP_GITLAB_TOKEN` 真能展开（命令里不出现 token 值）", async () => {
    if (process.platform === "win32") return; // 用 bash 语法，Windows 靠 Git Bash 另测
    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_TOKEN;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fe-token-env-shell-"));
    try {
      const { buildCodingToolDefs } = await import("@/lib/server/pi-coding-tools");
      const shell = buildCodingToolDefs(cwd, (async () => "") as never).find(
        (d) => (d as { name?: unknown }).name === "shell",
      ) as unknown as {
        execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
      };
      const out = await shell.execute("call-1", {
        command: `printf 'len=%s' "\${#${GITLAB_TOKEN_ENV_NAME}}"`,
      });
      const text = out.content.map((c) => c.text).join("\n");
      expect(text).toContain(`len=${FAKE_TOKEN.length}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    // 首次 import pi-coding-tools（转译一大串依赖）+ 真 spawn bash，冷启动可能超默认 5s
  }, 60_000);

  it("旁路只读 shell 摘掉该变量：非属主的不可信输入手里没有 GitLab 凭证", async () => {
    if (process.platform === "win32") return;
    process.env[GITLAB_TOKEN_ENV_NAME] = FAKE_TOKEN;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fe-token-env-ro-"));
    try {
      // 只读 shell 允许「node + 工作目录内文件」：脚本只打印变量长度、不打印值
      fs.writeFileSync(
        path.join(cwd, "probe.js"),
        `process.stdout.write("len=" + String((process.env.${GITLAB_TOKEN_ENV_NAME} || "").length));`,
      );
      const { buildReadOnlyToolDefs } = await import("@/lib/server/pi-coding-tools");
      const shell = buildReadOnlyToolDefs(cwd, { taskId: "t1" }).find(
        (d) => (d as { name?: unknown }).name === "shell",
      ) as unknown as {
        execute: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
      };
      const out = await shell.execute("call-1", { command: "node probe.js" });
      const text = out.content.map((c) => c.text).join("\n");
      expect(text, text).toContain("len=0");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it("测试进程的 hermetic 环境会清掉继承来的真 token，且不把它算进 stripped（它不是宿主注入变量）", () => {
    const env: Record<string, string | undefined> = {
      [GITLAB_TOKEN_ENV_NAME]: FAKE_TOKEN,
      FLOWSHIP_DATA_DIR: "/tmp/not-app-data",
    };
    const r = applyHermeticEnv(env, () => "/tmp/fe-hermetic-fake");
    expect(env[GITLAB_TOKEN_ENV_NAME]).toBeUndefined();
    expect(r.stripped).not.toContain(GITLAB_TOKEN_ENV_NAME);
  });
});

// ---------------------------------------------------------------------------
// D. 「GitLab 访问」提示文案
// ---------------------------------------------------------------------------

describe("D · buildGitlabAccessDirective", () => {
  const DATA_ROOT = "/data/flowship";
  const CONFIG_PATH = path.join(DATA_ROOT, "config.json");

  it("bash / zsh：让 agent 直接引用 \"$FLOWSHIP_GITLAB_TOKEN\"，不再 jq 读 config.json", () => {
    const text = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "bash",
    });

    expect(text).toContain("## GitLab 访问");
    expect(text).toContain("gitlab.corp.com");
    expect(text).toContain(GITLAB_TOKEN_ENV_NAME);
    expect(text).toContain(`"$${GITLAB_TOKEN_ENV_NAME}"`);
    expect(text).toContain(`curl -s -H "PRIVATE-TOKEN: $${GITLAB_TOKEN_ENV_NAME}"`);
    // 回退自检点：旧文案的特征都不能再出现
    expect(text).not.toContain("jq -r .gitToken");
    expect(text).not.toMatch(/jq\b/);
    expect(text).not.toContain(".gitToken");
    expect(text).not.toContain(CONFIG_PATH);
    // 明确的禁令：不打开 config.json、不打印
    expect(text).toMatch(/不要\*\*打开数据目录里的 config\.json/);
    expect(text).toMatch(/echo \/ printenv/);
    // 其余固定内容不丢：内置 CLI 路径
    expect(text).toContain(path.join(DATA_ROOT, "tools", "bin"));
  });

  it("用法写在第一条 bullet：压缩只保留标题 + 前两行时也能看到变量名", () => {
    const lines = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "zsh",
    }).split("\n");
    expect(lines[0]).toBe("## GitLab 访问");
    expect(lines[1]).toContain(GITLAB_TOKEN_ENV_NAME);
    expect(lines[1]).toContain(`"$${GITLAB_TOKEN_ENV_NAME}"`);
  });

  it("PowerShell：补 $env: 写法与 curl.exe（curl 在 PowerShell 里是 Invoke-WebRequest 别名）", () => {
    const text = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "PowerShell",
    });
    expect(text).toContain(`$env:${GITLAB_TOKEN_ENV_NAME}`);
    expect(text).toContain("curl.exe");
    expect(text).not.toContain(`"$${GITLAB_TOKEN_ENV_NAME}"`); // bash 写法在 PowerShell 里是错的
    expect(text).not.toMatch(/jq\b/);
    expect(text).not.toContain(CONFIG_PATH);
  });

  it("Git Bash 走 bash 写法", () => {
    const text = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "Git Bash",
    });
    expect(text).toContain(`"$${GITLAB_TOKEN_ENV_NAME}"`);
  });

  it("host 为空：兜底「host 见仓库 origin」", () => {
    expect(
      buildGitlabAccessDirective(null, DATA_ROOT, { shellKind: "bash" }),
    ).toContain("（host 见仓库 origin）");
    expect(
      buildGitlabAccessDirective("   ", DATA_ROOT, { shellKind: "bash" }),
    ).toContain("（host 见仓库 origin）");
  });

  it("origin 与可信 host 不一致：展示可信 host、警告绝不向 origin 地址发 token", () => {
    const text = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "bash",
      untrustedOriginHost: "evil.example",
    });
    expect(text).toContain("host: gitlab.corp.com");
    expect(text).toContain("evil.example");
    expect(text).toContain("绝不要");
    expect(text).toContain("可信 GitLab");
  });

  it("origin 不可信且连可信 host 都读不出（固定文件损坏）：不展示任何 host，仍有警告", () => {
    const text = buildGitlabAccessDirective(null, DATA_ROOT, {
      shellKind: "bash",
      untrustedOriginHost: "evil.example",
    });
    expect(text).toContain("（可信 host 未能确定）");
    expect(text).not.toContain("host: evil.example");
    expect(text).toContain("绝不要");
  });

  it("没有 untrustedOriginHost 时不出现警告", () => {
    const text = buildGitlabAccessDirective("gitlab.corp.com", DATA_ROOT, {
      shellKind: "bash",
    });
    expect(text).not.toContain("绝不要");
  });
});

// ---------------------------------------------------------------------------
// E. prompt 预算裁剪后的文案
// ---------------------------------------------------------------------------

describe("E · 预算裁剪后的 GitLab 访问段", () => {
  const taskFixture = (): Task =>
    ({
      id: "t_env_prompt",
      title: "env prompt",
      mode: "task",
      repoStatus: "developing",
      runStatus: "idle",
      currentActionId: null,
      actions: [],
      mrs: [],
      repoPaths: [],
      createdAt: 1,
      updatedAt: 1,
      events: [],
    }) as unknown as Task;

  const firstAction = () => ({
    action: {
      id: "act_1",
      n: 1,
      type: "plan",
      status: "pending",
      userInstruction: "",
      artifactPath: "actions/1-plan.md",
      startedAt: null,
      endedAt: null,
    } as never,
    userInstruction: "",
  });

  const build = (budget: number) =>
    buildSuperPromptWithBudget(
      taskFixture(),
      [],
      firstAction(),
      "",
      buildGitlabAccessDirective("gitlab.corp.com", "/data/flowship", {
        shellKind: "bash",
      }),
      "",
      "",
      budget,
    );

  it("预算充足：完整段进 prompt，含变量引用、不含 jq / config.json 路径", async () => {
    const r = await build(10_000_000);
    expect(r.prompt).toContain("## GitLab 访问");
    expect(r.prompt).toContain(`"$${GITLAB_TOKEN_ENV_NAME}"`);
    expect(r.prompt).not.toContain("jq -r .gitToken");
    expect(r.prompt).not.toContain(path.join("/data/flowship", "config.json"));
  });

  it("预算极小：整段被裁成占位文案，占位也只指向环境变量（不回退成读 config.json）", async () => {
    const r = await build(1);
    expect(r.dropped.map((d) => d.name)).toContain("gitlabAccessSection");
    expect(r.prompt).toContain("GitLab 访问段已因 prompt 预算裁剪");
    expect(r.prompt).toContain(GITLAB_TOKEN_ENV_NAME);
    expect(r.prompt).toMatch(/不要读 config\.json、不要打印/);
    expect(r.prompt).not.toContain("jq -r .gitToken");
    expect(r.prompt).not.toMatch(/jq -r/);
  });

  it("源码里压缩版 / 裁剪占位文案都引用变量名、没有 jq", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "src/lib/server/task-prompts.ts"),
      "utf-8",
    );
    const compress = src.slice(src.indexOf("const gitlabCompressed = compressToTwoLines("));
    const compressCall = compress.slice(0, compress.indexOf(");") + 2);
    expect(compressCall).toContain("GITLAB_TOKEN_ENV_NAME");
    expect(compressCall).not.toMatch(/jq/);
    expect(src).not.toMatch(/jq -r/);
  });
});

// ---------------------------------------------------------------------------
// F. prompts / skills 里没有「读 config.json 取 gitToken」的指令
// ---------------------------------------------------------------------------

describe("F · prompts / skills 静态检查", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, out);
      else if (/\.(md|mdc|txt)$/i.test(ent.name)) out.push(p);
    }
    return out;
  };

  it("prompts/ 与 skills/ 下没有 jq 读 gitToken、也没有让 agent 从 config.json 取 token 的写法", () => {
    const files = [
      ...walk(path.join(REPO_ROOT, "prompts")),
      ...walk(path.join(REPO_ROOT, "skills")),
    ];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(f, "utf-8");
      return (
        /jq\s+-r\s+['"]?\.gitToken/.test(text) ||
        /config\.json[^\n]{0,80}gitToken/.test(text) ||
        /gitToken[^\n]{0,80}config\.json/.test(text)
      );
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it("server 端 TS 源码里不再有给 agent 的 `jq -r .gitToken` 指令字符串", () => {
    const dir = path.join(REPO_ROOT, "src/lib/server");
    const offenders = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".ts"))
      .filter((n) =>
        /jq\s+-r\s+['"]?\.gitToken/.test(fs.readFileSync(path.join(dir, n), "utf-8")),
      );
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// G. 脱敏兜底没变弱
// ---------------------------------------------------------------------------

describe("G · 事件精确值脱敏仍覆盖 gitToken（env 值与 config.json 里的相同）", () => {
  it("event-secret-redact 仍把 config.json 的 gitToken 列为脱敏目标", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "src/lib/server/event-secret-redact.ts"),
      "utf-8",
    );
    expect(src).toContain("gitToken");
    expect(src).toContain("config.json");
    // 头部注释已同步成 env 注入口径、不再宣称 agent 用 jq 取 token
    expect(src).toContain(GITLAB_TOKEN_ENV_NAME);
    expect(src).not.toContain("让 agent 用 jq/node 从 `config.json` 取 gitToken 调 GitLab API。");
  });
});
