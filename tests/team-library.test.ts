/**
 * team-library 纯逻辑单测（不碰真实 git 网络）
 *
 * 覆盖：配置合并、.flowship-action.json 解析、seen 默认禁用策略（白名单版）、
 * git 输出脱敏、credential helper 参数构造、push 错误分类、GitLab URL 解析、
 * 上传分支名、skill 名白名单、仓级互斥串行、半残 .git 自愈（本地 bare）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_LIBRARY,
  GIT_TOKEN_ENV,
  KNOWLEDGE_GLOBAL_DEFAULT_ENABLED,
  buildAuthedGitArgs,
  buildUploadBranchName,
  checkUploadNameAcrossCategories,
  classifyPushRejection,
  computeDefaultSkillStates,
  ensureRepoAt,
  isSafeTeamCategory,
  isSafeTeamSkillName,
  locateSharedSkillPath,
  mergeTeamLibraryConfig,
  parseGitLabRepoUrl,
  redactGitText,
  withTeamLibraryLock,
} from "@/lib/server/team-library";
// 派生模型后 parseFlowshipActionMeta 挪到 custom-action-fs（避免循环 import）
import { parseFlowshipActionMeta } from "@/lib/server/custom-action-fs";

const execFileAsync = promisify(execFile);

describe("mergeTeamLibraryConfig", () => {
  it("无覆盖 → 返回默认副本", () => {
    const m = mergeTeamLibraryConfig({ ...DEFAULT_TEAM_LIBRARY }, null);
    expect(m).toEqual(DEFAULT_TEAM_LIBRARY);
    expect(m).not.toBe(DEFAULT_TEAM_LIBRARY);
  });

  it("部分字段覆盖、空串 / 非法类型忽略", () => {
    const m = mergeTeamLibraryConfig(
      { ...DEFAULT_TEAM_LIBRARY },
      {
        branch: "develop",
        repoUrl: "  ",
        knowledgeSourceBranch: 123,
        knowledgeSourceUrl: "https://example.com/kb.git",
        extra: "ignored",
      },
    );
    expect(m.branch).toBe("develop");
    expect(m.repoUrl).toBe(DEFAULT_TEAM_LIBRARY.repoUrl);
    expect(m.knowledgeSourceBranch).toBe(
      DEFAULT_TEAM_LIBRARY.knowledgeSourceBranch,
    );
    expect(m.knowledgeSourceUrl).toBe("https://example.com/kb.git");
  });

  it("非对象覆盖 → 全默认", () => {
    expect(
      mergeTeamLibraryConfig({ ...DEFAULT_TEAM_LIBRARY }, ["x"]),
    ).toEqual(DEFAULT_TEAM_LIBRARY);
  });
});

describe("parseFlowshipActionMeta", () => {
  it("合法 JSON → meta", () => {
    const meta = parseFlowshipActionMeta(
      JSON.stringify({
        label: "改 bug",
        output: "写 MR",
        placeholder: "贴链接",
        exportedAt: 1000,
      }),
    );
    expect(meta).toEqual({
      label: "改 bug",
      output: "写 MR",
      placeholder: "贴链接",
      exportedAt: 1000,
    });
  });

  it("缺 label / 非法 JSON → null", () => {
    expect(parseFlowshipActionMeta("{")).toBeNull();
    expect(parseFlowshipActionMeta(JSON.stringify({ label: "  " }))).toBeNull();
    expect(parseFlowshipActionMeta(JSON.stringify([]))).toBeNull();
  });

  it("requiresKnowledge 严格 true 才带上", () => {
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({
          label: "需知识库",
          requiresKnowledge: true,
          exportedAt: 1,
        }),
      ),
    ).toEqual({
      label: "需知识库",
      requiresKnowledge: true,
      exportedAt: 1,
    });
    expect(
      parseFlowshipActionMeta(
        JSON.stringify({
          label: "假",
          requiresKnowledge: "true",
          exportedAt: 1,
        }),
      )?.requiresKnowledge,
    ).toBeUndefined();
  });
});

describe("computeDefaultSkillStates", () => {
  it("全量默认安装：首次发现的 team skill 不分位置一律 enabled", () => {
    const added = computeDefaultSkillStates({
      skills: [
        // 组内普通沉淀（含角色分组路径）
        { name: "group-plain", relDir: "skills/group-plain" },
        {
          name: "group-fe-plain",
          relDir: "skills/fe/group-fe-plain",
        },
        // 组内 action 壳 skill 也默认装（推进 action 随之派生出现）
        {
          name: "group-action",
          relDir: "skills/common/group-action",
        },
        // global 与工程级知识库 skill 同样默认装
        {
          name: "requirement-analyzer",
          relDir: "knowledge/skills/global/eng/requirement-analyzer",
        },
        {
          name: "fe-helper",
          relDir: "knowledge/skills/frontend/crm/fe-helper",
        },
      ],
      known: new Set(),
    });
    expect(added).toEqual({
      "group-plain": "enabled",
      "group-fe-plain": "enabled",
      "group-action": "enabled",
      "requirement-analyzer": "enabled",
      "fe-helper": "enabled",
    });
    // 核心名单仍导出（UI 推荐标 / 卸载提醒用、不再参与默认启停判定）
    expect([...KNOWLEDGE_GLOBAL_DEFAULT_ENABLED]).toEqual([
      "requirement-analyzer",
      "wk-harness",
      "knowledge-base-qa",
    ]);
  });

  it("已在表里（known）→ 不出现在增量表（用户改过的永不被策略覆盖）", () => {
    const added = computeDefaultSkillStates({
      skills: [
        {
          name: "fe-helper",
          relDir: "knowledge/skills/frontend/crm/fe-helper",
        },
        {
          name: "new-one",
          relDir: "knowledge/skills/frontend/crm/new-one",
        },
      ],
      known: new Set(["fe-helper"]),
    });
    expect(added).toEqual({ "new-one": "enabled" });
  });

  it("同批重名首个胜出、不重复写入", () => {
    const added = computeDefaultSkillStates({
      skills: [
        { name: "x", relDir: "skills/common/x" },
        { name: "x", relDir: "knowledge/skills/frontend/app/x" },
      ],
      known: new Set(),
    });
    expect(added).toEqual({ x: "enabled" });
  });
});

describe("redactGitText", () => {
  it("URL userinfo（oauth2:token / user:pass）→ ***@", () => {
    expect(
      redactGitText(
        "fatal: unable to access 'https://oauth2:glpat-abc123@gitlab.example.com/g/r.git/': The requested URL returned error: 401",
      ),
    ).toBe(
      "fatal: unable to access 'https://***@gitlab.example.com/g/r.git/': The requested URL returned error: 401",
    );
    expect(redactGitText("https://user:p%40ss@host/x.git")).toBe(
      "https://***@host/x.git",
    );
  });

  it("execFile 失败 message 含完整命令行也能脱敏（构造样例）", () => {
    const msg = [
      "Command failed: git clone --branch main --single-branch https://oauth2:glpat-SECRET@gitlab.wukongedu.net/frontend/infra/ai-flow-action-hub.git /data/team-library/repo",
      "fatal: could not read Username for 'https://oauth2:glpat-SECRET@gitlab.wukongedu.net': terminal prompts disabled",
    ].join("\n");
    const red = redactGitText(msg);
    expect(red).not.toContain("glpat-SECRET");
    expect(red).toContain("https://***@gitlab.wukongedu.net");
  });

  it("裸 oauth2:token@（无 scheme 前缀）也能脱敏", () => {
    expect(redactGitText("push to oauth2:tok123@host failed")).toBe(
      "push to ***@host failed",
    );
  });

  it("无凭据文本原样返回", () => {
    const plain =
      "fatal: Could not resolve host: gitlab.example.com\nerror: failed to push some refs";
    expect(redactGitText(plain)).toBe(plain);
  });
});

describe("buildAuthedGitArgs", () => {
  it("token 不进参数：干净子命令 + 双 credential.helper + postBuffer", () => {
    const args = buildAuthedGitArgs(["fetch", "origin", "main"]);
    // 子命令原样收尾
    expect(args.slice(-3)).toEqual(["fetch", "origin", "main"]);
    // 先清空系统 helper（屏蔽 keychain）、再挂 inline helper
    const helperValues = args.filter((a) => a.startsWith("credential.helper"));
    expect(helperValues[0]).toBe("credential.helper=");
    expect(helperValues[1]).toContain("username=oauth2");
    // token 从 env 读、参数里只有 env 变量名（$TL_GIT_TOKEN）、没有值
    expect(helperValues[1]).toContain(`$${GIT_TOKEN_ENV}`);
    // 大 push（镜像 5M+）防 GitLab HTTP 500
    expect(args).toContain("http.postBuffer=157286400");
  });
});

describe("classifyPushRejection", () => {
  it("保护分支拒绝 → protected（即使同时带 [remote rejected]）", () => {
    // GitLab 真实输出：remote 提示 + pre-receive hook declined 两行同现
    const gitlabProtected = [
      "remote: GitLab: You are not allowed to push code to protected branches on this project.",
      "! [remote rejected] HEAD -> main (pre-receive hook declined)",
    ].join("\n");
    expect(classifyPushRejection(gitlabProtected)).toBe("protected");
    expect(
      classifyPushRejection("cannot push to protected branch 'main'"),
    ).toBe("protected");
  });

  it("远端有新提交 → non-fast-forward", () => {
    expect(
      classifyPushRejection(
        "! [rejected] HEAD -> main (fetch first)\nerror: failed to push some refs",
      ),
    ).toBe("non-fast-forward");
    expect(
      classifyPushRejection("Updates were rejected: non-fast-forward"),
    ).toBe("non-fast-forward");
  });

  it("其它失败（认证 / 网络）→ other", () => {
    expect(
      classifyPushRejection("fatal: Authentication failed for 'https://...'"),
    ).toBe("other");
    expect(classifyPushRejection("Could not resolve host")).toBe("other");
  });

  it("裸 [remote rejected]（钩子 / 权限拒、无 protected 字样）→ other、不做徒劳重试", () => {
    expect(
      classifyPushRejection(
        "! [remote rejected] HEAD -> main (pre-receive hook declined)",
      ),
    ).toBe("other");
    expect(
      classifyPushRejection("! [rejected] HEAD -> main (some hook)"),
    ).toBe("other");
  });
});

describe("parseGitLabRepoUrl", () => {
  it("https URL → host + projectPath（去 .git、支持多级 group）", () => {
    expect(
      parseGitLabRepoUrl(
        "https://gitlab.wukongedu.net/frontend/infra/ai-flow-action-hub.git",
      ),
    ).toEqual({
      host: "gitlab.wukongedu.net",
      projectPath: "frontend/infra/ai-flow-action-hub",
    });
    expect(
      parseGitLabRepoUrl("https://gitlab.wukongedu.net/wukong/wk-knowledgebase.git"),
    ).toEqual({
      host: "gitlab.wukongedu.net",
      projectPath: "wukong/wk-knowledgebase",
    });
  });

  it("非法 URL / 空 path → null", () => {
    expect(parseGitLabRepoUrl("not-a-url")).toBeNull();
    expect(parseGitLabRepoUrl("https://gitlab.example.com/")).toBeNull();
  });
});

describe("buildUploadBranchName", () => {
  it("形如 upload/<slug>-<yyyyMMddHHmmss>、中文保留、空白清掉", () => {
    const now = new Date(2026, 6, 22, 13, 5, 9); // 2026-07-22 13:05:09
    expect(buildUploadBranchName(["改bug", "写 代码"], now)).toBe(
      "upload/改bug-写-代码-20260722130509",
    );
  });

  it("全非法字符 → 回退 skills", () => {
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(buildUploadBranchName(["///"], now)).toBe(
      "upload/skills-20260101000000",
    );
  });
});

describe("isSafeTeamSkillName", () => {
  it("常规英文 / 中文 / 带 ._- 的名字合法", () => {
    expect(isSafeTeamSkillName("fix-bug")).toBe(true);
    expect(isSafeTeamSkillName("改bug")).toBe(true);
    expect(isSafeTeamSkillName("skill_v2.1")).toBe(true);
  });

  it("路径穿越 / 分隔符 / 点开头 / 空串非法", () => {
    expect(isSafeTeamSkillName("../etc")).toBe(false);
    expect(isSafeTeamSkillName("..")).toBe(false);
    expect(isSafeTeamSkillName("a/b")).toBe(false);
    expect(isSafeTeamSkillName("a\\b")).toBe(false);
    expect(isSafeTeamSkillName(".hidden")).toBe(false);
    expect(isSafeTeamSkillName("")).toBe(false);
  });
});

describe("isSafeTeamCategory", () => {
  it("小写字母数字连字符 1~32 位合法", () => {
    expect(isSafeTeamCategory("fe")).toBe(true);
    expect(isSafeTeamCategory("common")).toBe(true);
    expect(isSafeTeamCategory("my-cat-1")).toBe(true);
  });

  it("大写 / 路径穿越 / 过长 / 空串非法", () => {
    expect(isSafeTeamCategory("FE")).toBe(false);
    expect(isSafeTeamCategory("../x")).toBe(false);
    expect(isSafeTeamCategory("a/b")).toBe(false);
    expect(isSafeTeamCategory("")).toBe(false);
    expect(isSafeTeamCategory("a".repeat(33))).toBe(false);
  });
});

describe("locateSharedSkillPath", () => {
  const entries = [
    { category: "fe", name: "改bug" },
    { category: "common", name: "ship-checklist" },
  ];

  it("命中唯一 → 返回 skills/<cat>/<name>", () => {
    expect(locateSharedSkillPath(entries, "改bug")).toEqual({
      ok: true,
      category: "fe",
      relDir: "skills/fe/改bug",
    });
  });

  it("不存在 → 报错", () => {
    const r = locateSharedSkillPath(entries, "no-such");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不存在");
  });

  it("同名多分类 → 报错", () => {
    const r = locateSharedSkillPath(
      [
        { category: "fe", name: "dup" },
        { category: "be", name: "dup" },
      ],
      "dup",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("多个分类");
  });

  it("越界 / 非法名 → 报错", () => {
    expect(locateSharedSkillPath(entries, "../etc").ok).toBe(false);
    expect(locateSharedSkillPath(entries, "").ok).toBe(false);
    expect(locateSharedSkillPath(entries, ".hidden").ok).toBe(false);
    expect(locateSharedSkillPath(entries, "a/b").ok).toBe(false);
  });

  it("非法 category 条目命中 → 报错", () => {
    const r = locateSharedSkillPath(
      [{ category: "../x", name: "ok-name" }],
      "ok-name",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("category");
  });
});

describe("checkUploadNameAcrossCategories", () => {
  const entries = [
    { category: "fe", name: "foo" },
    { category: "common", name: "bar" },
  ];

  it("不存在 → new", () => {
    expect(
      checkUploadNameAcrossCategories("fresh", "qa", entries),
    ).toEqual({ status: "new" });
  });

  it("同分类已有 → overwrite", () => {
    expect(
      checkUploadNameAcrossCategories("foo", "fe", entries),
    ).toEqual({ status: "overwrite" });
  });

  it("跨分类已有 → conflict（带分类中文名；有创建人则带上）", () => {
    const withAuthor = checkUploadNameAcrossCategories("foo", "qa", entries, {
      "skills/fe/foo": "Alice",
    });
    expect(withAuthor.status).toBe("conflict");
    if (withAuthor.status === "conflict") {
      expect(withAuthor.category).toBe("fe");
      expect(withAuthor.author).toBe("Alice");
      expect(withAuthor.error).toBe(
        "库里已有同名 skill（分类 前端、创建人 Alice），请换名或联系对方",
      );
    }

    const noAuthor = checkUploadNameAcrossCategories("foo", "be", entries);
    expect(noAuthor.status).toBe("conflict");
    if (noAuthor.status === "conflict") {
      expect(noAuthor.author).toBeUndefined();
      expect(noAuthor.error).toBe(
        "库里已有同名 skill（分类 前端），请换名或联系对方",
      );
    }
  });

  it("目标分类有 + 其它分类也有 → 仍按跨分类拒绝", () => {
    const r = checkUploadNameAcrossCategories(
      "dup",
      "fe",
      [
        { category: "fe", name: "dup" },
        { category: "qa", name: "dup" },
      ],
    );
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") expect(r.category).toBe("qa");
  });
});

describe("withTeamLibraryLock", () => {
  it("并发提交按顺序串行执行、结果各归各", async () => {
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // a 先进锁且睡 30ms；若没锁、b 的 start 会插到 a-end 之前
    const a = withTeamLibraryLock(async () => {
      order.push("a-start");
      await sleep(30);
      order.push("a-end");
      return "a";
    });
    const b = withTeamLibraryLock(async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });
    await expect(a).resolves.toBe("a");
    await expect(b).resolves.toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("前序失败不传染后续排队者", async () => {
    const boom = withTeamLibraryLock(async () => {
      throw new Error("boom");
    });
    const next = withTeamLibraryLock(async () => "ok");
    await expect(boom).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("ensureRepoAt（半残 .git 自愈）", () => {
  const TMP = path.join(os.tmpdir(), `fe-ensure-repo-${Date.now()}`);
  const bareDir = path.join(TMP, "bare.git");
  const workDir = path.join(TMP, "work");

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("`.git` 存在但 rev-parse 失败 → 删仓重 clone、成功", async () => {
    await fs.mkdir(TMP, { recursive: true });
    // 本地 bare + 初始提交（file:// 免 token、不碰真实网络）
    await execFileAsync("git", ["init", "--bare", "-b", "main", bareDir]);
    const seed = path.join(TMP, "seed");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, "README.md"), "seed\n", "utf-8");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "t@t.com"], {
      cwd: seed,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: seed });
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: seed });
    await execFileAsync("git", ["push", bareDir, "main"], { cwd: seed });

    // 半残：.git 是坏 gitfile（rev-parse --git-dir 失败）；再塞残留文件确认会被整清
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(path.join(workDir, ".git"), "garbage-not-gitfile\n", "utf-8");
    await fs.writeFile(path.join(workDir, "STALE.txt"), "stale\n", "utf-8");

    const r = await ensureRepoAt({
      dir: workDir,
      cleanUrl: bareDir,
      branch: "main",
      token: "",
    });
    expect(r.ok).toBe(true);
    // 半残残留已清、真正 clone 出的内容在
    await expect(fs.access(path.join(workDir, "STALE.txt"))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(workDir, "README.md"), "utf-8"),
    ).resolves.toBe("seed\n");
    // 探活现在应成功
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: workDir });
  });
});