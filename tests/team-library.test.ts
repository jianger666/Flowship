/**
 * team-library 纯逻辑单测（不碰真实 git 网络）
 *
 * 覆盖：配置合并、.flowship-action.json 解析、seen 默认禁用策略（白名单版）、
 * git 输出脱敏、credential helper 参数构造、push 错误分类、GitLab URL 解析、
 * 上传分支名、skill 名白名单、仓级互斥串行、半残 .git 自愈（本地 bare）、
 * 上传敏感信息扫描闸（各模式命中 / 占位符不误报 / force 放行）。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_LIBRARY,
  GIT_TOKEN_ENV,
  KNOWLEDGE_GLOBAL_DEFAULT_ENABLED,
  MIRROR_EXCLUDED_TOP_DIRS,
  TEAM_LIBRARY_DATA_BRANCH,
  buildAuthedGitArgs,
  buildUploadBranchName,
  checkUploadNameAcrossCategories,
  classifyPushRejection,
  computeDefaultSkillStates,
  copyTree,
  ensureRepoAt,
  formatSensitiveScanError,
  gateSensitiveUpload,
  isPlaceholderSecretValue,
  isSafeTeamCategory,
  isSafeTeamSkillName,
  locateSharedSkillPath,
  mergeTeamLibraryConfig,
  parseGitLabRepoUrl,
  parseSymrefDefaultBranch,
  readTeamLibraryBranchFile,
  redactGitText,
  redactSecretValue,
  resolveMirrorSourceBranch,
  scanSensitiveFiles,
  shouldScanStagedPath,
  withTeamLibraryLock,
  writeTeamLibraryBranchFile,
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
  it("首次初始化：skills/ 共享未装、knowledge/ 团队规范默认开", () => {
    const added = computeDefaultSkillStates({
      skills: [
        // 组内普通沉淀（含角色分组路径）
        { name: "group-plain", relDir: "skills/group-plain" },
        {
          name: "group-fe-plain",
          relDir: "skills/fe/group-fe-plain",
        },
        // 组内 action 壳：共享，首次不自动装
        {
          name: "group-action",
          relDir: "skills/common/group-action",
        },
        // 团队规范默认开
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
      isFirstInit: true,
    });
    // 首次：skills/ 共享（含 action 壳）未装；knowledge/ 团队规范默认开
    expect(added).toEqual({
      "group-plain": "disabled",
      "group-fe-plain": "disabled",
      "group-action": "disabled",
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

  it("后续 sync 增量：表外新名一律 disabled（市场手动安装）", () => {
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
        // action 壳增量也不自动装
        {
          name: "colleague-action",
          relDir: "skills/common/colleague-action",
        },
      ],
      known: new Set(["fe-helper"]),
      isFirstInit: false,
    });
    // known 不动；新名默认未安装
    expect(added).toEqual({
      "new-one": "disabled",
      "colleague-action": "disabled",
    });
  });

  it("同批重名首个胜出、不重复写入（首次）", () => {
    const added = computeDefaultSkillStates({
      skills: [
        { name: "x", relDir: "skills/common/x" },
        { name: "x", relDir: "knowledge/skills/frontend/app/x" },
      ],
      known: new Set(),
      isFirstInit: true,
    });
    expect(added).toEqual({ x: "disabled" }); // 同批首个在 skills/ → 共享未装
  });
});

/**
 * 损坏保护语义：apply 层 trusted:false 直接 return，绝不当「空表首次」。
 * 纯函数侧无法覆盖 IO；这里用契约注释 + 既有 skills-loader-team 集成测兜底。
 * 下面这条断言「调用方必须传 isFirstInit、不得省略」——缺参在类型层已拦。
 */
