/**
 * 第五轮 Q4-01 服务端兜底：设置 API（PUT / PATCH）拒收「新加的」UNC / WSL / 非本机磁盘仓库路径。
 *
 * 设置页登记仓库时前端已拒收，但 API 谁都能调（脚本 / 旧页面 / 手改请求）；不挡的话这类路径会躺进 config.json，
 * 之后 repo-branches / 建任务都 400、被前端吞成「非 git 仓库」。
 *
 * 口径（与 validateCustomProvidersInput 一致）：只拒**盘上原本没有的**路径。升级前登记的旧 UNC 仓库仍随整包 PUT
 * 原样带回——逐条校验会让用户改任何无关开关都被 400 挡住，也会堵死「把它删掉」的路。
 *
 * 真实 route handler + 真实 settings-fs，落临时数据目录；副作用模块 mock 掉（同 settings-put-route.test.ts）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-repo-guard-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/git-token-env", () => ({ syncGitTokenEnv: vi.fn() }));
vi.mock("@/lib/server/gitlab-host", () => ({
  pinTrustedGitHostFromSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  invalidateMrInboxCache: vi.fn(),
}));
vi.mock("@/lib/server/agent-shell", () => ({
  applyAgentShellPreference: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/company-env-fs", () => ({
  syncCompanyEnvFileFromObject: vi.fn(async () => undefined),
}));

import { PATCH, PUT } from "@/app/api/settings/route";
import { settingsFilePath, validateNewRepoPaths } from "@/lib/server/settings-fs";

const UNC_REPO = { name: "share", path: "//attacker.example/share/repo" };
const LOCAL_REPO = { name: "web", path: "/repo/web" };

const baseConfig = (repos: unknown[]) => ({
  apiKey: "sk-route-test-key-0001",
  defaultModel: { id: "composer-2" },
  repos,
});

const send = (method: "PUT" | "PATCH", body: unknown): Promise<Response> =>
  (method === "PUT" ? PUT : PATCH)(
    new Request("http://localhost/api/settings", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const writeDisk = (cfg: unknown): Promise<void> =>
  fs.writeFile(settingsFilePath(), JSON.stringify(cfg), "utf-8");
const readDisk = async (): Promise<{ repos: Array<{ path: string }> }> =>
  JSON.parse(await fs.readFile(settingsFilePath(), "utf-8"));

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await writeDisk(baseConfig([LOCAL_REPO]));
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("validateNewRepoPaths（纯函数）", () => {
  it("新增 UNC / file://host 路径 → 返回含路径与原因的文案；全是本机路径 → null", () => {
    const bad = validateNewRepoPaths([LOCAL_REPO, UNC_REPO], [LOCAL_REPO], "darwin");
    expect(bad).toContain("//attacker.example/share/repo");
    expect(bad).toContain("UNC");
    expect(validateNewRepoPaths([LOCAL_REPO], [], "darwin")).toBeNull();
    const hint = validateNewRepoPaths([{ path: "file://Users/me/repo" }], [], "darwin");
    expect(hint).toContain("file:///Users/me/repo");
  });

  it("盘上已有的旧 UNC 仓库不重复拒（改别的开关 / 删它的路不被堵）；不是数组 / 缺 path 的条目忽略", () => {
    expect(validateNewRepoPaths([UNC_REPO], [UNC_REPO], "darwin")).toBeNull();
    expect(validateNewRepoPaths("nope", [], "darwin")).toBeNull();
    expect(validateNewRepoPaths([null, {}, { path: 1 }], [], "darwin")).toBeNull();
    // 盘上读不到（undefined）= 全部视为新增
    expect(validateNewRepoPaths([UNC_REPO], undefined, "darwin")).not.toBeNull();
  });

  it("Windows 语义（注入 win32）：WSL / 根相对路径这类非盘符路径新增同样拒", () => {
    expect(validateNewRepoPaths([{ path: "\\\\wsl$\\Ubuntu\\home\\me\\repo" }], [], "win32")).not.toBeNull();
    expect(validateNewRepoPaths([{ path: "/home/me/repo" }], [], "win32")).not.toBeNull();
    expect(validateNewRepoPaths([{ path: "C:\\code\\repo" }], [], "win32")).toBeNull();
  });
});

describe("PUT /api/settings：新加 UNC 仓库 → 400，盘上不动", () => {
  it("整包 PUT 里新增一条 UNC 仓库 → 400 + 原因；盘上仍只有原来的本机仓库", async () => {
    const res = await send("PUT", baseConfig([LOCAL_REPO, UNC_REPO]));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("不可用");
    expect(error).toContain("UNC");
    expect((await readDisk()).repos.map((r) => r.path)).toEqual(["/repo/web"]);
  });

  it("反例（旧行为仍成立）：只新增本机仓库 → 200 并落盘", async () => {
    const extra = { name: "api", path: "/repo/api" };
    const res = await send("PUT", baseConfig([LOCAL_REPO, extra]));
    expect(res.status).toBe(200);
    expect((await readDisk()).repos.map((r) => r.path)).toEqual(["/repo/web", "/repo/api"]);
  });

  it("盘上已有的旧 UNC 仓库：整包 PUT 带回它（改无关开关）仍 200；把它删掉也 200", async () => {
    await writeDisk(baseConfig([LOCAL_REPO, UNC_REPO]));
    const keep = await send("PUT", { ...baseConfig([LOCAL_REPO, UNC_REPO]), someToggle: true });
    expect(keep.status).toBe(200);
    expect((await readDisk()).repos.map((r) => r.path)).toContain(UNC_REPO.path);
    const drop = await send("PUT", baseConfig([LOCAL_REPO]));
    expect(drop.status).toBe(200);
    expect((await readDisk()).repos.map((r) => r.path)).toEqual(["/repo/web"]);
  });
});

describe("PATCH /api/settings：补丁里新加 UNC 仓库 → 400", () => {
  it("patch.repos 新增 UNC → 400，盘上不动；新增本机仓库 → 200", async () => {
    const bad = await send("PATCH", { patch: { repos: [LOCAL_REPO, UNC_REPO] } });
    expect(bad.status).toBe(400);
    expect((await readDisk()).repos.map((r) => r.path)).toEqual(["/repo/web"]);

    const ok = await send("PATCH", { patch: { repos: [LOCAL_REPO, { name: "api", path: "/repo/api" }] } });
    expect(ok.status).toBe(200);
    expect((await readDisk()).repos.map((r) => r.path)).toEqual(["/repo/web", "/repo/api"]);
  });

  it("补丁不带 repos（改别的字段）→ 不受影响，即使盘上有旧 UNC 仓库", async () => {
    await writeDisk(baseConfig([LOCAL_REPO, UNC_REPO]));
    const res = await send("PATCH", { patch: { someToggle: true } });
    expect(res.status).toBe(200);
    expect((await readDisk()).repos.map((r) => r.path)).toContain(UNC_REPO.path);
  });
});
