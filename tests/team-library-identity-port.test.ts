/**
 * 共享库「GitLab 上传身份」缓存的端口口径（P3 的最后一个比较点）
 *
 * getGitLabUploadIdentity 按 `${host}:${tokenDigest}` 缓存 5 分钟，host 来自共享库地址的 `URL.host`（带非默认端口）。
 * 缓存 key 若丢了端口，同一台机器上另一个端口的服务（另一个 GitLab 实例）会直接复用前一个实例上查到的身份：
 * 既不会向新目的地发身份查询，上传 / 覆盖的归属判定也拿着「别的实例的 userId」去比。
 *
 * 钉三件事：
 *   ① 对照：同一地址、同一 token 第二次查 → 命中缓存、不再发请求（否则下面的断言不能证明「key 带端口」）；
 *   ② 同主机不同端口、同一 token → 不命中缓存，真的向 `https://host:8443/api/v4/user` 发新请求；
 *   ③ 请求目的地是带端口的那个地址（不是去掉端口后的 443）。
 *
 * 入口用 getTeamUploadPermissions（只读 token + 配置 + 身份查询，不 clone、不推送）。只用假 token、临时数据目录。
 * 身份里的 host 字段刻意只存主机名（见 team-library.ts 该处注释），不在这里钉。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { getTeamUploadPermissions } from "@/lib/server/team-library";

const TMP = path.join(os.tmpdir(), `fe-tl-identity-port-${Date.now()}`);
const DATA_DIR = path.join(TMP, "data");
// 每个测试文件独占的假 token：身份缓存是模块级 Map，key 含 token 摘要，避免与别的用例互相命中
const FAKE_TOKEN = `glpat-FAKE-IDENTITY-PORT-${Math.random().toString(36).slice(2)}`;

let savedDataDir: string | undefined;
let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
/** 记录每次发出的身份查询目的地 */
const fetchedUrls: string[] = [];

const useRepoUrl = async (repoUrl: string): Promise<void> => {
  await fs.writeFile(
    path.join(DATA_DIR, "team-library.json"),
    JSON.stringify({ repoUrl, branch: "main" }),
    "utf-8",
  );
};

/** 触发一次身份查询；后面读本地库目录失败与否无所谓，这里只关心发了哪些请求 */
const probeIdentity = async (): Promise<void> => {
  await getTeamUploadPermissions().catch(() => null);
};

beforeAll(async () => {
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  await fs.mkdir(DATA_DIR, { recursive: true });
  process.env.FLOWSHIP_DATA_DIR = DATA_DIR;
  await fs.writeFile(
    path.join(DATA_DIR, "config.json"),
    JSON.stringify({ gitToken: FAKE_TOKEN }),
    "utf-8",
  );
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    fetchedUrls.push(String(input));
    return new Response(
      JSON.stringify({ id: 101, username: "alice", name: "Alice", email: "alice@example.com" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  fetchedUrls.length = 0;
});

afterAll(async () => {
  fetchSpy?.mockRestore();
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("共享库身份缓存：key 含端口", () => {
  it("同地址同 token：第二次命中缓存；同主机不同端口：不命中、向带端口的目的地发新请求", async () => {
    // ① 默认端口地址：首次查询发请求，目的地不带端口
    await useRepoUrl("https://gitlab.idport.test/grp/lib.git");
    await probeIdentity();
    expect(fetchedUrls).toEqual(["https://gitlab.idport.test/api/v4/user"]);

    // 对照：同地址再查一次 → 命中缓存、零新增请求（证明缓存真实生效，下面「不命中」才有说服力）
    await probeIdentity();
    expect(fetchedUrls).toEqual(["https://gitlab.idport.test/api/v4/user"]);

    // ② 同主机、非默认端口、同一 token：必须当作另一个实例，重新查
    await useRepoUrl("https://gitlab.idport.test:8443/grp/lib.git");
    await probeIdentity();
    expect(fetchedUrls).toEqual([
      "https://gitlab.idport.test/api/v4/user",
      // ③ 目的地带端口（不是去掉端口后的 443）
      "https://gitlab.idport.test:8443/api/v4/user",
    ]);

    // 带端口的那份同样会被缓存
    await probeIdentity();
    expect(fetchedUrls).toHaveLength(2);

    // 再换一个端口：又是新实例
    await useRepoUrl("https://gitlab.idport.test:9443/grp/lib.git");
    await probeIdentity();
    expect(fetchedUrls.at(-1)).toBe("https://gitlab.idport.test:9443/api/v4/user");
    expect(fetchedUrls).toHaveLength(3);
  });
});