describe("computeDefaultSkillStates 损坏保护契约", () => {
  it("损坏场景绝不当首次：即便 known 空，isFirstInit=false 也写 disabled（apply 层应先跳过）", () => {
    // 模拟「若错误地把损坏当空表」时的纯函数结果——应是 disabled 而非 enabled；
    // 真实 applyDefaultSkillStates 在 trusted:false 时根本不会调用本函数。
    const added = computeDefaultSkillStates({
      skills: [{ name: "keep-off", relDir: "skills/fe/keep-off" }],
      known: new Set(),
      isFirstInit: false,
    });
    expect(added).toEqual({ "keep-off": "disabled" });
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
      parseGitLabRepoUrl(
        "https://gitlab.wukongedu.net/wukong/wk-harness-platform.git",
      ),
    ).toEqual({
      host: "gitlab.wukongedu.net",
      projectPath: "wukong/wk-harness-platform",
    });
  });

  it("非法 URL / 空 path → null", () => {
    expect(parseGitLabRepoUrl("not-a-url")).toBeNull();
    expect(parseGitLabRepoUrl("https://gitlab.example.com/")).toBeNull();
  });
});

/**
 * 知识库源仓迁移（2026-07-27）：wukong/wk-knowledgebase → wukong/wk-harness-platform。
 * canMirror 探测、镜像 clone 都读 knowledgeSourceUrl，锁死默认值防回退到 404 旧路径。
 */
describe("知识库源仓默认配置", () => {
  it("默认源仓指向 wk-harness-platform、旧路径不再出现", () => {
    expect(DEFAULT_TEAM_LIBRARY.knowledgeSourceUrl).toBe(
      "https://gitlab.wukongedu.net/wukong/wk-harness-platform.git",
    );
    expect(DEFAULT_TEAM_LIBRARY.knowledgeSourceUrl).not.toContain(
      "wk-knowledgebase",
    );
  });

  it("兜底分支是 release/1.0（新仓默认分支、不是 main）", () => {
    expect(DEFAULT_TEAM_LIBRARY.knowledgeSourceBranch).toBe("release/1.0");
  });
});

describe("parseSymrefDefaultBranch", () => {
  it("解析 ls-remote --symref 输出里的默认分支（含带斜杠的分支名）", () => {
    const stdout =
      "ref: refs/heads/release/1.0\tHEAD\n" +
      "ed319c8b81358256217570f5b38c329ad0487409\tHEAD\n";
    expect(parseSymrefDefaultBranch(stdout)).toBe("release/1.0");
  });

  it("默认分支是 main 时同样解析得到", () => {
    expect(
      parseSymrefDefaultBranch("ref: refs/heads/main\tHEAD\n<sha>\tHEAD\n"),
    ).toBe("main");
  });

  it("无 symref 行 / 空输出 → null（调用方回退配置值）", () => {
    expect(parseSymrefDefaultBranch("")).toBeNull();
    expect(parseSymrefDefaultBranch("ed319c8\tHEAD\n")).toBeNull();
    // 只有 tag ref、没有 HEAD symref
    expect(
      parseSymrefDefaultBranch("ref: refs/tags/v1\trefs/tags/v1\n"),
    ).toBeNull();
  });
});

describe("resolveMirrorSourceBranch", () => {
  it("探到默认分支 → 用探测值（对方改默认分支我们自动跟上）", () => {
    expect(resolveMirrorSourceBranch("release/1.0", "main")).toBe("release/1.0");
  });

  it("探不到 → 回退配置值", () => {
    expect(resolveMirrorSourceBranch(null, "release/1.0")).toBe("release/1.0");
  });

  it("探到非法分支名 → 不拼进 git 参数、回退配置值", () => {
    // 分支名要被拼进 `clone --branch` / `fetch`，`..`、前导横杠、空格一律拒
    expect(resolveMirrorSourceBranch("../evil", "main")).toBe("main");
    expect(resolveMirrorSourceBranch("-upload-pack=x", "main")).toBe("main");
    expect(resolveMirrorSourceBranch("has space", "main")).toBe("main");
    expect(resolveMirrorSourceBranch("", "main")).toBe("main");
  });
});

