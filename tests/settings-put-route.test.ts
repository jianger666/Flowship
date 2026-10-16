/**
 * F6-02：PUT /api/settings 的请求体形状校验（真实 route handler + 真实 settings-fs，落临时数据目录）。
 *
 * 缺陷：原来只判 `typeof body !== "object"` ——
 * - `{}` 通过：整份配置被清空（apiKey / gitToken / 仓库全丢）；
 * - `[]` 通过：盘上无 config 时被原样写成 `[]`，读侧判损坏，此后所有 PUT 都 500。
 * 要求（第六轮加严）：PUT 是整对象覆盖，必须是「完整配置对象」——同时带 apiKey（字符串）/ defaultModel（普通对象）/
 * repos（数组），缺任一或类型不对 → 400。否则 `{repos: []}` / `{apiKey: ""}` 这类残缺体会被当成合法 PUT，
 * config.json 只剩这一个键、其余（API key / 偏好 / 仓库）全丢。清 key 的合法做法是「完整对象 + apiKey: ""」。
 * 唯一调用方 local-store.putSettings 永远整对象 PUT（normalizeSettings 保证三个字段必在）。
 *
 * 另外验证收缩备份 config.json.bak.shrink（路由 + 真实 settings-fs 的端到端）。
 *
 * 副作用模块（同步 env / 固定可信 host / 清收件箱缓存 / shell 偏好 / company-env.json）全部 mock 掉，
 * 只验「放不放行」与「盘上内容有没有被动」。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-put-route-${Date.now()}`);
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

import { PUT } from "@/app/api/settings/route";
import { DEFAULT_SETTINGS } from "@/lib/local-store";
import { settingsFilePath } from "@/lib/server/settings-fs";

// 与 client 整对象 PUT 同形：必带 apiKey（字符串）/ defaultModel（对象）/ repos（数组）
const GOOD_CONFIG = {
  apiKey: "sk-route-test-key-0001",
  gitToken: "glpat-route-test",
  defaultModel: { id: "composer-2" },
  repos: [{ name: "web", path: "/repo/web" }],
};
const GOOD_RAW = JSON.stringify(GOOD_CONFIG);

/** 直接发原始 body 串：绕开 JSON.stringify 对 undefined 等的改写 */
const putRaw = (raw: string): Promise<Response> =>
  PUT(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: raw,
    }),
  );
const putJson = (body: unknown): Promise<Response> => putRaw(JSON.stringify(body));

