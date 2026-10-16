/**
 * 第八轮（设置读写侧）：L1-03 旧单对象 companyEnv 漏报 / L1-05 空白行判定共用 + 真实默认行 `env: "test"` / L1-06 特征化。
 *
 * 全部走真实 putSettingsFile + 真实文件系统（mkdtemp 的临时数据目录），凭据全是假值；
 * 断言一律走布尔 / 键名 / 数量，失败时 vitest 也不会把任何值打进输出。
 *
 * 其中「源码形态契约」两条（最后一个 describe）是 grep / AST 形态断言、**不是行为证明**——
 * 行为证明是前面的 isBlankCompanyEnvRow 表驱动与 putSettingsFile 用例（回退 isBlankCompanyEnvRow 里的 env 豁免会红）。
 */
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyCompanyEnv, isBlankCompanyEnvRow } from "@/lib/company-env";
import { putSettingsFile, settingsFilePath } from "@/lib/server/settings-fs";

let root: string;
let savedDataDir: string | undefined;

beforeEach(async () => {
  savedDataDir = process.env.FLOWSHIP_DATA_DIR;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flowship-settings-r8-"));
  process.env.FLOWSHIP_DATA_DIR = root;
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
  else process.env.FLOWSHIP_DATA_DIR = savedDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

const shrinkPath = (): string => `${settingsFilePath()}.bak.shrink`;
const exists = (p: string): Promise<boolean> =>
  fs.stat(p).then(
    () => true,
    () => false,
  );
const readJson = async (p: string): Promise<unknown> => JSON.parse(await fs.readFile(p, "utf-8"));
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const writeConfig = async (cfg: unknown): Promise<void> => {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(settingsFilePath(), JSON.stringify(cfg), "utf-8");
};

/** 与 client 整对象 PUT 同形：必带 apiKey / defaultModel / repos；companyEnv 由各用例覆盖 */
const BASE: Record<string, unknown> = {
  apiKey: "sk-FAKE-R8-MAIN-0001",
  gitToken: "glpat-FAKE-R8-0002",
  defaultModel: { id: "composer-2" },
  repos: [{ name: "web", path: "/repo/web" }],
  mcpServers: { feishu: { url: "https://x" } },
};

// ──────────────────────────────────────────────────────────────────────────────────────────────
// 设置页「添加」按钮真实落盘的默认行（手抄自 src/components/settings/company-env-card.tsx 的各 AddRowButton.onClick，
// 共 9 个子系统；env 默认是 "test"，不是空串——第八轮 L1-05：旧夹具用 `env: ""`，豁免集合里删掉 "env" 测试仍绿）。
// fill = 该子系统里用户「填了内容」时会动的文本字段（用来做对照：填了就不是空白行）。
// ──────────────────────────────────────────────────────────────────────────────────────────────
const ADD_BUTTON_ROWS: ReadonlyArray<{
  section: string;
  row: Record<string, unknown>;
  fill: Record<string, unknown>;
}> = [
  { section: "servers", row: { env: "test", host: "", port: 22, user: "", password: "" }, fill: { host: "h.invalid" } },
  { section: "pg", row: { env: "test", host: "", port: 5432, user: "", password: "", readonly: true }, fill: { host: "pg.invalid" } },
  { section: "redis", row: { env: "test", host: "", port: 6379, db: 0, password: "", readonly: true }, fill: { password: "pw-FAKE-R8-REDIS-0003" } },
  { section: "xxljob", row: { env: "test", baseUrl: "", username: "", password: "", readonly: true }, fill: { baseUrl: "http://x.invalid" } },
  { section: "nacos", row: { env: "test", baseUrl: "", username: "", password: "", namespaces: [], readonly: true }, fill: { baseUrl: "http://n.invalid" } },
  { section: "elk", row: { env: "test", baseUrl: "", username: "", password: "", dataView: "" }, fill: { baseUrl: "http://e.invalid" } },
  { section: "sls", row: { env: "test", endpoint: "", project: "", accessKeyId: "", accessKeySecret: "" }, fill: { accessKeySecret: "ak-FAKE-R8-SLS-0004" } },
  { section: "httpApis", row: { env: "test", url: "" }, fill: { url: "http://api.invalid" } },
  { section: "custom", row: { name: "", content: "" }, fill: { name: "日志路径" } },
];

describe("isBlankCompanyEnvRow（服务端收缩判定与设置页删除确认共用的「空白行」判定）", () => {
  it.each(ADD_BUTTON_ROWS)(
    "「添加」落盘的真实默认行 $section（env: \"test\"、其余全空）→ 空白行",
    ({ row }) => {
      expect(isBlankCompanyEnvRow(row)).toBe(true);
    },
  );

  it.each(ADD_BUTTON_ROWS)("对照：$section 的文本字段填了内容 → 不是空白行", ({ row, fill }) => {
    expect(isBlankCompanyEnvRow({ ...row, ...fill })).toBe(false);
  });

  // 豁免集合 = env / port / db / readonly / namespaces：这些是默认就带的、不算用户填了内容。
  // port / db 真实值是数字、readonly 是布尔、namespaces 是数组，本来就不会被当成「文本」；
  // 这里给它们塞字符串，才能把每个豁免项**逐个**钉住（任一个被删，对应用例变红）。
  it.each(["env", "port", "db", "readonly", "namespaces"])(
    "豁免字段 %s 即使是非空字符串也不算「填了内容」",
    (field) => {
      expect(isBlankCompanyEnvRow({ [field]: "some-text", host: "", password: "" })).toBe(true);
    },
  );

  it.each([
    ["host", "h.invalid"],
    ["user", "root"],
    ["password", "pw-FAKE-R8-0005"],
    ["accessKeyId", "ak"],
    ["note", "鉴权说明"],
    ["dataView", "v"],
  ])("非豁免字段 %s 有内容 → 不是空白行（env 仍是默认值也一样）", (field, value) => {
    expect(isBlankCompanyEnvRow({ env: "test", [field]: value })).toBe(false);
  });

  it("纯空白（空格 / 制表 / 换行）的文本按空处理；非字符串（数字 / 布尔 / null）不算文本", () => {
    expect(isBlankCompanyEnvRow({ env: "test", host: "  \t\n", password: " " })).toBe(true);
    expect(isBlankCompanyEnvRow({ host: 123, password: null, user: false })).toBe(true);
    expect(isBlankCompanyEnvRow({})).toBe(true);
  });
});

describe("第八轮 L1-05：设置页「添加」真实落盘的默认行（env: \"test\"）→ 加一行再删掉，不算收缩，好备份不被顶掉", () => {
  /** 一份「已经有人误清过 repos」之后的好备份：之后做的任何不算收缩的操作都不该改写它 */
  const SENTINEL_SHRINK = JSON.stringify({ ...BASE, note: "good-backup-sentinel" });

  it.each(ADD_BUTTON_ROWS)(
    "$section：添加默认行 → 删掉它（子系统回到没有内容）→ .bak.shrink 逐字节不变、不被改写",
    async ({ section, row }) => {
      await writeConfig({ ...BASE, companyEnv: { ...emptyCompanyEnv(), [section]: [row] } });
      await fs.writeFile(shrinkPath(), SENTINEL_SHRINK, "utf-8");
      const res = await putSettingsFile({ ...BASE, companyEnv: { ...emptyCompanyEnv(), [section]: [] } });
      expect(res.status).toBe("ok");
      expect((await fs.readFile(shrinkPath(), "utf-8")) === SENTINEL_SHRINK).toBe(true);
    },
  );

  it.each(ADD_BUTTON_ROWS)(
    "对照（防空转）：$section 的行填了内容后整组删除 → 算收缩、.bak.shrink 被改写成收缩前的配置、日志点名该子系统",
    async ({ section, row, fill }) => {
      const filled = { ...row, ...fill };
      const previous = { ...BASE, companyEnv: { ...emptyCompanyEnv(), [section]: [filled] } };
      await writeConfig(previous);
      await fs.writeFile(shrinkPath(), SENTINEL_SHRINK, "utf-8");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await putSettingsFile({ ...BASE, companyEnv: { ...emptyCompanyEnv(), [section]: [] } });
      expect(res.status).toBe("ok");
      expect(sameJson(await readJson(shrinkPath()), previous)).toBe(true);
      expect(JSON.stringify(warn.mock.calls).includes(`companyEnv.${section}`)).toBe(true);
    },
  );

  it("同一子系统里「默认空白行 + 一条有内容的行」删掉空白行 → 不算收缩（仍有内容）", async () => {
    const filled = { env: "test", host: "pg.invalid", port: 5432, user: "u", password: "pw-FAKE-R8-PG-0006", readonly: true };
    const blank = ADD_BUTTON_ROWS.find((r) => r.section === "pg")!.row;
    await writeConfig({ ...BASE, companyEnv: { ...emptyCompanyEnv(), pg: [filled, blank] } });
    const res = await putSettingsFile({ ...BASE, companyEnv: { ...emptyCompanyEnv(), pg: [filled] } });
    expect(res.status).toBe("ok");
    expect(await exists(shrinkPath())).toBe(false);
  });
});

describe("第八轮 L1-03：磁盘上是旧单对象 companyEnv（pg / redis / custom / nacos / elk / sls 以前不是数组）时，清空它也要生成 .bak.shrink", () => {
  // 旧版单实例格式：这六项以前是单个对象，读时才被 normalizeCompanyEnv 升级成单元素数组（company-env.ts 的 normalizeInstanceList）
  const LEGACY: ReadonlyArray<{ section: string; obj: Record<string, unknown>; blank: Record<string, unknown> }> = [
    { section: "pg", obj: { host: "pg.invalid", port: 5432, user: "u", password: "pw-FAKE-R8-LEGACY-PG" }, blank: { env: "test", port: 5432, readonly: true } },
    { section: "redis", obj: { host: "r.invalid", port: 6379, password: "pw-FAKE-R8-LEGACY-REDIS" }, blank: { port: 6379, db: 0 } },
    { section: "custom", obj: { name: "日志路径模板", content: "/apps/{project}/logs/x.log" }, blank: {} },
    { section: "nacos", obj: { baseUrl: "http://n.invalid", username: "u", password: "pw-FAKE-R8-LEGACY-NACOS" }, blank: { env: "test", namespaces: [] } },
    { section: "elk", obj: { baseUrl: "http://e.invalid", username: "u", password: "pw-FAKE-R8-LEGACY-ELK" }, blank: { env: "test" } },
    { section: "sls", obj: { endpoint: "e.invalid", project: "p", accessKeyId: "ak", accessKeySecret: "ak-FAKE-R8-LEGACY-SLS" }, blank: { env: "test" } },
  ];

  it.each(LEGACY)(
    "磁盘是旧单对象 $section → 用户清空它再保存 → 生成 .bak.shrink（= 收缩前的磁盘内容，含旧单对象）、日志点名 companyEnv.<该子系统>、不含密码",
    async ({ section, obj }) => {
      const previous = { ...BASE, companyEnv: { [section]: obj } };
      await writeConfig(previous);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const res = await putSettingsFile({ ...BASE, companyEnv: emptyCompanyEnv() });
      expect(res.status).toBe("ok");
      expect(await exists(shrinkPath())).toBe(true);
      expect(sameJson(await readJson(shrinkPath()), previous)).toBe(true);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged.includes(`companyEnv.${section}`)).toBe(true);
      for (const v of Object.values(obj)) {
        if (typeof v === "string" && v.length >= 8) expect(logged.includes(v)).toBe(false);
      }
    },
  );

  it("旧单对象里只有默认字段（刚点「添加」那种空白）→ 清掉它不算收缩（不过度报告）", async () => {
    for (const { section, blank } of LEGACY) {
      await writeConfig({ ...BASE, companyEnv: { [section]: blank } });
      const res = await putSettingsFile({ ...BASE, companyEnv: emptyCompanyEnv() });
      expect(res.status, section).toBe("ok");
      expect(await exists(shrinkPath()), section).toBe(false);
    }
  });

  it("旧单对象被 client 读时升级成数组、内容没少地保存回来 → 不是收缩（升级 ≠ 清空）", async () => {
    for (const { section, obj } of LEGACY) {
      await writeConfig({ ...BASE, companyEnv: { [section]: obj } });
      const res = await putSettingsFile({ ...BASE, companyEnv: { ...emptyCompanyEnv(), [section]: [obj] } });
      expect(res.status, section).toBe("ok");
      expect(await exists(shrinkPath()), section).toBe(false);
    }
  });

  it("下一份也是旧单对象（绕过 client 的手写 PUT）且内容没少 → 不是收缩（两边都先归一再比，不对称误报）", async () => {
    for (const { section, obj } of LEGACY) {
      await writeConfig({ ...BASE, companyEnv: { [section]: obj } });
      const res = await putSettingsFile({ ...BASE, companyEnv: { [section]: obj } });
      expect(res.status, section).toBe("ok");
      expect(await exists(shrinkPath()), section).toBe(false);
    }
  });

  it("旧单对象 + 同时有数组格式的别的子系统：只清旧格式那一项，也只点名那一项", async () => {
    const pgObj = LEGACY[0].obj;
    const server = { env: "test", host: "h.invalid", port: 22, user: "u", password: "pw-FAKE-R8-SSH-0007" };
    const previous = { ...BASE, companyEnv: { servers: [server], pg: pgObj } };
    await writeConfig(previous);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await putSettingsFile({ ...BASE, companyEnv: { ...emptyCompanyEnv(), servers: [server] } });
    expect(res.status).toBe("ok");
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged.includes("companyEnv.pg")).toBe(true);
    expect(logged.includes("companyEnv.servers")).toBe(false);
  });
});

