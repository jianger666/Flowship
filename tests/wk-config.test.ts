/**
 * 团队 wk 配置（`~/.wk/config.yaml`）读写
 *
 * 重点锁四件事：
 * 1. 解析口径跟官方 python 脚本一致（`read_simple_delivery_yaml` + `TRUE_VALUES`）
 * 2. 写回时**只动我们托管的键**——同事配的其它段 / 同段其它键 / 注释一律原样保留
 * 3. 反复保存幂等（不会越写越多重复键或重复注释）
 * 4. 团队默认 Hub 地址「只播种一次」——第一次真写进文件（脚本只认文件），
 *    之后地址归用户管，包括「清空 = 不接入 Hub」
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyWkConfig,
  configFromYaml,
  DEFAULT_HUB_BASE_URL,
  isWkTruthy,
  parseSimpleYaml,
  type WkConfig,
} from "@/lib/wk-config";

// 落盘测试要把 home 指到临时目录——绝不能碰用户真实的 ~/.wk/config.yaml
const hoisted = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => hoisted.home };
});

const cfg = (over: Partial<WkConfig> = {}): WkConfig => ({
  docRepoPath: "",
  hubBaseUrl: "",
  hubToken: "",
  hubTokenConfigured: false,
  requireBaseline: false,
  requireSync: false,
  ...over,
});

describe("parseSimpleYaml（官方口径）", () => {
  it("只认顶层键 + 一层缩进子键，注释 / 空行跳过", () => {
    const parsed = parseSimpleYaml(
      [
        "# 顶头注释",
        "",
        "doc_repo:",
        "  local_path: /Users/me/wk-doc",
        "  provider: local",
        "delivery_hub:",
        "  base_url: http://10.0.0.5:8088",
        "",
      ].join("\n"),
    );
    expect(parsed["doc_repo"]).toEqual({
      local_path: "/Users/me/wk-doc",
      provider: "local",
    });
    expect(parsed["delivery_hub"]).toEqual({
      base_url: "http://10.0.0.5:8088",
    });
  });

  it("值去首尾引号；URL 里的冒号不当分隔符", () => {
    const parsed = parseSimpleYaml(
      ['delivery_hub:', '  base_url: "https://hub.corp:8443/api"'].join("\n"),
    );
    expect(parsed["delivery_hub"]?.["base_url"]).toBe("https://hub.corp:8443/api");
  });

  it("没有所属顶层段的缩进行忽略", () => {
    expect(parseSimpleYaml("  local_path: /x\n")).toEqual({});
  });
});

describe("isWkTruthy（对齐官方 TRUE_VALUES）", () => {
  // 官方 doc-quality-gate.py / wk-hook-guard.py / wk-state.py 三处同款：
  // {"1", "true", "yes", "on", "required"}
  it.each(["1", "true", "TRUE", " yes ", "on", "required"])("%s → 开", (v) => {
    expect(isWkTruthy(v)).toBe(true);
  });

  it.each(["0", "false", "", "no", "off", undefined])("%s → 关", (v) => {
    expect(isWkTruthy(v)).toBe(false);
  });
});

describe("configFromYaml", () => {
  it("读出四个字段，开关按官方口径归一", () => {
    expect(
      configFromYaml(
        [
          "doc_repo:",
          "  local_path: /Users/me/wk-doc",
          "delivery_hub:",
          "  base_url: http://127.0.0.1:8088",
          "  require_baseline: required",
          "  require_sync: false",
        ].join("\n"),
      ),
    ).toEqual({
      docRepoPath: "/Users/me/wk-doc",
      hubBaseUrl: "http://127.0.0.1:8088",
      hubToken: "",
      hubTokenConfigured: false,
      requireBaseline: true,
      requireSync: false,
    });
  });

  it("空文件 → 空配置、开关全关", () => {
    expect(configFromYaml("")).toEqual(cfg());
  });
});

describe("applyWkConfig：只动托管键", () => {
  // 官方模板里 doc_repo / delivery_hub 都还有别的键（provider / url / default_branch /
  // server_upload / operator_*），整段重写会把同事配的这些悄悄抹掉
  const existing = [
    "# 团队 harness 本机配置",
    "doc_repo:",
    "  provider: gitlab",
    "  url: git@gitlab.example.com:ai/harness-docs.git",
    "  local_path: /old/doc",
    "  default_branch: main",
    "",
    "requirements:",
    "  root_dir: requirements",
    "",
    "delivery_hub:",
    '  base_url: "http://127.0.0.1:8088"',
    "  require_baseline: false",
    "  require_sync: false",
    "  server_upload: true",
    '  operator_account: "clj"',
    "",
  ].join("\n");

  const next = applyWkConfig(
    existing,
    cfg({ docRepoPath: "/new/doc", hubBaseUrl: "http://10.0.0.5:8088" }),
  );

  it("其它顶层段原样保留", () => {
    expect(next).toContain("requirements:");
    expect(next).toContain("  root_dir: requirements");
    expect(next).toContain("# 团队 harness 本机配置");
  });

  it("同段内我们不管的键原样保留", () => {
    expect(next).toContain("  provider: gitlab");
    expect(next).toContain("  url: git@gitlab.example.com:ai/harness-docs.git");
    expect(next).toContain("  default_branch: main");
    expect(next).toContain("  server_upload: true");
    expect(next).toContain('  operator_account: "clj"');
  });

  it("托管键就地更新、不产生重复键", () => {
    const parsed = configFromYaml(next);
    expect(parsed).toEqual({
      docRepoPath: "/new/doc",
      hubBaseUrl: "http://10.0.0.5:8088",
      hubToken: "",
      hubTokenConfigured: false,
      requireBaseline: true,
      requireSync: true,
    });
    expect(next.match(/^\s+local_path:/gm)).toHaveLength(1);
    expect(next.match(/^\s+base_url:/gm)).toHaveLength(1);
    expect(next.match(/^\s+require_sync:/gm)).toHaveLength(1);
    expect(next.match(/^doc_repo:/gm)).toHaveLength(1);
  });

  it("反复写幂等：内容不再变化（注释 / 段不会累积）", () => {
    const twice = applyWkConfig(
      next,
      cfg({ docRepoPath: "/new/doc", hubBaseUrl: "http://10.0.0.5:8088" }),
    );
    expect(twice).toBe(next);
  });

  it("沿用文件里已有的缩进风格", () => {
    const four = applyWkConfig(
      ["delivery_hub:", "    base_url: http://a:1", "    server_upload: true"].join(
        "\n",
      ),
      cfg({ hubBaseUrl: "http://b:2" }),
    );
    expect(four).toContain("    base_url: http://b:2");
    expect(four).toContain("    require_sync: true");
    expect(four).toContain("    server_upload: true");
  });
});

describe("applyWkConfig：新建 / 删除", () => {
  it("空文件 → 生成两段，且能被官方口径读回", () => {
    const out = applyWkConfig(
      "",
      cfg({
        docRepoPath: "/Users/me/wk-doc",
        hubBaseUrl: "http://127.0.0.1:8088",
      }),
    );
    expect(configFromYaml(out)).toEqual({
      docRepoPath: "/Users/me/wk-doc",
      hubBaseUrl: "http://127.0.0.1:8088",
      hubToken: "",
      hubTokenConfigured: false,
      requireBaseline: true,
      requireSync: true,
    });
  });

  it("已有别的段时追加，不吃掉原内容", () => {
    const out = applyWkConfig(
      "requirements:\n  root_dir: requirements\n",
      cfg({ docRepoPath: "/d" }),
    );
    expect(out).toContain("requirements:\n  root_dir: requirements");
    expect(configFromYaml(out).docRepoPath).toBe("/d");
  });

  it("清空路径：段里还有别人的键 → 只删 local_path", () => {
    const out = applyWkConfig(
      ["doc_repo:", "  provider: gitlab", "  local_path: /old"].join("\n"),
      cfg(),
    );
    expect(out).toContain("  provider: gitlab");
    expect(out).not.toContain("local_path");
    expect(out).toContain("doc_repo:");
  });

  it("清空路径：托管键删光 → 整段连同我们写的说明一起移除", () => {
    const created = applyWkConfig("", cfg({ docRepoPath: "/d" }));
    expect(created).toContain("doc_repo:");
    const removed = applyWkConfig(created, cfg());
    expect(removed).not.toContain("doc_repo:");
    expect(removed).not.toContain("Flowship 写入");
  });

  it("地址留空 → 三个 delivery_hub 键一起清掉（避免官方脚本 require_* 无地址 FAIL 挡住命令）", () => {
    const out = applyWkConfig(
      [
        "delivery_hub:",
        "  base_url: http://a:1",
        "  require_baseline: true",
        "  require_sync: true",
        "  operator_source: cursor",
      ].join("\n"),
      cfg(),
    );
    expect(out).not.toContain("base_url");
    expect(out).not.toContain("require_baseline");
    expect(out).not.toContain("require_sync");
    // 别人的键仍在
    expect(out).toContain("  operator_source: cursor");
  });
});

describe("applyWkConfig：值的写法", () => {
  it("不加引号，Windows 路径不被转义（官方不做反转义、加双引号会读成 \\\\）", () => {
    const out = applyWkConfig("", cfg({ docRepoPath: "C:\\Users\\me\\wk-doc" }));
    expect(out).toContain("  local_path: C:\\Users\\me\\wk-doc");
    expect(configFromYaml(out).docRepoPath).toBe("C:\\Users\\me\\wk-doc");
  });

  // 2026-07-28 用户拍板：「运行前拉最新产物 / 产物变更推回」是理应开启的、设置页不给开关。
  // 写盘这一层兜死，免得哪天又从别处漏进一个「关」（半开半关的配置最难查）
  it("有地址时两个 require_* 固定写 true——调用方说 false 也不听", () => {
    const out = applyWkConfig(
      "",
      // cfg() 默认两个开关都是 false
      cfg({ hubBaseUrl: "http://a:1" }),
    );
    expect(out).toContain("  require_baseline: true");
    expect(out).toContain("  require_sync: true");
  });

  it("同事文件里写着 false → 一样被改成 true", () => {
    const out = applyWkConfig(
      [
        "delivery_hub:",
        "  base_url: http://a:1",
        "  require_baseline: false",
        "  require_sync: false",
      ].join("\n"),
      cfg({ hubBaseUrl: "http://a:1" }),
    );
    expect(configFromYaml(out)).toMatchObject({
      requireBaseline: true,
      requireSync: true,
    });
  });

  it("含空格井号的路径加单引号，仍能原样读回", () => {
    const weird = "/Users/me/wk doc #1";
    const out = applyWkConfig("", cfg({ docRepoPath: weird }));
    expect(configFromYaml(out).docRepoPath).toBe(weird);
  });
});

describe("Delivery Hub Token", () => {
  const existing = [
    "delivery_hub:",
    "  base_url: https://hub.example.com",
    "  token: old-secret",
    "  require_baseline: true",
    "  require_sync: true",
  ].join("\n");

  it("读取时回填 Token，密码框可显示已保存值", () => {
    const parsed = configFromYaml(existing);
    expect(parsed.hubTokenConfigured).toBe(true);
    expect(parsed.hubToken).toBe("old-secret");
  });

  it("保存目录或地址时保留已有 Token", () => {
    const out = applyWkConfig(
      existing,
      cfg({
        docRepoPath: "/new",
        hubBaseUrl: "https://hub.example.com",
        hubToken: "old-secret",
        hubTokenConfigured: true,
      }),
    );
    expect(out).toContain("  token: old-secret");
  });

  it("显式提交时覆盖 Token，显式清除时只删除 Token", () => {
    const updated = applyWkConfig(existing, {
      docRepoPath: "",
      hubBaseUrl: "https://hub.example.com",
      hubToken: "new-secret",
    });
    expect(updated).toContain("  token: new-secret");
    expect(updated).not.toContain("old-secret");

    const cleared = applyWkConfig(updated, {
      docRepoPath: "",
      hubBaseUrl: "https://hub.example.com",
      hubToken: "",
    });
    expect(cleared).not.toContain("token:");
    expect(cleared).toContain("  base_url: https://hub.example.com");
    expect(cleared).toContain("  require_sync: true");
  });
});

describe("readWkConfig / writeWkConfig（真落盘）", () => {
  const dirs: string[] = [];
  // 「默认地址已播种」的标记落 app 数据目录——同样指到临时目录，用例之间不串味
  const prevDataDir = process.env.FLOWSHIP_DATA_DIR;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-wk-config-"));
    dirs.push(dir);
    hoisted.home = dir;
    process.env.FLOWSHIP_DATA_DIR = path.join(dir, "app-data");
  });

  afterEach(async () => {
    // 不能无脑 delete：同一个 worker 里跑的别的测试文件可能也靠这个变量
    if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  /** 每个用例现 import：拿到的是当前 home 下的行为 */
  const load = async () => await import("@/lib/server/wk-config");

  it("写入后能读回，且 ~/.wk 自动建", async () => {
    const { readWkConfig, writeWkConfig, wkConfigPath } = await load();
    await writeWkConfig(
      cfg({
        docRepoPath: "/Users/me/wk-doc",
        hubBaseUrl: "http://127.0.0.1:8088",
      }),
    );
    expect(wkConfigPath()).toBe(path.join(hoisted.home, ".wk", "config.yaml"));
    expect(await readWkConfig()).toEqual(
      cfg({
        docRepoPath: "/Users/me/wk-doc",
        hubBaseUrl: "http://127.0.0.1:8088",
        requireBaseline: true,
        requireSync: true,
      }),
    );
  });

  it("写回保留同事手写的其它段和键", async () => {
    const { readWkConfig, writeWkConfig, wkConfigPath } = await load();
    const target = wkConfigPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      [
        "# 我自己加的说明",
        "doc_repo:",
        "  provider: gitlab",
        "  local_path: /old",
        "",
        "requirements:",
        "  root_dir: requirements",
        "",
        "knowledge_base:",
        "  mode: local",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeWkConfig(cfg({ docRepoPath: "/new", hubBaseUrl: "http://h:8088" }));

    const raw = await fs.readFile(target, "utf8");
    expect(raw).toContain("# 我自己加的说明");
    expect(raw).toContain("  provider: gitlab");
    expect(raw).toContain("requirements:\n  root_dir: requirements");
    expect(raw).toContain("knowledge_base:\n  mode: local");
    expect((await readWkConfig()).docRepoPath).toBe("/new");

    // 连写两次不应改变文件内容（幂等、注释不累积）
    await writeWkConfig(cfg({ docRepoPath: "/new", hubBaseUrl: "http://h:8088" }));
    expect(await fs.readFile(target, "utf8")).toBe(raw);
  });

  it("不留临时文件（tmp → rename 落盘）", async () => {
    const { writeWkConfig, wkConfigPath } = await load();
    await writeWkConfig(cfg({ docRepoPath: "/d" }));
    const entries = await fs.readdir(path.dirname(wkConfigPath()));
    expect(entries).toEqual(["config.yaml"]);
  });
});

