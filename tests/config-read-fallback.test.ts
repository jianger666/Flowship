/**
 * R14 B2-1 · Q21-04 + Q11b-08：配置「读不出来」≠「没配置」。
 *
 * Q21-04：新会话启动时 syncCompanyEnvFileFromSettings 读 settings；读失败（Windows 杀毒占用 / 半写 / JSON 坏了）时
 *   旧代码走 emptyCompanyEnv() 并原子写进 company-env.json——文件立刻变空，这一轮 agent 的 pg-exec / ssh-exec
 *   全报「配置不存在」，而设置页里的配置明明还在。现在：读失败（status=error）→ 不写、留一行日志；
 *   首次运行没有设置文件（status=missing）→ 仍写空配置（既有行为不变）。
 * Q11b-08：readAppMcpServers / 禁用规则名单把「坏 JSON / 读失败」与「文件不存在」同当空，config.json 一坏就静默清零。
 *   行为保持（仍按空处理），但非「文件不存在」要留一行日志；日志与诊断包**都不带文件内容**
 *   （V8 的 JSON.parse 报错会夹带出错处附近的原文，config.json 里最先出现的就是密钥）。
 *
 * 全程假凭据 + 临时数据目录 / 家目录，绝不碰真实配置。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { emptyCompanyEnv } from "@/lib/company-env";
import {
  companyEnvFilePath,
  syncCompanyEnvFileFromSettings,
} from "@/lib/server/company-env-fs";
import {
  MAX_RULE_FILE_BYTES,
  readAppMcpServers,
  readAppRulesForPrompt,
  readGlobalCursorMcpServers,
} from "@/lib/server/cursor-config";
import { exportDiagnostics } from "@/lib/server/diagnostics";
import {
  DEFAULT_TEAM_LIBRARY,
  getTeamLibraryConfig,
} from "@/lib/server/team-library";

const BOM = "\uFEFF";
// V8 对短文本的 JSON 报错会把整段原文拼进 message：用它证明下面「不带文件内容」的断言不是空转
const BAD_JSON = '{"apiKey": LEAKME_abc123}';

const ENV_KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root: string;
let dataDir: string;
let warn: MockInstance<typeof console.warn>;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-config-fallback-"));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

const configPath = (): string => path.join(dataDir, "config.json");
const writeConfig = (cfg: unknown, opts: { bom?: boolean } = {}): void => {
  writeFileSync(
    configPath(),
    `${opts.bom ? BOM : ""}${JSON.stringify(cfg, null, 2)}\n`,
    "utf-8",
  );
};
const serverRow = (host: string) => ({
  env: "test",
  host,
  port: 22,
  user: "deploy",
  password: "pw-marker-0001",
});
const envWithServer = (host: string) => ({
  ...emptyCompanyEnv(),
  servers: [serverRow(host)],
});
/** 某前缀的 warn 日志（backupCorruptSettingsOnce 之类别的模块也可能 warn，按前缀隔开） */
const warned = (prefix: string): string[] =>
  warn.mock.calls
    .map((args) => args.map(String).join(" "))
    .filter((line) => line.includes(prefix));

