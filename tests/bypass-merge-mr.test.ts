/**
 * 旁路合 test MR（bypass-merge-mr）：test 分支专用、线上分支与未知分支默认拒绝。
 *
 * 注：旁路已改 honor-system（提示词-only），本工具当前未接线，转为单元覆盖留着。
 *
 * 钉四件事：
 * 1. 目标分支守卫（纯函数）：测试分支放行、线上分支拒绝、其余拒绝；
 * 2. 全流程只合 test 目标：MR 详情 target=qa → 调 mergeMR；target=master/feat-x/closed → 不调；
 * 3. token 不出服务端：host 不在 allowlist / 无 token / URL 坏 → 不发起 GitLab 请求；
 * 4. 工具链挂载：buildReadOnlyToolDefs 里有 merge_test_mr，def.execute 真链路可跑（mock 网络）。
 */
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/gitlab-client", () => ({
  getMR: vi.fn(),
  mergeMR: vi.fn(),
}));

// mr-inbox-scanner 经 submit-mr-guard 拿各仓 host：mock 掉，不碰真 git remote
vi.mock("@/lib/server/submit-mr-guard", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  deriveHostFromRepo: vi.fn(async () => "gitlab.corp.com"),
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-bypass-merge-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");
const CWD = path.join(TMP_ROOT, "work");
await fs.mkdir(path.join(TMP_ROOT, "data"), { recursive: true });
await fs.mkdir(CWD, { recursive: true });

const { getMR, mergeMR } = await import("@/lib/server/gitlab-client");
const mockedGetMR = getMR as unknown as ReturnType<typeof vi.fn>;
const mockedMergeMR = mergeMR as unknown as ReturnType<typeof vi.fn>;

const {
  checkMergeTestTarget,
  collectBypassBranchSets,
  mergeTestMrForBypass,
} = await import("@/lib/server/bypass-merge-mr");
const { buildReadOnlyToolDefs } = await import("@/lib/server/pi-coding-tools");

const MR_URL = "https://gitlab.corp.com/fe/shop/-/merge_requests/12";
const SETTINGS = {
  gitToken: "tok-for-test",
  repos: [{ path: "/repo/shop", testBranch: "qa", onlineBranch: "master" }],
};
const writeSettings = (obj: unknown) =>
  fs.writeFile(path.join(TMP_ROOT, "data", "config.json"), JSON.stringify(obj));

beforeEach(async () => {
  vi.clearAllMocks();
  await writeSettings(SETTINGS);
});

const openedMr = (targetBranch: string, state = "opened") => ({
  ok: true,
  iid: 12,
  url: MR_URL,
  title: "t",
  description: "",
  state,
  sourceBranch: "feat-x",
  targetBranch,
});

describe("目标分支守卫（纯函数）", () => {
  const sets = {
    testBranches: ["test", "qa"],
    prodBranches: ["main", "master", "production"],
  };
  it("测试分支放行", () => {
    expect(checkMergeTestTarget("qa", sets).ok).toBe(true);
    expect(checkMergeTestTarget("test", sets).ok).toBe(true);
  });
  it("线上分支拒绝（大小写不敏感也拦）", () => {
    for (const b of ["main", "master", "production", "Master"]) {
      const r = checkMergeTestTarget(b, sets);
      expect(r.ok, b).toBe(false);
      expect(r.reason).toContain("线上分支");
    }
  });
  it("未知分支默认拒绝", () => {
    const r = checkMergeTestTarget("feat-x", sets);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("测试分支");
  });
  it("配置收集：各仓 testBranch/onlineBranch + 默认 test/main", () => {
    const got = collectBypassBranchSets({
      repos: [{ testBranch: " qa ", onlineBranch: "release" }, null, "x"],
    });
    expect(got.testBranches).toContain("qa");
    expect(got.testBranches).toContain("test");
    expect(got.prodBranches).toContain("release");
    expect(got.prodBranches).toContain("main");
  });
});

describe("全流程：只合 test 目标", () => {
  it("target=qa → 调 mergeMR 并报合并成功", async () => {
    mockedGetMR.mockResolvedValue(openedMr("qa"));
    mockedMergeMR.mockResolvedValue({ ok: true, iid: 12, url: MR_URL });
    const r = await mergeTestMrForBypass(MR_URL);
    expect(mockedMergeMR).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("已合并");
    expect(r.text).toContain("feat-x → qa");
  });

  it("target=master（线上）→ 不调 mergeMR", async () => {
    mockedGetMR.mockResolvedValue(openedMr("master"));
    const r = await mergeTestMrForBypass(MR_URL);
    expect(mockedMergeMR).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.text).toContain("线上分支");
    expect(r.text).toContain("任务所有者");
  });

  it("target=feat-x（未知）→ 不调 mergeMR", async () => {
    mockedGetMR.mockResolvedValue(openedMr("feat-x"));
    const r = await mergeTestMrForBypass(MR_URL);
    expect(mockedMergeMR).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.text).toContain("测试分支");
  });

  it("已关闭的 MR → 不用合", async () => {
    mockedGetMR.mockResolvedValue(openedMr("qa", "merged"));
    const r = await mergeTestMrForBypass(MR_URL);
    expect(mockedMergeMR).not.toHaveBeenCalled();
    expect(r.text).toContain("不用合");
  });

  it("合并失败（冲突）→ 报原因并指引找属主", async () => {
    mockedGetMR.mockResolvedValue(openedMr("qa"));
    mockedMergeMR.mockResolvedValue({ ok: false, error: "409 Conflict" });
    const r = await mergeTestMrForBypass(MR_URL);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("409 Conflict");
    expect(r.text).toContain("任务所有者");
  });

  it("详情拉取失败 → 不合", async () => {
    mockedGetMR.mockResolvedValue({ ok: false, error: "404 Not Found" });
    const r = await mergeTestMrForBypass(MR_URL);
    expect(mockedMergeMR).not.toHaveBeenCalled();
    expect(r.text).toContain("拉取失败");
  });
});