describe("第八轮 L1-06（特征化、设计如此、不改代码）：第二次合法收缩会把上一次的好备份顶掉", () => {
  it("误清 repos（.bak.shrink = 含 repos 的完整配置）→ 再清 gitToken → .bak.shrink 变成「repos 已空」的状态", async () => {
    await writeConfig(BASE);
    expect((await putSettingsFile({ ...BASE, repos: [] })).status).toBe("ok");
    const afterFirst = (await readJson(shrinkPath())) as { repos?: unknown[] };
    expect(afterFirst.repos?.length).toBe(1);

    expect((await putSettingsFile({ ...BASE, repos: [], gitToken: "" })).status).toBe("ok");
    const afterSecond = (await readJson(shrinkPath())) as { repos?: unknown[]; gitToken?: unknown };
    // 好备份里的 repos 没了：上一次误清前的仓库配置只能靠别处找回
    expect(afterSecond.repos?.length).toBe(0);
    expect(afterSecond.gitToken === BASE.gitToken).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ 以下是源码形态契约（AST / 文本形态），不是行为证明：只能挡住「有人又在服务端 / 卡片各抄一份空白行名单」这类字面回退。
// 行为证明见上面的 isBlankCompanyEnvRow 表驱动与 putSettingsFile 用例。
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe("源码形态契约（非行为证明）：服务端收缩判定与设置页卡片共用 company-env.ts 导出的 isBlankCompanyEnvRow", () => {
  const read = (rel: string): string => readFileSync(path.join(process.cwd(), rel), "utf8");

  const OWN_NAMES = ["COMPANY_ENV_DEFAULT_ROW_FIELDS", "isBlankRow"] as const;

  /**
   * 对一段源码：是否从 `fromSuffix` 结尾的模块导入了（未改名的）isBlankCompanyEnvRow；
   * 顶层是否自己声明了 OWN_NAMES 里的任一标识符（= 抄了一份自己的名单 / 判定）。
   */
  const inspectText = (
    text: string,
    fromSuffix: string,
    tsx: boolean,
  ): { imports: boolean; localCopies: string[] } => {
    const sf = ts.createSourceFile("x", text, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    let imports = false;
    const localCopies: string[] = [];
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.endsWith(fromSuffix)) {
        const bindings = st.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.some((e) => e.name.text === "isBlankCompanyEnvRow" && !e.propertyName)
        ) {
          imports = true;
        }
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && (OWN_NAMES as readonly string[]).includes(d.name.text)) {
            localCopies.push(d.name.text);
          }
        }
      }
    }
    return { imports, localCopies };
  };

  it("settings-fs.ts：从 ../company-env 导入 isBlankCompanyEnvRow，不再自己声明默认字段名单", () => {
    const r = inspectText(read("src/lib/server/settings-fs.ts"), "company-env", false);
    expect(r.imports).toBe(true);
    expect(r.localCopies).toEqual([]);
  });

  it("company-env-card.tsx：从 @/lib/company-env 导入 isBlankCompanyEnvRow，不再自己声明 isBlankRow", () => {
    const r = inspectText(read("src/components/settings/company-env-card.tsx"), "@/lib/company-env", true);
    expect(r.imports).toBe(true);
    expect(r.localCopies).toEqual([]);
  });

  it("检测器自检：本地抄了一份 / 改名导入 / 没导入，都会被标出来；规范写法放行", () => {
    expect(inspectText(`const isBlankRow = (r: object) => true;`, "company-env", false)).toEqual({
      imports: false,
      localCopies: ["isBlankRow"],
    });
    expect(
      inspectText(`const COMPANY_ENV_DEFAULT_ROW_FIELDS = new Set(["env"]);`, "company-env", false).localCopies,
    ).toEqual(["COMPANY_ENV_DEFAULT_ROW_FIELDS"]);
    expect(
      inspectText(`import { isBlankCompanyEnvRow as x } from "@/lib/company-env";`, "company-env", false).imports,
    ).toBe(false);
    expect(inspectText(`import { isBlankCompanyEnvRow } from "../other";`, "company-env", false).imports).toBe(false);
    expect(inspectText(`import { isBlankCompanyEnvRow } from "@/lib/company-env";`, "company-env", false)).toEqual({
      imports: true,
      localCopies: [],
    });
  });
});