describe("自检", () => {
  it("这份坏 JSON 的 V8 报错确实会夹带原文（否则下面「不带文件内容」的断言在空转）", () => {
    let message = "";
    try {
      JSON.parse(BAD_JSON);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toContain("LEAKME");
  });
});

describe("Q21-04 syncCompanyEnvFileFromSettings：settings 读不出来 ≠ 没配公司环境", () => {
  it("settings 正常：把 companyEnv 同步到 company-env.json", async () => {
    writeConfig({ companyEnv: envWithServer("marker-host.internal") });
    await syncCompanyEnvFileFromSettings();
    expect(readFileSync(companyEnvFilePath(), "utf-8")).toContain("marker-host.internal");
  });

  it("settings 带 BOM 也能同步（Q9-10 联动）", async () => {
    writeConfig({ companyEnv: envWithServer("marker-host.internal") }, { bom: true });
    await syncCompanyEnvFileFromSettings();
    expect(readFileSync(companyEnvFilePath(), "utf-8")).toContain("marker-host.internal");
  });

  it("settings 读出错（JSON 坏了）：已有的 company-env.json 逐字节不变，留一行日志且不带文件内容", async () => {
    const lastGood = `${JSON.stringify(envWithServer("last-good-host.internal"), null, 2)}\n`;
    writeFileSync(companyEnvFilePath(), lastGood, "utf-8");
    writeFileSync(configPath(), BAD_JSON, "utf-8");

    await syncCompanyEnvFileFromSettings();

    expect(readFileSync(companyEnvFilePath(), "utf-8")).toBe(lastGood);
    const lines = warned("[company-env-fs]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("保留现有 company-env.json");
    expect(lines.join("\n")).not.toContain("LEAKME");
  });

  it("settings 读出错（config.json 是个目录，EISDIR）：同样不覆盖", async () => {
    const lastGood = `${JSON.stringify(envWithServer("last-good-host.internal"), null, 2)}\n`;
    writeFileSync(companyEnvFilePath(), lastGood, "utf-8");
    mkdirSync(configPath());

    await syncCompanyEnvFileFromSettings();

    expect(readFileSync(companyEnvFilePath(), "utf-8")).toBe(lastGood);
    expect(warned("[company-env-fs]")).toHaveLength(1);
  });

  it("settings 读出错且 company-env.json 原本不存在：仍然不去创建一个空的", async () => {
    writeFileSync(configPath(), BAD_JSON, "utf-8");
    await syncCompanyEnvFileFromSettings();
    expect(existsSync(companyEnvFilePath())).toBe(false);
  });

  it("settings 不存在（首次运行）：照旧写一份空配置（既有行为不变）", async () => {
    expect(existsSync(configPath())).toBe(false);
    await syncCompanyEnvFileFromSettings();
    const written = JSON.parse(readFileSync(companyEnvFilePath(), "utf-8")) as {
      servers: unknown[];
    };
    expect(written.servers).toEqual([]);
    expect(warned("[company-env-fs]")).toEqual([]);
  });
});

describe("Q11b-08 cursor-config：读不出来仍按空处理，但要留线索（且不带文件内容）", () => {
  it("config.json 是坏 JSON：MCP 按空处理 + 一行日志（带类别、不带内容）", async () => {
    writeFileSync(configPath(), BAD_JSON, "utf-8");
    expect(await readAppMcpServers()).toEqual({});
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("MCP 服务器");
    expect(lines[0]).toContain("JSON 格式不对");
    expect(lines.join("\n")).not.toContain("LEAKME");
  });

  it("config.json 不存在（没配过，常态）：按空处理，不打日志", async () => {
    expect(await readAppMcpServers()).toEqual({});
    expect(warned("[cursor-config]")).toEqual([]);
  });

  it("config.json 是个目录（EISDIR）：日志里带系统错误码", async () => {
    mkdirSync(configPath());
    expect(await readAppMcpServers()).toEqual({});
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("EISDIR");
  });

  it("config.json 正常但没配 mcpServers：按空处理，不打日志（正常路径不刷屏）", async () => {
    writeConfig({ apiKey: "fake-api-key-for-fallback-0001" });
    expect(await readAppMcpServers()).toEqual({});
    expect(warned("[cursor-config]")).toEqual([]);
  });

  it("禁用规则名单读不出来：规则照旧全部注入（行为不变），但留一行「禁用规则名单」日志", async () => {
    const rulesDir = path.join(dataDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "keep.mdc"), "RULE_KEEP_MARKER", "utf-8");
    writeFileSync(path.join(rulesDir, "off.mdc"), "RULE_OFF_MARKER", "utf-8");
    writeFileSync(configPath(), BAD_JSON, "utf-8");

    const prompt = await readAppRulesForPrompt();

    expect(prompt).toContain("RULE_KEEP_MARKER");
    expect(prompt).toContain("RULE_OFF_MARKER");
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("禁用规则名单");
    expect(lines.join("\n")).not.toContain("LEAKME");
  });
});

describe("诊断包：config.json 读不出来时不夹带文件内容", () => {
  it(
    "坏 JSON 的开头是密钥：诊断包只说「JSON 格式不对」，不含任何内容片段",
    async () => {
      writeFileSync(configPath(), BAD_JSON, "utf-8");
      const text = readFileSync(await exportDiagnostics("0.0.0-test"), "utf8");
      expect(text).toContain("config.json 读取失败：JSON 格式不对");
      expect(text).not.toContain("LEAKME");
    },
    20_000,
  );
});

describe("Q11b-08 补全：MCP 条目过滤 / 规则文件体积上限 / team-library.json 日志", () => {
  it("自管 MCP：值不是对象的条目（null / 字符串 / 数组）被丢掉并点名，对象条目照常；日志只有条目名", async () => {
    writeConfig({
      mcpServers: {
        good: { command: "npx" },
        nul: null,
        str: "oops_LEAKME",
        arr: [1, 2],
      },
    });
    expect(Object.keys(await readAppMcpServers())).toEqual(["good"]);
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("3 个 MCP 条目不是对象");
    for (const name of ["nul", "str", "arr"]) expect(lines[0]).toContain(name);
    expect(lines[0]).not.toContain("LEAKME");
  });

  it("Cursor 全局 mcp.json（导入源）：同样过滤", async () => {
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { good: { command: "npx" }, nul: null, num: 7 },
      }),
      "utf-8",
    );
    expect(Object.keys(await readGlobalCursorMcpServers())).toEqual(["good"]);
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Cursor 全局 mcp.json");
    expect(lines[0]).toContain("nul");
    expect(lines[0]).toContain("num");
  });

  it("条目全是对象：不打日志（正常路径不刷屏）", async () => {
    writeConfig({
      mcpServers: { a: { command: "x" }, b: { url: "http://localhost:1/mcp" } },
    });
    expect(Object.keys(await readAppMcpServers()).sort()).toEqual(["a", "b"]);
    expect(warned("[cursor-config]")).toEqual([]);
  });

  it("被丢的条目超过 5 个：日志只点前 5 个并加「等」", async () => {
    const servers: Record<string, unknown> = { good: { command: "x" } };
    for (let i = 1; i <= 7; i += 1) servers[`bad${i}`] = null;
    writeConfig({ mcpServers: servers });
    expect(Object.keys(await readAppMcpServers())).toEqual(["good"]);
    const line = warned("[cursor-config]")[0] ?? "";
    expect(line).toContain("7 个 MCP 条目不是对象");
    expect(line).toContain("bad5");
    expect(line).not.toContain("bad6");
    expect(line).toContain("等");
  });

  it("规则文件体积：恰好 256KB 的保留，超过的跳过并点名文件（不带内容）；小文件不受影响", async () => {
    const rulesDir = path.join(dataDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "a-small.mdc"), "RULE_SMALL_MARKER", "utf-8");
    const exactTail = "RULE_EXACT_MARKER";
    writeFileSync(
      path.join(rulesDir, "b-exact.mdc"),
      "e".repeat(MAX_RULE_FILE_BYTES - exactTail.length) + exactTail,
      "utf-8",
    );
    writeFileSync(
      path.join(rulesDir, "c-big.mdc"),
      "g".repeat(MAX_RULE_FILE_BYTES) + "RULE_BIG_MARKER",
      "utf-8",
    );

    const prompt = await readAppRulesForPrompt();

    expect(prompt).toContain("RULE_SMALL_MARKER");
    expect(prompt).toContain("RULE_EXACT_MARKER");
    expect(prompt).not.toContain("RULE_BIG_MARKER");
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("c-big.mdc");
    expect(lines[0]).not.toContain("RULE_BIG_MARKER");
  });

  it("规则文件体积上限就是 256KB（改它要同步评估：规则全文常驻 prompt）", () => {
    expect(MAX_RULE_FILE_BYTES).toBe(256 * 1024);
  });

  it("team-library.json 是坏 JSON：退回默认配置，日志只带类别、不带文件内容", async () => {
    writeFileSync(
      path.join(dataDir, "team-library.json"),
      '{"branch": LEAKME_abc123}',
      "utf-8",
    );
    expect((await getTeamLibraryConfig()).branch).toBe(
      DEFAULT_TEAM_LIBRARY.branch,
    );
    const lines = warned("[team-library]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("JSON 格式不对");
    expect(lines[0]).not.toContain("LEAKME");
  });
});