const readDisk = (): Promise<string> => fs.readFile(settingsFilePath(), "utf-8");

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(settingsFilePath(), GOOD_RAW, "utf-8");
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("F6-02 PUT /api/settings：请求体形状", () => {
  it.each([
    ["空数组 []", "[]"],
    ["非空数组", "[1,2,3]"],
    ["对象数组", '[{"apiKey":"x"}]'],
    ["null", "null"],
    ["字符串", '"abc"'],
    ["数字", "123"],
    ["布尔", "true"],
  ])("%s → 400，盘上配置逐字节不动", async (_name, raw) => {
    const res = await putRaw(raw);
    expect(res.status).toBe(400);
    expect(await readDisk()).toBe(GOOD_RAW);
  });

  it("盘上还没有 config.json 时 PUT [] → 400，且不会把 `[]` 写成配置文件（否则之后所有 PUT 都 500）", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    const res = await putRaw("[]");
    expect(res.status).toBe(400);
    await expect(fs.stat(settingsFilePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("空对象 {} → 400，不清空现有配置", async () => {
    const res = await putJson({});
    expect(res.status).toBe(400);
    expect(await readDisk()).toBe(GOOD_RAW);
  });

  it.each([
    ["只有陌生键", { foo: 1 }],
    ["上游错误体形状", { message: "Not Found", status: 404 }],
    ["嵌套着 settings 但根上没有已知键", { settings: { apiKey: "x" } }],
  ])("明显不是 settings 的对象（%s）→ 400，盘上不动", async (_name, body) => {
    const res = await putJson(body);
    expect(res.status).toBe(400);
    expect(await readDisk()).toBe(GOOD_RAW);
  });

  it("400 响应体带 error 文案，不回显请求内容", async () => {
    const res = await putJson({ foo: "SECRET-IN-BODY" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual(expect.any(String));
    expect(text).not.toContain("SECRET-IN-BODY");
  });
});

const bakPath = (): string => `${settingsFilePath()}.bak`;
const shrinkPath = (): string => `${settingsFilePath()}.bak.shrink`;
const exists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

describe("第六轮：PUT 必须是完整配置对象（缺 apiKey / defaultModel / repos 任一或类型不对 → 400）", () => {
  it.each<[string, unknown]>([
    ["只有 apiKey（空串）", { apiKey: "" }],
    ["只有 repos: []（评审实证：先写完整配置、再 PUT 它，config.json 只剩 repos）", { repos: [] }],
    ["只有一个偏好键", { jumpIde: "cursor" }],
    ["缺 defaultModel", { apiKey: "sk-x", repos: [] }],
    ["缺 repos", { apiKey: "sk-x", defaultModel: { id: "" } }],
    ["缺 apiKey", { defaultModel: { id: "" }, repos: [] }],
    ["apiKey 是数字", { ...GOOD_CONFIG, apiKey: 123 }],
    ["apiKey 是 null", { ...GOOD_CONFIG, apiKey: null }],
    ["defaultModel 是数组", { ...GOOD_CONFIG, defaultModel: [] }],
    ["defaultModel 是 null", { ...GOOD_CONFIG, defaultModel: null }],
    ["defaultModel 是字符串（老 schema）", { ...GOOD_CONFIG, defaultModel: "composer-2" }],
    ["repos 是对象", { ...GOOD_CONFIG, repos: {} }],
    ["repos 是 null", { ...GOOD_CONFIG, repos: null }],
  ])("%s → 400，盘上逐字节不动、不生成任何备份", async (_name, body) => {
    const res = await putJson(body);
    expect(res.status).toBe(400);
    expect(await readDisk()).toBe(GOOD_RAW);
    expect(await exists(bakPath())).toBe(false);
    expect(await exists(shrinkPath())).toBe(false);
  });

  it("盘上有完整配置时 PUT `{repos: []}` / `{apiKey: \"\"}` / `{}` / `[]` 全部 400，API key 与仓库都还在", async () => {
    for (const raw of ['{"repos":[]}', '{"apiKey":""}', "{}", "[]"]) {
      const res = await putRaw(raw);
      expect(res.status).toBe(400);
    }
    expect(JSON.parse(await readDisk())).toEqual(GOOD_CONFIG);
  });

  it("400 文案按字段名指出哪项缺失 / 类型不对，但不回显请求里的任何值", async () => {
    const res = await putJson({
      apiKey: 12345678,
      defaultModel: "SECRET-DM-VALUE",
      repos: "SECRET-REPOS-VALUE",
      extra: "SECRET-EXTRA-VALUE",
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    const error = JSON.parse(text).error as string;
    for (const field of ["apiKey", "defaultModel", "repos"]) {
      expect(error).toContain(field);
    }
    for (const leak of ["12345678", "SECRET-DM-VALUE", "SECRET-REPOS-VALUE", "SECRET-EXTRA-VALUE"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("只缺一项时只点名那一项（不连带指控其它字段）", async () => {
    const withoutRepos: Record<string, unknown> = { ...GOOD_CONFIG };
    delete withoutRepos.repos;
    const res = await putJson(withoutRepos);
    expect(res.status).toBe(400);
    const text = await res.text();
    const error = JSON.parse(text).error as string;
    expect(error).toContain("repos");
    expect(error).not.toContain("defaultModel");
    expect(error).not.toContain("apiKey");
    expect(text).not.toContain(GOOD_CONFIG.apiKey);
  });
});

describe("第六轮：完整配置对象仍然合法（不被误拒）", () => {
  it("带陌生键的真实配置（向前兼容：新版本字段不因校验被拒）→ 200 并落盘", async () => {
    const body = { ...GOOD_CONFIG, futureField: 1 };
    const res = await putJson(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(await readDisk())).toMatchObject(body);
  });

  it("完整对象 + apiKey: \"\"（用户主动清 key）→ 200，key 被清空、其余字段保留", async () => {
    const res = await putJson({ ...GOOD_CONFIG, apiKey: "" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await readDisk())).toEqual({ ...GOOD_CONFIG, apiKey: "" });
  });

  it("首次安装路径：client 整份 DEFAULT_SETTINGS（盘上无文件）→ 200", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    const res = await putJson(DEFAULT_SETTINGS);
    expect(res.status).toBe(200);
    expect(JSON.parse(await readDisk())).toMatchObject({ apiKey: "", repos: [] });
    // 首次落盘没有 previous：既不是收缩、也没有可备份的内容
    expect(await exists(bakPath())).toBe(false);
    expect(await exists(shrinkPath())).toBe(false);
  });
});

describe("第六轮：收缩备份 config.json.bak.shrink（路由 + 真实 settings-fs 端到端）", () => {
  const FULL = {
    ...GOOD_CONFIG,
    jumpIde: "cursor",
    repos: [
      { name: "web", path: "/repo/web" },
      { name: "api", path: "/repo/api" },
    ],
  };
  /** 先把盘上落成 FULL（repos 1→2 不是收缩）、再清空 repos 触发第一次收缩；返回收缩前的盘上原文 */
  const shrinkOnce = async (): Promise<string> => {
    expect((await putJson(FULL)).status).toBe(200);
    expect(await exists(shrinkPath())).toBe(false);
    const before = await readDisk();
    expect((await putJson({ ...FULL, repos: [] })).status).toBe(200);
    return before;
  };

  it("完整配置 → 同一份但 repos 清空：.bak.shrink 里是收缩前的完整配置（旧 repos 和 apiKey 都在）", async () => {
    const before = await shrinkOnce();
    const shrink = JSON.parse(await fs.readFile(shrinkPath(), "utf-8")) as typeof FULL;
    expect(shrink).toEqual(JSON.parse(before));
    expect(shrink.repos).toEqual(FULL.repos);
    expect(shrink.apiKey).toBe(FULL.apiKey);
    // 主文件确实被清空了 repos（收缩是合法写、只是留了后路）
    expect(JSON.parse(await readDisk())).toMatchObject({ apiKey: FULL.apiKey, repos: [] });
  });

  it("之后连续普通保存（不收缩）：.bak.shrink 逐字节不变，.bak 照常滚动", async () => {
    await shrinkOnce();
    const shrinkRaw = await fs.readFile(shrinkPath(), "utf-8");
    const cleared = { ...FULL, repos: [] };

    const saves = [
      { ...cleared, jumpIde: "vscode" },
      { ...cleared, jumpIde: "vscode", apiKey: "sk-route-test-key-rotated" },
      { ...cleared, jumpIde: "cursor", gitToken: "glpat-rotated" },
    ];
    for (const body of saves) {
      const beforeThis = await readDisk();
      expect((await putJson(body)).status).toBe(200);
      // 普通保存只滚 .bak（= 这次覆盖前的内容），不碰 .bak.shrink
      expect(await fs.readFile(bakPath(), "utf-8")).toBe(beforeThis);
      expect(await fs.readFile(shrinkPath(), "utf-8")).toBe(shrinkRaw);
    }
    // 误清之后连存三次、.bak 早被清空后的状态顶掉，好备份只剩 .bak.shrink
    expect(JSON.parse(await fs.readFile(bakPath(), "utf-8")).repos).toEqual([]);
    expect(JSON.parse(shrinkRaw).repos).toEqual(FULL.repos);
  });

  it("再次发生收缩才覆盖 .bak.shrink（内容变成这次收缩前的配置）", async () => {
    await shrinkOnce();
    const firstShrinkRaw = await fs.readFile(shrinkPath(), "utf-8");
    // 普通保存把盘上改成「repos 为空 + 换了个 key」
    expect((await putJson({ ...FULL, repos: [], apiKey: "sk-route-test-key-rotated" })).status).toBe(200);
    const beforeSecond = await readDisk();
    // 再清 key（完整对象 + apiKey: ""）= 第二次收缩
    const res = await putJson({ ...FULL, repos: [], apiKey: "" });
    expect(res.status).toBe(200);
    const secondShrinkRaw = await fs.readFile(shrinkPath(), "utf-8");
    expect(secondShrinkRaw).not.toBe(firstShrinkRaw);
    expect(JSON.parse(secondShrinkRaw)).toEqual(JSON.parse(beforeSecond));
    expect(JSON.parse(secondShrinkRaw).apiKey).toBe("sk-route-test-key-rotated");
  });

  it("清 key（完整对象 + apiKey: \"\"）→ 200，且收缩备份里留着被清掉的旧 key", async () => {
    const res = await putJson({ ...GOOD_CONFIG, apiKey: "" });
    expect(res.status).toBe(200);
    expect(JSON.parse(await readDisk()).apiKey).toBe("");
    expect(JSON.parse(await fs.readFile(shrinkPath(), "utf-8"))).toEqual(GOOD_CONFIG);
  });

  it("普通保存（只改值、不清空任何已知键）不产生 .bak.shrink", async () => {
    expect((await putJson({ ...GOOD_CONFIG, apiKey: "sk-route-test-key-0002" })).status).toBe(200);
    expect(await exists(bakPath())).toBe(true);
    expect(await exists(shrinkPath())).toBe(false);
  });

  it("client 把脱敏展示值当真值回写：掩码兜底后 apiKey 仍是盘上真值，不算收缩", async () => {
    const masked = `${GOOD_CONFIG.apiKey.slice(0, 4)}…（已脱敏、长度 ${GOOD_CONFIG.apiKey.length}）`;
    const res = await putJson({ ...GOOD_CONFIG, apiKey: masked });
    expect(res.status).toBe(200);
    expect(JSON.parse(await readDisk()).apiKey).toBe(GOOD_CONFIG.apiKey);
    expect(await exists(shrinkPath())).toBe(false);
  });
});