/**
 * 团队默认 Hub 地址的播种规则。
 *
 * 「真的生效」= 必须落进 `~/.wk/config.yaml`：官方 python 脚本
 * （`doc-quality-gate.py` → `wk-delivery-baseline.py`）自己读这个文件，
 * 我们内存里补一个默认值对它们不存在。
 *
 * 「只播种一次」= 文件里没有 base_url 有两种含义（从没配过 / 用户清空了），
 * 靠 app 数据目录里的标记区分。清空地址是 Hub 挂掉时用户唯一的自救路（两个
 * require_* 已经没有开关了），不能被默认值一遍遍冲掉。
 */
describe("默认 Delivery Hub 地址：只播种一次", () => {
  const dirs: string[] = [];
  const prevDataDir = process.env.FLOWSHIP_DATA_DIR;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fe-wk-seed-"));
    dirs.push(dir);
    hoisted.home = dir;
    process.env.FLOWSHIP_DATA_DIR = path.join(dir, "app-data");
  });

  afterEach(async () => {
    if (prevDataDir === undefined) delete process.env.FLOWSHIP_DATA_DIR;
    else process.env.FLOWSHIP_DATA_DIR = prevDataDir;
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  const load = async () => await import("@/lib/server/wk-config");

  it("从没配过 → 补上团队默认地址，并**真的写进文件**（脚本只认文件）", async () => {
    const { readWkConfig, wkConfigPath } = await load();
    expect(await readWkConfig()).toEqual(
      cfg({
        hubBaseUrl: DEFAULT_HUB_BASE_URL,
        requireBaseline: true,
        requireSync: true,
      }),
    );

    const raw = await fs.readFile(wkConfigPath(), "utf8");
    expect(raw).toContain(`base_url: ${DEFAULT_HUB_BASE_URL}`);
    expect(raw).toContain("require_baseline: true");
    expect(raw).toContain("require_sync: true");
  });

  // 现网真实形态：文件里只有 doc_repo（这一节上线前手配的），压根没有 delivery_hub 段
  it("只有 doc_repo 的老文件 → 追加 delivery_hub 段，原有内容和注释一字不动", async () => {
    const { readWkConfig, wkConfigPath } = await load();
    const target = wkConfigPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      ["# 我自己写的说明", "doc_repo:", "  local_path: /Users/me/wk-doc", ""].join(
        "\n",
      ),
      "utf8",
    );

    expect(await readWkConfig()).toEqual(
      cfg({
        docRepoPath: "/Users/me/wk-doc",
        hubBaseUrl: DEFAULT_HUB_BASE_URL,
        requireBaseline: true,
        requireSync: true,
      }),
    );

    const raw = await fs.readFile(target, "utf8");
    expect(raw).toContain("# 我自己写的说明");
    expect(raw).toContain("  local_path: /Users/me/wk-doc");
    expect(raw).toContain("delivery_hub:");
  });

  it("用户已经配了别的地址 → 原样用他的，不塞默认值", async () => {
    const { readWkConfig, writeWkConfig } = await load();
    await writeWkConfig(cfg({ hubBaseUrl: "http://10.0.0.9:8088" }));
    expect((await readWkConfig()).hubBaseUrl).toBe("http://10.0.0.9:8088");
  });

  it("播种后用户清空 → 保持清空（三个键一起没了 = 不去 Hub 拉 baseline）", async () => {
    const { readWkConfig, writeWkConfig, wkConfigPath } = await load();
    expect((await readWkConfig()).hubBaseUrl).toBe(DEFAULT_HUB_BASE_URL);

    await writeWkConfig(cfg({ docRepoPath: "/d", hubBaseUrl: "" }));
    expect((await readWkConfig()).hubBaseUrl).toBe("");

    const raw = await fs.readFile(wkConfigPath(), "utf8");
    expect(raw).not.toContain("base_url");
    expect(raw).not.toContain("require_baseline");
  });

  it("老用户（早就自己配过地址）之后清空 → 同样不被默认值冲掉", async () => {
    const { readWkConfig, writeWkConfig } = await load();
    await writeWkConfig(cfg({ hubBaseUrl: "http://10.0.0.9:8088" }));
    // 这一读记下「地址这事用户自己管」——少了它，下面清空会被当成「从没配过」
    await readWkConfig();

    await writeWkConfig(cfg({ hubBaseUrl: "" }));
    expect((await readWkConfig()).hubBaseUrl).toBe("");
  });

  it("反复读不会重复写（第二次读文件内容一模一样）", async () => {
    const { readWkConfig, wkConfigPath } = await load();
    await readWkConfig();
    const first = await fs.readFile(wkConfigPath(), "utf8");
    await readWkConfig();
    expect(await fs.readFile(wkConfigPath(), "utf8")).toBe(first);
  });
});