/**
 * TL03 补测：team-library.json（覆盖配置）「不存在」是常态——绝大多数用户从没配过覆盖，必须静默。
 *
 * 对应 team-library.ts 的 getTeamLibraryConfig：读覆盖文件的 catch 里只有 `code !== "ENOENT"` 才 console.warn。
 * 既有的 team-library 用例只覆盖「坏 JSON → 恰好一条 warn」，没人守「文件不存在 → 一条日志都没有」：
 * 把 ENOENT 判断去掉（或改成 console.error / 抛错）它们都抓不到，而每次读团队库配置都会刷一行日志。
 */
describe("TL03 补测：team-library.json 不存在时不打任何日志", () => {
  it("覆盖配置文件不存在：返回内置默认配置，console.warn / console.error 都没被调用", async () => {
    // warn 已在 beforeEach 里 mock；console.error 这里临时 mock（也要证明它没被调用），用完无论成败都还原
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 夹具自检：数据目录里确实没有覆盖文件——否则下面的「静默」可能只是读到了合法文件
      expect(existsSync(path.join(dataDir, "team-library.json"))).toBe(false);

      const cfg = await getTeamLibraryConfig();

      // 走的是「没有覆盖 → 用内置默认」这条路径（不是抛错、也不是别的降级）
      expect(cfg).toEqual({ ...DEFAULT_TEAM_LIBRARY });
      // 一条日志都不能有
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});

/**
 * R14 B6-2 · Q6-04：形状不对的 MCP 条目（`url` 写成数字、空 url、缺 command……）在读取层丢掉。
 *
 * 台账原症状：单条 MCP 存坏后，起 agent 前的 OAuth 注入（enrichMcpServersWithOAuth → normalizeServerUrl 的 `.trim()`）
 * 抛 TypeError，新任务和新对话一起起不来。B2-1 已丢掉「值不是对象」的条目，这里补「对象但形状不对」。
 * 校验函数本身的表驱动用例在 mcp-config-validate.test.ts；这里只测读取层：丢哪些、日志怎么写、放行哪些。
 */
describe("Q6-04：形状不对的 MCP 条目在读取层丢掉（一条坏数据不拖垮所有任务）", () => {
  it("自管 MCP：url 是数字 / 空串、缺 command、args 类型错的条目被丢并点名；日志只有条目名和固定文案，不带值", async () => {
    writeConfig({
      mcpServers: {
        good: { command: "npx" },
        goodHttp: { type: "http", url: "https://x/mcp" },
        numUrl: { url: 123456789 },
        emptyUrl: { type: "http", url: "" },
        noCmd: { type: "stdio" },
        badArgs: { command: "x", args: "LEAKME_args" },
      },
    });
    expect(Object.keys(await readAppMcpServers()).sort()).toEqual(["good", "goodHttp"]);
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("4 个 MCP 条目配置无效");
    for (const name of ["numUrl", "emptyUrl", "noCmd", "badArgs"]) {
      expect(lines[0]).toContain(name);
    }
    expect(lines[0]).not.toContain("123456789");
    expect(lines[0]).not.toContain("LEAKME");
    // 每个条目名后面带校验给出的原因（固定文案、不含用户写的值），用户对着它改配置
    const { validateMcpServerConfig } = await import("@/lib/mcp-config");
    const why = (cfg: unknown): string => validateMcpServerConfig(cfg) ?? "（校验居然通过了）";
    expect(lines[0]).toContain(`numUrl（${why({ url: 123456789 })}）`);
    expect(lines[0]).toContain(`noCmd（${why({ type: "stdio" })}）`);
    expect(lines[0]).toContain(`badArgs（${why({ command: "x", args: "LEAKME_args" })}）`);
  });

  it("「不是对象」与「形状不对」是两行日志、各管各的；既有那一行的文案不变", async () => {
    writeConfig({
      mcpServers: {
        good: { command: "x" },
        nothing: null,
        badUrl: { url: 1 },
      },
    });
    expect(Object.keys(await readAppMcpServers())).toEqual(["good"]);
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(2);
    const notObject = lines.find((l) => l.includes("不是对象")) ?? "";
    const malformed = lines.find((l) => l.includes("配置无效")) ?? "";
    expect(notObject).toContain("1 个 MCP 条目不是对象，已忽略：nothing");
    expect(notObject).not.toContain("badUrl");
    expect(malformed).toContain("1 个 MCP 条目配置无效，已忽略：badUrl");
    expect(malformed).not.toContain("nothing");
  });

  it("台账原症状：读出来的集合交给起 agent 前的 OAuth 注入不抛（改前 `{url:123}` 留在集合里，normalizeServerUrl 的 .trim() 抛 TypeError）", async () => {
    writeConfig({ mcpServers: { good: { command: "npx" }, bad: { url: 123 } } });
    const { enrichMcpServersWithOAuth } = await import("@/lib/server/mcp-oauth");
    const outcome = await enrichMcpServersWithOAuth(await readAppMcpServers()).then(
      (enriched) => ({ ok: true as const, names: Object.keys(enriched) }),
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    expect(outcome).toEqual({ ok: true, names: ["good"] });
  });

  it("Cursor 全局 mcp.json（导入源）：同样丢形状不对的条目", async () => {
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          good: { command: "npx" },
          badUrl: { url: 7 },
          noCmd: {},
        },
      }),
      "utf-8",
    );
    expect(Object.keys(await readGlobalCursorMcpServers())).toEqual(["good"]);
    const lines = warned("[cursor-config]");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Cursor 全局 mcp.json");
    expect(lines[0]).toContain("2 个 MCP 条目配置无效");
    expect(lines[0]).toContain("badUrl");
    expect(lines[0]).toContain("noCmd");
  });

  it("刻意放行的写法不被误伤，也不打日志：url 占位符 / Cursor 别名 type / 数字 env 值 / 可选字段为 null", async () => {
    writeConfig({
      mcpServers: {
        envUrl: { url: "${env:MCP_URL}" },
        alias: { type: "streamable-http", url: "https://x" },
        numEnv: { command: "x", env: { PORT: 3000 } },
        nulls: { command: "x", args: null, env: null },
      },
    });
    expect(Object.keys(await readAppMcpServers()).sort()).toEqual([
      "alias",
      "envUrl",
      "nulls",
      "numEnv",
    ]);
    expect(warned("[cursor-config]")).toEqual([]);
  });

  it("形状不对的条目超过 5 个：日志只点前 5 个并加「等」", async () => {
    const servers: Record<string, unknown> = { good: { command: "x" } };
    for (let i = 1; i <= 7; i += 1) servers[`bad${i}`] = { url: i };
    writeConfig({ mcpServers: servers });
    expect(Object.keys(await readAppMcpServers())).toEqual(["good"]);
    const line = warned("[cursor-config]")[0] ?? "";
    expect(line).toContain("7 个 MCP 条目配置无效");
    expect(line).toContain("bad5");
    expect(line).not.toContain("bad6");
    expect(line).toContain("等");
  });
});