/** 真跑 `git ls-remote --symref`：锁死输出格式契约（parse 不是照着记忆写的） */
describe("git ls-remote --symref 输出格式契约", () => {
  const TMP = path.join(os.tmpdir(), `fe-symref-${Date.now()}`);
  const bareDir = path.join(TMP, "bare.git");

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("远端 HEAD 指向 release/1.0 → 能解析出 release/1.0", async () => {
    await fs.mkdir(TMP, { recursive: true });
    // 默认分支刻意设成带斜杠的 release/1.0（对齐真实源仓、且不是 main）
    await execFileAsync("git", ["init", "--bare", "-b", "release/1.0", bareDir]);
    const seed = path.join(TMP, "seed");
    await fs.mkdir(seed, { recursive: true });
    await fs.writeFile(path.join(seed, "README.md"), "seed\n", "utf-8");
    await execFileAsync("git", ["init", "-b", "release/1.0"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: seed });
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: seed });
    await execFileAsync("git", ["push", bareDir, "release/1.0"], { cwd: seed });

    const { stdout } = await execFileAsync("git", [
      "ls-remote",
      "--symref",
      bareDir,
      "HEAD",
    ]);
    expect(parseSymrefDefaultBranch(stdout)).toBe("release/1.0");
  });
});

/**
 * 镜像拷贝：顶层排除 + 整体替换。
 * 排除清单是单一来源常量（MIRROR_EXCLUDED_TOP_DIRS），不是散落各处的路径判断。
 */
