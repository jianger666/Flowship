/**
 * R14 B2-1 · Q9-10（config.json 部分）：带 UTF-8 BOM 的 config.json 不再被判成损坏。
 *
 * 背景：Windows 记事本「另存为 UTF-8（带 BOM）」会在文件头塞一个 U+FEFF，而 JSON.parse 不认它。
 * Flowship 里直接读 config.json 的地方有 8 处（设置页、agent 启动读 apiKey / gitToken、事件脱敏、MCP / 禁用规则、
 * git host 白名单、诊断包），只修一处会出现「设置页能开、agent 却读不到 apiKey」的半好状态——
 * 所以这里逐个读取点断言「带 BOM 的文件读得出来」。trusted-git-host 的报错文案就是让用户手改 config.json，BOM 是高发路径。
 *
 * 全程假凭据 + 临时数据目录 / 家目录，绝不碰真实配置。
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readAppMcpServers,
  readAppRulesForPrompt,
  readGlobalCursorMcpServers,
} from "@/lib/server/cursor-config";
import { describeConfigReadError, stripBom } from "@/lib/server/data-root";
import { exportDiagnostics } from "@/lib/server/diagnostics";
import { redactSecretsInText } from "@/lib/server/event-secret-redact";
import { readSettingsFile } from "@/lib/server/settings-fs";
import { getTeamLibraryConfig } from "@/lib/server/team-library";
import {
  GIT_HOST_ALLOWLIST_KEY,
  readGitHostAllowlist,
} from "@/lib/server/trusted-git-host";

const BOM = "\uFEFF";
const FAKE_API_KEY = "fake-api-key-for-bom-test-0001";
const FAKE_GIT_TOKEN = "fake-git-token-for-bom-test-0002";

const ENV_KEYS = ["FLOWSHIP_DATA_DIR", "HOME", "USERPROFILE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "flowship-bom-config-"));
  dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.FLOWSHIP_DATA_DIR = dataDir;
  // 家目录也指到临时目录：~/.cursor/mcp.json 与诊断包的 ~/Downloads 都不能碰真实目录
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(root, { recursive: true, force: true });
});

const configPath = (): string => path.join(dataDir, "config.json");
const writeConfig = (cfg: unknown, opts: { bom?: boolean } = {}): void => {
  const bom = opts.bom ?? true;
  writeFileSync(
    configPath(),
    `${bom ? BOM : ""}${JSON.stringify(cfg, null, 2)}\n`,
    "utf-8",
  );
};

describe("stripBom", () => {
  it("自检：BOM + 合法 JSON 直接 JSON.parse 会抛（否则下面所有 BOM 用例都在空转）", () => {
    expect(() => JSON.parse(`${BOM}{}`)).toThrow();
    expect(JSON.parse(stripBom(`${BOM}{}`))).toEqual({});
  });

  it("没有 BOM 原样返回（含空串）", () => {
    expect(stripBom("")).toBe("");
    expect(stripBom("{}")).toBe("{}");
    expect(stripBom(" \uFEFF{}")).toBe(" \uFEFF{}");
  });

  it("只去开头的一个：开头两个 BOM 留一个，文本中间的 U+FEFF 是内容、不动", () => {
    expect(stripBom(`${BOM}${BOM}x`)).toBe(`${BOM}x`);
    expect(stripBom(`${BOM}a${BOM}b`)).toBe(`a${BOM}b`);
  });

  it("只有 BOM → 空串（所以「仅 BOM 的文件」在各处仍会被判成空，而不是别的错）", () => {
    expect(stripBom(BOM)).toBe("");
  });
});

describe("describeConfigReadError：只说错误类别，不带文件内容", () => {
  it("JSON 解析错误 → 「JSON 格式不对」，不夹带 V8 报错里的原文", () => {
    let err: unknown;
    try {
      JSON.parse('{"apiKey": LEAKME_abc123}');
    } catch (e) {
      err = e;
    }
    const text = describeConfigReadError(err);
    expect(text).toContain("JSON 格式不对");
    expect(text).not.toContain("LEAKME");
  });

  it("旧版 V8 措辞里带的出错位置数字会保留（只取数字，不取别的）", () => {
    expect(
      describeConfigReadError(
        new SyntaxError('Unexpected token } in JSON at position 12 near "LEAKME"'),
      ),
    ).toBe("JSON 格式不对（位置 12）");
  });

  it("系统错误 → 只留错误码，不含路径", () => {
    const e = Object.assign(
      new Error("EACCES: permission denied, open '/secret/path/config.json'"),
      { code: "EACCES" },
    );
    expect(describeConfigReadError(e)).toBe("EACCES");
  });

  it("拿不到类别 → 「读取失败」", () => {
    expect(describeConfigReadError(new Error("boom"))).toBe("读取失败");
    expect(describeConfigReadError("字符串")).toBe("读取失败");
    expect(describeConfigReadError(undefined)).toBe("读取失败");
  });
});

describe("config.json 带 BOM：每个读取点都要读得出来", () => {
  it("设置页读取（settings-fs）：status=ok、内容完整，且不会生成 config.json.corrupt-* 备份", async () => {
    writeConfig({ apiKey: FAKE_API_KEY, provider: "cursor" });
    const r = await readSettingsFile();
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.settings.apiKey).toBe(FAKE_API_KEY);
    expect(
      readdirSync(dataDir).filter((f) => f.startsWith("config.json.corrupt-")),
    ).toEqual([]);
  });

  it("设置页读取：真坏的 JSON（带 BOM）仍然 error，备份保留原文（含 BOM，是证据）", async () => {
    writeFileSync(configPath(), `${BOM}{"apiKey": "x"`, "utf-8"); // 缺右括号
    const r = await readSettingsFile();
    expect(r.status).toBe("error");
    const backups = readdirSync(dataDir).filter((f) =>
      f.startsWith("config.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    const text = readFileSync(path.join(dataDir, String(backups[0])), "utf-8");
    expect(text.startsWith(BOM)).toBe(true);
  });

  it("设置页读取：根节点不是对象（带 BOM 的 `[1,2]`）→ settings_json_invalid，备份同样逐字保留原文（含 BOM）", async () => {
    // 合法 JSON、但根是数组：走的是「根节点不是对象」那一支，不是 JSON.parse 抛错那一支（审查 AI 独立变异时指出这一支没人看备份内容）
    const original = `${BOM}[1,2]`;
    writeFileSync(configPath(), original, "utf-8");
    const r = await readSettingsFile();
    expect(r).toEqual({ status: "error", reason: "settings_json_invalid" });
    const backups = readdirSync(dataDir).filter((f) =>
      f.startsWith("config.json.corrupt-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, String(backups[0])), "utf-8")).toBe(
      original,
    );
  });

  it("事件脱敏：BOM 的 config.json 里的 apiKey / gitToken 照样被抹掉（脱敏没有静默失效）", () => {
    writeConfig({ apiKey: FAKE_API_KEY, gitToken: FAKE_GIT_TOKEN });
    const out = redactSecretsInText(`key=${FAKE_API_KEY} token=${FAKE_GIT_TOKEN}`);
    expect(out).not.toContain(FAKE_API_KEY);
    expect(out).not.toContain(FAKE_GIT_TOKEN);
  });

  it("事件脱敏：无 BOM 的对照同样被抹掉（证明上一条断言本身是对的）", () => {
    writeConfig({ apiKey: FAKE_API_KEY, gitToken: FAKE_GIT_TOKEN }, { bom: false });
    const out = redactSecretsInText(`key=${FAKE_API_KEY} token=${FAKE_GIT_TOKEN}`);
    expect(out).not.toContain(FAKE_API_KEY);
    expect(out).not.toContain(FAKE_GIT_TOKEN);
  });

  it("自管 MCP（readAppMcpServers）：BOM 下读得到，不会整批静默清零", async () => {
    writeConfig({ mcpServers: { "bom-app": { command: "npx", args: ["x"] } } });
    expect(Object.keys(await readAppMcpServers())).toEqual(["bom-app"]);
  });

  it("禁用规则名单：BOM 下仍生效（被禁用的规则不会重新全开）", async () => {
    const rulesDir = path.join(dataDir, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(path.join(rulesDir, "keep.mdc"), "RULE_KEEP_MARKER", "utf-8");
    writeFileSync(path.join(rulesDir, "off.mdc"), "RULE_OFF_MARKER", "utf-8");
    writeConfig({ disabledRules: ["off"] });
    const prompt = await readAppRulesForPrompt();
    expect(prompt).toContain("RULE_KEEP_MARKER");
    expect(prompt).not.toContain("RULE_OFF_MARKER");
  });

  it("Cursor 全局 mcp.json（导入源）：BOM 下读得到", async () => {
    mkdirSync(path.join(root, ".cursor"), { recursive: true });
    writeFileSync(
      path.join(root, ".cursor", "mcp.json"),
      `${BOM}${JSON.stringify({ mcpServers: { "bom-global": { command: "npx" } } })}`,
      "utf-8",
    );
    expect(Object.keys(await readGlobalCursorMcpServers())).toEqual(["bom-global"]);
  });

  it("git host 白名单（trusted-git-host）：BOM 下用户手改的配置生效", () => {
    writeConfig({ [GIT_HOST_ALLOWLIST_KEY]: ["git.example.internal"] });
    expect(readGitHostAllowlist()).toEqual(["git.example.internal"]);
  });

  it(
    "诊断包：配置概要读得出来（不是「读取失败」），apiKey 明文不进诊断包",
    async () => {
      writeConfig({
        provider: "cursor",
        apiKey: FAKE_API_KEY,
        defaultModel: { id: "composer-2" },
      });
      const text = readFileSync(await exportDiagnostics("0.0.0-test"), "utf8");
      expect(text).toContain("provider: cursor");
      expect(text).not.toContain("config.json 读取失败");
      expect(text).not.toContain(FAKE_API_KEY);
    },
    20_000,
  );

  it("团队库覆盖配置 team-library.json（用户手写）：BOM 下读得到，不会悄悄退回默认配置", async () => {
    writeFileSync(
      path.join(dataDir, "team-library.json"),
      `${BOM}${JSON.stringify({ branch: "release/9.9" })}`,
      "utf-8",
    );
    expect((await getTeamLibraryConfig()).branch).toBe("release/9.9");
  });
});

describe("agent 启动读凭据的两个函数（一个非导出、一个 import 链太重 → 源码契约）", () => {
  const src = readFileSync(
    path.join(process.cwd(), "src/lib/server/task-runner.ts"),
    "utf-8",
  );
  const fnBody = (header: string): string => {
    const start = src.indexOf(header);
    expect(start, `task-runner.ts 里找不到 ${header}`).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf("\n};\n", start));
  };

  it.each([
    ["readServerCreds（agent 启动读 apiKey / 默认模型）", "const readServerCreds = async"],
    ["readServerGitToken（GitLab token）", "export const readServerGitToken = async"],
  ])("%s 解析 config.json 前经 stripBom", (_name, header) => {
    const body = fnBody(header);
    expect(body).toContain("JSON.parse(stripBom(raw))");
    expect(body).not.toMatch(/JSON\.parse\(raw\)/);
  });
});