describe("token 不出服务端", () => {
  it("坏 URL → 不发起任何 GitLab 请求", async () => {
    const r = await mergeTestMrForBypass("not-a-mr-url");
    expect(r.text).toContain("无法解析");
    expect(mockedGetMR).not.toHaveBeenCalled();
    expect(mockedMergeMR).not.toHaveBeenCalled();
  });

  it("无 gitToken → 不发起请求", async () => {
    await writeSettings({ repos: SETTINGS.repos });
    const r = await mergeTestMrForBypass(MR_URL);
    expect(r.text).toContain("GitLab Token");
    expect(mockedGetMR).not.toHaveBeenCalled();
    expect(mockedMergeMR).not.toHaveBeenCalled();
  });

  it("host 不在 allowlist → 不带 token 出站", async () => {
    const r = await mergeTestMrForBypass(
      "https://evil.example.com/g/p/-/merge_requests/1",
    );
    expect(r.text).toContain("允许列表");
    expect(mockedGetMR).not.toHaveBeenCalled();
    expect(mockedMergeMR).not.toHaveBeenCalled();
  });
});

describe("工具链挂载", () => {
  it("buildReadOnlyToolDefs 里有 merge_test_mr，def.execute 真链路可跑", async () => {
    const defs = buildReadOnlyToolDefs(CWD, { taskId: "t1" });
    const names = defs.map((d) => (d as { name?: unknown }).name);
    expect(names).toContain("merge_test_mr");
    const tool = defs.find(
      (d) => (d as { name?: unknown }).name === "merge_test_mr",
    ) as unknown as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }>;
    };
    mockedGetMR.mockResolvedValue(openedMr("qa"));
    mockedMergeMR.mockResolvedValue({ ok: true, iid: 12, url: MR_URL });
    const out = await tool.execute("call-1", { mrUrl: MR_URL });
    expect(out.content.map((c) => c.text).join("\n")).toContain("已合并");
    const empty = await tool.execute("call-1", {});
    expect(empty.content.map((c) => c.text).join("\n")).toContain("mrUrl");
  });
});