describe("copyTree（镜像排除 + 整体替换）", () => {
  const TMP = path.join(os.tmpdir(), `fe-mirror-copy-${Date.now()}`);
  const src = path.join(TMP, "src");
  const dest = path.join(TMP, "dest");

  const write = async (rel: string, body: string): Promise<void> => {
    const abs = path.join(src, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf-8");
  };
  const exists = async (rel: string): Promise<boolean> =>
    !!(await fs.stat(path.join(dest, rel)).catch(() => null));

  beforeAll(async () => {
    await write("knowledge-base/projects/a.md", "kb\n");
    await write("skills/global/wk-harness/SKILL.md", "skill\n");
    await write("scripts/gate.py", "print(1)\n");
    await write(".gitignore", "codes/\n");
    // 排除目标
    await write("harness-delivery-hub/delivery-server/main.ts", "server\n");
    await write("codes/backend/Z.java", "java\n");
    // 通用跳过项
    await write(".DS_Store", "junk\n");
    await write("__pycache__/x.pyc", "junk\n");
    await write("scripts/stale.pyc", "junk\n");
    // 同名但不在顶层——不该被误伤（排除只认顶层）
    await write("skills/global/harness-delivery-hub/SKILL.md", "nested\n");

    // dest 预置存量（模拟旧结构的老镜像），验证整体替换
    await fs.mkdir(path.join(dest, "legacy"), { recursive: true });
    await fs.writeFile(path.join(dest, "legacy", "old.md"), "old\n", "utf-8");

    await copyTree(src, dest, {
      clearDest: true,
      excludeTopNames: MIRROR_EXCLUDED_TOP_DIRS,
    });
  });

  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("知识内容三件套 + .gitignore 都拷过去", async () => {
    expect(await exists("knowledge-base/projects/a.md")).toBe(true);
    expect(await exists("skills/global/wk-harness/SKILL.md")).toBe(true);
    expect(await exists("scripts/gate.py")).toBe(true);
    expect(await exists(".gitignore")).toBe(true);
  });

  it("顶层 harness-delivery-hub / codes 被排除", async () => {
    expect(await exists("harness-delivery-hub")).toBe(false);
    expect(await exists("codes")).toBe(false);
  });

  it("排除只认顶层——深层同名目录不误伤", async () => {
    expect(await exists("skills/global/harness-delivery-hub/SKILL.md")).toBe(
      true,
    );
  });

  it(".DS_Store / __pycache__ / *.pyc 一律跳过", async () => {
    expect(await exists(".DS_Store")).toBe(false);
    expect(await exists("__pycache__")).toBe(false);
    expect(await exists("scripts/stale.pyc")).toBe(false);
  });

  it("clearDest：dest 里的存量老结构被整体清掉、不留幽灵", async () => {
    expect(await exists("legacy/old.md")).toBe(false);
    expect(await exists("legacy")).toBe(false);
  });
});

/**
 * knowledge/ 是整库机器镜像、豁免敏感扫描。
 * 不豁免的话高熵规则会把 py 标识符 / 文档示例 URL 全判成密钥
 *（实测一次常规镜像 18 个变更文件命中 106 处、无一为真）、镜像永久推不上去。
 */
describe("shouldScanStagedPath（敏感扫描豁免面）", () => {
  it("knowledge/ 下一律豁免", () => {
    expect(shouldScanStagedPath("knowledge/skills/global/wk/x.py")).toBe(false);
    expect(shouldScanStagedPath("knowledge/knowledge-base/a.md")).toBe(false);
    expect(shouldScanStagedPath("knowledge/.gitignore")).toBe(false);
  });

  it("用户上传面 skills/ 仍然要扫", () => {
    expect(shouldScanStagedPath("skills/fe/my-skill/SKILL.md")).toBe(true);
    expect(shouldScanStagedPath("README.md")).toBe(true);
  });

  it("同名前缀不误豁免（knowledge-notes/ 不是 knowledge/）", () => {
    expect(shouldScanStagedPath("knowledge-notes/a.md")).toBe(true);
  });

  it("Windows 反斜杠路径也认得出豁免前缀", () => {
    expect(shouldScanStagedPath("knowledge\\skills\\a.py")).toBe(false);
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
/**
 * 数据分支（成员注册表）读改写——真跑 git（本地 bare 远端、不碰网络）。
 *
 * 最要紧的不变量：**主克隆的 HEAD / 索引 / 工作树全程不能被动**——团队库主克隆
 * 同时被 skill 同步 / 上传 / 镜像链路使用，切走 HEAD 会直接搞坏它们。
 */
describe("writeTeamLibraryBranchFile / readTeamLibraryBranchFile（数据分支）", () => {
  const TMP = path.join(os.tmpdir(), `fe-tl-branch-${Date.now()}`);
  const bareDir = path.join(TMP, "bare.git");
  const dataDir = path.join(TMP, "data");
  const repoDir = path.join(dataDir, "team-library", "repo");
  const FILE = "group-members.json";
  const prevDataDir = process.env.FLOWSHIP_DATA_DIR;

  /** 在 bare 远端上跑 git（断言远端状态） */
  const inBare = async (args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: bareDir })).stdout.trim();

  /** 在主克隆上跑 git（断言它没被动过） */
  const inClone = async (args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: repoDir })).stdout.trim();

  beforeAll(async () => {
    await fs.mkdir(TMP, { recursive: true });
    await execFileAsync("git", ["init", "--bare", "-b", "main", bareDir]);

    const seed = path.join(TMP, "seed");
    await fs.mkdir(path.join(seed, "skills"), { recursive: true });
    await fs.writeFile(path.join(seed, "skills", "keep.md"), "seed\n", "utf-8");
    await execFileAsync("git", ["init", "-b", "main"], { cwd: seed });
    await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: seed });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: seed });
    await execFileAsync("git", ["add", "."], { cwd: seed });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: seed });
    await execFileAsync("git", ["push", bareDir, "main"], { cwd: seed });

    await fs.mkdir(dataDir, { recursive: true });
    await execFileAsync("git", [
      "clone",
      "--branch",
      "main",
      "--single-branch",
      bareDir,
      repoDir,
    ]);
    // commit-tree 要提交者身份；测试里显式配死，别依赖跑测机器的全局 git config
    await execFileAsync("git", ["config", "user.email", "t@t.com"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoDir });

    // readGitToken 读 <dataRoot>/config.json；dataRoot 每次调用现读 env
    await fs.writeFile(
      path.join(dataDir, "config.json"),
      JSON.stringify({ gitToken: "dummy-token" }),
      "utf-8",
    );
    process.env.FLOWSHIP_DATA_DIR = dataDir;
  });

  afterAll(async () => {
    if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it("分支不存在 → 建孤儿分支首推；主克隆 HEAD / 工作树纹丝不动", async () => {
    const headBefore = await inClone(["rev-parse", "HEAD"]);

    const r = await writeTeamLibraryBranchFile({
      relPath: FILE,
      mutate: () => '{"version":1,"members":{}}\n',
      message: "chore: 首次创建注册表",
    });
    expect(r).toEqual({ ok: true, changed: true });

    // 远端：分支建出来了，且是**孤儿**（只有一条根提交、树里只有这一个文件）
    expect(await inBare(["rev-list", "--count", TEAM_LIBRARY_DATA_BRANCH])).toBe("1");
    expect(await inBare(["ls-tree", "-r", "--name-only", TEAM_LIBRARY_DATA_BRANCH])).toBe(
      FILE,
    );
    // main 一点没被碰
    expect(await inBare(["ls-tree", "-r", "--name-only", "main"])).toBe(
      "skills/keep.md",
    );

    // 主克隆：还在 main、HEAD 没挪、工作树干净（没有多出 group-members.json）
    expect(await inClone(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await inClone(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await inClone(["status", "--porcelain"])).toBe("");
    await expect(fs.access(path.join(repoDir, FILE))).rejects.toThrow();
  });

  it("读走 origin/<branch>；内容原样（不受 runGit 脱敏影响）", async () => {
    await expect(readTeamLibraryBranchFile({ relPath: FILE })).resolves.toBe(
      '{"version":1,"members":{}}\n',
    );
  });

  it("幂等：mutate 返 null / 内容没变 → 不造提交", async () => {
    const before = await inBare(["rev-parse", TEAM_LIBRARY_DATA_BRANCH]);

    await expect(
      writeTeamLibraryBranchFile({
        relPath: FILE,
        mutate: () => null,
        message: "不该发生",
      }),
    ).resolves.toEqual({ ok: true, changed: false });
    await expect(
      writeTeamLibraryBranchFile({
        relPath: FILE,
        mutate: (cur) => cur,
        message: "不该发生",
      }),
    ).resolves.toEqual({ ok: true, changed: false });

    expect(await inBare(["rev-parse", TEAM_LIBRARY_DATA_BRANCH])).toBe(before);
  });

  it("并发写：push 被拒后重新 fetch 重来，拿到对手的最新内容再合并", async () => {
    const seen: Array<string | null> = [];
    let raced = false;

    const r = await writeTeamLibraryBranchFile({
      relPath: FILE,
      mutate: async (cur) => {
        seen.push(cur);
        // 第一轮：在我们 push 之前，模拟同事抢先推了一条（制造 non-fast-forward）
        if (!raced) {
          raced = true;
          const rival = path.join(TMP, "rival");
          await fs.rm(rival, { recursive: true, force: true });
          await execFileAsync("git", [
            "clone",
            "--branch",
            TEAM_LIBRARY_DATA_BRANCH,
            "--single-branch",
            bareDir,
            rival,
          ]);
          await execFileAsync("git", ["config", "user.email", "r@r.com"], { cwd: rival });
          await execFileAsync("git", ["config", "user.name", "r"], { cwd: rival });
          await fs.writeFile(path.join(rival, FILE), '{"peer":true}\n', "utf-8");
          await execFileAsync("git", ["add", "-A"], { cwd: rival });
          await execFileAsync("git", ["commit", "-m", "peer"], { cwd: rival });
          await execFileAsync("git", ["push", "origin", TEAM_LIBRARY_DATA_BRANCH], {
            cwd: rival,
          });
        }
        return '{"mine":true}\n';
      },
      message: "chore: 并发写",
    });

    expect(r).toEqual({ ok: true, changed: true });
    // mutate 被调了两轮；第二轮看到的是对手推上去的最新内容（不是第一轮那份）
    expect(seen).toEqual(['{"version":1,"members":{}}\n', '{"peer":true}\n']);
    // 最终远端是我们的内容，且历史上对手那条提交还在（我们是接在它后面的）
    expect(await inBare(["show", `${TEAM_LIBRARY_DATA_BRANCH}:${FILE}`])).toBe(
      '{"mine":true}',
    );
    expect(
      Number(await inBare(["rev-list", "--count", TEAM_LIBRARY_DATA_BRANCH])),
    ).toBe(3);
    // 全程主克隆仍在 main、工作树干净
    expect(await inClone(["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(await inClone(["status", "--porcelain"])).toBe("");
  });

  it("分支 / 文件不存在 → 读返回 null（调用方降级）", async () => {
    await expect(
      readTeamLibraryBranchFile({ relPath: FILE, branch: "no-such-branch" }),
    ).resolves.toBeNull();
    await expect(
      readTeamLibraryBranchFile({ relPath: "not-there.json" }),
    ).resolves.toBeNull();
  });

  it("非法文件名 / 分支名一律拒绝（拼进 refspec 前的白名单）", async () => {
    await expect(
      readTeamLibraryBranchFile({ relPath: "../escape.json" }),
    ).resolves.toBeNull();
    await expect(
      writeTeamLibraryBranchFile({
        relPath: "sub/dir.json",
        mutate: () => "x",
        message: "m",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      writeTeamLibraryBranchFile({
        relPath: FILE,
        branch: "--upload-pack=evil",
        mutate: () => "x",
        message: "m",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("scanSensitiveFiles / 敏感上传闸", () => {
  it("脱敏只露前 3 字符", () => {
    expect(redactSecretValue("abcdefgh")).toBe("abc***");
    expect(redactSecretValue("ab")).toBe("***");
    expect(redactSecretValue("")).toBe("***");
  });

  it("命中 credential-key / private-key / connection-string / pgpass / high-entropy", () => {
    const hits = scanSensitiveFiles([
      {
        path: "skills/fe/demo/config.env",
        content: [
          "password=SuperSecretValue99",
          "api_key: sk-live-abcdef012345",
          "-----BEGIN RSA PRIVATE KEY-----",
          "postgresql://admin:DbPassw0rd!@db.example.com:5432/app",
          "https://user:HttpPass99@example.com/path",
          "db.example.com:5432:mydb:admin:PgPassHunter2",
          "AUTH_TOKEN=aB3dE5fG7hI9jK1lM2nOpQr",
        ].join("\n"),
      },
    ]);
    const kinds = new Set(hits.map((h) => h.kind));
    expect(kinds.has("credential-key")).toBe(true);
    expect(kinds.has("private-key")).toBe(true);
    expect(kinds.has("connection-string")).toBe(true);
    expect(kinds.has("pgpass")).toBe(true);
    expect(kinds.has("high-entropy")).toBe(true);
    // 绝不回传完整密文
    for (const h of hits) {
      expect(h.snippet).toContain("***");
      expect(h.snippet).not.toContain("SuperSecretValue99");
      expect(h.snippet).not.toContain("DbPassw0rd!");
      expect(h.snippet).not.toContain("PgPassHunter2");
      expect(h.snippet).not.toContain("aB3dE5fG7hI9jK1lM2nOpQr");
    }
  });

  it("占位符 / 空值不误报", () => {
    expect(isPlaceholderSecretValue("【填写】")).toBe(true);
    expect(isPlaceholderSecretValue("<your-password>")).toBe(true);
    expect(isPlaceholderSecretValue("your-api-key")).toBe(true);
    expect(isPlaceholderSecretValue("xxx")).toBe(true);
    expect(isPlaceholderSecretValue("")).toBe(true);
    expect(isPlaceholderSecretValue("$GITLAB_TOKEN")).toBe(true);

    const hits = scanSensitiveFiles([
      {
        path: "skills/fe/tpl/SKILL.md",
        content: [
          "password=【填写】",
          "passwd: <password>",
          "api_key=your-api-key-here",
          'token: "xxx"',
          "secret=",
          "pwd: $API_TOKEN",
          // hash 语境长 hex 不报高熵
          "sha256:abcdef0123456789abcdef0123456789ab",
          "commit: deadbeefdeadbeefdeadbeefdeadbeef",
        ].join("\n"),
      },
    ]);
    expect(hits).toEqual([]);
  });

  it("二进制内容跳过", () => {
    const hits = scanSensitiveFiles([
      {
        path: "skills/fe/demo/blob.bin",
        content: `password=SuperSecretValue99\0more`,
      },
    ]);
    expect(hits).toEqual([]);
  });

  it("force 放行 / 未 force 阻断", () => {
    const hits = scanSensitiveFiles([
      {
        path: "a.env",
        content: "password=RealSecretValue1\n",
      },
    ]);
    expect(hits.length).toBeGreaterThan(0);
    expect(gateSensitiveUpload(hits, false)).toEqual({
      blocked: true,
      hits,
    });
    expect(gateSensitiveUpload(hits, true)).toEqual({ blocked: false });
    expect(gateSensitiveUpload([], false)).toEqual({ blocked: false });
    expect(formatSensitiveScanError(hits)).toMatch(/阻断上传/);
  });
});
