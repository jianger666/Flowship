/**
 * companyEnv：打平 FS_ENV_* + 导入校验 + brief / auth 三模式 / readonly
 * + PG / Nacos / ELK 多实例（含旧单对象格式读时升级）
 */
import { describe, expect, it } from "vitest";

import {
  COMPANY_ENV_TEMPLATE,
  buildCompanyEnvBrief,
  cloneCompanyEnv,
  companyEnvToEnvVars,
  emptyCompanyEnv,
  isCompanyEnvConfigured,
  normalizeCompanyEnv,
  parseCompanyEnvImport,
} from "@/lib/company-env";
import type { CompanyEnv, CompanyEnvPg } from "@/lib/types";

/** 造一条 PG 实例（只覆盖关心的字段，其余给默认） */
const pgRow = (over: Partial<CompanyEnvPg> = {}): CompanyEnvPg => ({
  name: "",
  env: "test",
  host: "10.0.0.1",
  port: 5432,
  user: "u",
  password: "p",
  dbTemplates: [],
  readonly: true,
  ...over,
});

describe("companyEnvToEnvVars", () => {
  it("空配置 → 空对象", () => {
    expect(companyEnvToEnvVars(undefined)).toEqual({});
    expect(companyEnvToEnvVars(null)).toEqual({});
    expect(companyEnvToEnvVars(emptyCompanyEnv())).toEqual({});
  });

  it("未填字段不注入", () => {
    const env: CompanyEnv = {
      ...emptyCompanyEnv(),
      servers: [
        {
          name: "a",
          env: "test",
          host: "10.0.0.1",
          port: 22,
          user: "",
          password: "",
        },
      ],
      pg: [pgRow({ host: "", user: "u", password: "p" })],
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("10.0.0.1");
    expect(vars.FS_ENV_TEST_SSH_PORT).toBe("22");
    expect(vars.FS_ENV_TEST_SSH_USER).toBeUndefined();
    expect(vars.FS_ENV_TEST_SSH_PASSWORD).toBeUndefined();
    expect(vars.FS_ENV_PG_TEST_HOST).toBeUndefined();
    expect(vars.FS_ENV_PG_TEST_USER).toBe("u");
    expect(vars.FS_ENV_PG_TEST_PASSWORD).toBe("p");
    expect(vars.FS_ENV_PG_TEST_READONLY).toBe("1");
  });

  it("完整配置按约定命名", () => {
    const vars = companyEnvToEnvVars(COMPANY_ENV_TEMPLATE);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("10.0.1.10");
    expect(vars.FS_ENV_TEST_SSH_USER).toBe("deploy");
    expect(vars.FS_ENV_TEST_SSH_PASSWORD).toBe("【填写】");
    expect(vars.FS_ENV_DEV_SSH_HOST).toBe("10.0.2.10");
    // PG 两个实例：环境段来自各自的 env
    expect(vars.FS_ENV_PG_TEST_NAME).toBe("CRM 测试库");
    expect(vars.FS_ENV_PG_TEST_HOST).toBe("10.0.3.20");
    expect(vars.FS_ENV_PG_TEST_PORT).toBe("5432");
    expect(vars.FS_ENV_PG_TEST_DB_TEMPLATES).toBe(
      "{project}-test\n{project}-dev",
    );
    expect(vars.FS_ENV_PG_TEST_READONLY).toBe("1");
    expect(vars.FS_ENV_PG_PRE_HOST).toBe("10.0.4.20");
    expect(vars.FS_ENV_PG_PRE_DB_TEMPLATES).toBe("{project}-pre");
    expect(vars.FS_ENV_LOG_PATH_TEMPLATES).toContain("/apps/{project}/logs");
    expect(vars.FS_ENV_XXLJOB_TEST_BASE_URL).toContain("xxljob-test");
    expect(vars.FS_ENV_XXLJOB_TEST_READONLY).toBe("1");
    expect(vars.FS_ENV_NACOS_TEST_NAME).toBe("测试集群");
    expect(vars.FS_ENV_NACOS_TEST_BASE_URL).toContain("nacos");
    expect(vars.FS_ENV_NACOS_TEST_NAMESPACES).toBe("test\ndev");
    expect(vars.FS_ENV_NACOS_TEST_READONLY).toBe("1");
    expect(vars.FS_ENV_ELK_TEST_DATA_VIEW).toBe("app-logs-*");
    expect(vars.FS_ENV_HTTPAPI_TEST_NAME).toBe("CRM");
    expect(vars.FS_ENV_HTTPAPI_TEST_AUTH_TYPE).toBe("login");
    expect(vars.FS_ENV_HTTPAPI_TEST_LOGIN_URL).toContain("auth/login");
    expect(vars.FS_ENV_HTTPAPI_TEST_TOKEN_PATH).toBe("token");
    expect(vars.FS_ENV_HTTPAPI_TEST_2_NAME).toBe("OpenAPI");
    expect(vars.FS_ENV_HTTPAPI_TEST_2_AUTH_TYPE).toBe("header");
    expect(vars.FS_ENV_HTTPAPI_TEST_2_HEADER_NAME).toBe("X-Api-Key");
  });

  it("同 env 多台服务器加 _2 后缀", () => {
    const env: CompanyEnv = {
      ...emptyCompanyEnv(),
      servers: [
        {
          name: "a",
          env: "test",
          host: "1.1.1.1",
          port: 22,
          user: "u1",
          password: "p1",
        },
        {
          name: "b",
          env: "test",
          host: "2.2.2.2",
          port: 2222,
          user: "u2",
          password: "p2",
        },
      ],
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("1.1.1.1");
    expect(vars.FS_ENV_TEST_SSH_2_HOST).toBe("2.2.2.2");
    expect(vars.FS_ENV_TEST_SSH_2_PORT).toBe("2222");
  });

  it("同 env 多个 PG / Nacos / ELK 实例加序号后缀，不同 env 各自独立", () => {
    const env: CompanyEnv = {
      ...emptyCompanyEnv(),
      pg: [
        pgRow({ name: "CRM 测试库", env: "test", host: "db1" }),
        pgRow({ name: "订单测试库", env: "test", host: "db2", password: "p2" }),
        pgRow({ name: "预发库", env: "pre", host: "db3" }),
      ],
      nacos: [
        {
          name: "测试集群",
          env: "test",
          baseUrl: "http://n1",
          username: "u1",
          password: "np1",
          namespaces: ["a"],
          readonly: true,
        },
        {
          name: "生产集群",
          env: "prod",
          baseUrl: "http://n2",
          username: "u2",
          password: "np2",
          namespaces: [],
          readonly: false,
        },
      ],
      elk: [
        {
          name: "Kibana 测试",
          env: "test",
          baseUrl: "http://e1",
          username: "eu",
          password: "ep",
          dataView: "logs-*",
        },
        {
          name: "Kibana 测试 2",
          env: "test",
          baseUrl: "http://e2",
          username: "",
          password: "",
          dataView: "",
        },
      ],
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_PG_TEST_HOST).toBe("db1");
    expect(vars.FS_ENV_PG_TEST_NAME).toBe("CRM 测试库");
    expect(vars.FS_ENV_PG_TEST_2_HOST).toBe("db2");
    expect(vars.FS_ENV_PG_TEST_2_PASSWORD).toBe("p2");
    // 换了环境段就从 1 重新数、不受 test 的两条影响
    expect(vars.FS_ENV_PG_PRE_HOST).toBe("db3");
    expect(vars.FS_ENV_PG_PRE_2_HOST).toBeUndefined();

    expect(vars.FS_ENV_NACOS_TEST_BASE_URL).toBe("http://n1");
    expect(vars.FS_ENV_NACOS_TEST_NAMESPACES).toBe("a");
    expect(vars.FS_ENV_NACOS_PROD_BASE_URL).toBe("http://n2");
    expect(vars.FS_ENV_NACOS_PROD_READONLY).toBe("0");

    expect(vars.FS_ENV_ELK_TEST_BASE_URL).toBe("http://e1");
    expect(vars.FS_ENV_ELK_TEST_DATA_VIEW).toBe("logs-*");
    expect(vars.FS_ENV_ELK_TEST_2_BASE_URL).toBe("http://e2");
  });

  it("env 留空 → 不带环境段（旧单实例升上来的那条回到 FS_ENV_PG_* 老键名）", () => {
    const env: CompanyEnv = {
      ...emptyCompanyEnv(),
      pg: [pgRow({ env: "", host: "legacy-db" }), pgRow({ env: "", host: "x" })],
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_PG_HOST).toBe("legacy-db");
    expect(vars.FS_ENV_PG_2_HOST).toBe("x");
    expect(vars.FS_ENV_PG_UNKNOWN_HOST).toBeUndefined();
  });
});

describe("parseCompanyEnvImport / normalizeCompanyEnv", () => {
  it("非法 JSON → ok:false", () => {
    const r = parseCompanyEnvImport("{");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("根非对象 → ok:false", () => {
    const r = parseCompanyEnvImport("[]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/预览模板/);
  });

  it("异形对象（无 companyEnv 键）→ ok:false，不假成功", () => {
    const r = parseCompanyEnvImport(
      JSON.stringify({
        version: 2,
        app: "OtherApp",
        settings: { serverConnections: [] },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/预览模板/);
  });

  it("合法对象回填；坏 servers 项跳过并 warning", () => {
    const r = parseCompanyEnvImport(
      JSON.stringify({
        servers: [
          {
            name: "ok",
            env: "test",
            host: "h",
            port: 22,
            user: "u",
            password: "p",
          },
          { name: "bad", env: "prod", host: "x" },
          "not-object",
        ],
        logPathTemplates: ["/a", 1, ""],
        xxljob: [
          {
            env: "test",
            baseUrl: "http://x",
            username: "a",
            password: "b",
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servers).toHaveLength(1);
    expect(r.value.servers[0].host).toBe("h");
    expect(r.value.logPathTemplates).toEqual(["/a"]);
    expect(r.value.xxljob).toHaveLength(1);
    expect(r.value.xxljob[0].readonly).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("normalize 缺省补空数组；readonly 默认 true", () => {
    const n = normalizeCompanyEnv({
      pg: [{ name: "db", env: "test", host: "h", port: 5432, user: "u", password: "p" }],
      nacos: [{ baseUrl: "http://n" }],
    });
    expect(n.servers).toEqual([]);
    expect(n.xxljob).toEqual([]);
    expect(n.logPathTemplates).toEqual([]);
    expect(n.httpApis).toEqual([]);
    expect(n.elk).toEqual([]);
    expect(n.pg[0].readonly).toBe(true);
    expect(n.nacos[0].readonly).toBe(true);
    // 缺省标识字段补空串（env 空 = 不带环境段）
    expect(n.nacos[0].name).toBe("");
    expect(n.nacos[0].env).toBe("");
  });

  it("pg / nacos / elk 数组里的坏项跳过并 warning", () => {
    const warnings: string[] = [];
    const n = normalizeCompanyEnv(
      {
        pg: [{ host: "good" }, "nope", null],
        nacos: 42,
      },
      warnings,
    );
    expect(n.pg).toHaveLength(1);
    expect(n.pg[0].host).toBe("good");
    expect(n.nacos).toEqual([]);
    expect(warnings.some((w) => w.includes("pg[1]"))).toBe(true);
    expect(warnings.some((w) => w.includes("nacos"))).toBe(true);
  });

  it("httpApis auth 三模式归一", () => {
    const r = parseCompanyEnvImport(
      JSON.stringify({
        servers: [],
        logPathTemplates: [],
        xxljob: [],
        httpApis: [
          { name: "A", env: "test", baseUrl: "https://a", auth: { type: "none" } },
          {
            name: "B",
            env: "test",
            baseUrl: "https://b",
            auth: {
              type: "header",
              headerName: "X-Key",
              headerValue: "secret",
            },
            note: "  固定 key  ",
          },
          {
            name: "C",
            env: "dev",
            baseUrl: "https://c",
            auth: {
              type: "login",
              loginUrl: "https://c/login",
              username: "u",
              password: "p",
              tokenPath: "data.token",
              authHeaderName: "Authorization",
              authHeaderTemplate: "Bearer {token}",
            },
          },
          {
            name: "D",
            env: "test",
            baseUrl: "https://d",
            auth: { type: "weird" },
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.httpApis).toHaveLength(4);
    expect(r.value.httpApis[0].auth).toEqual({ type: "none" });
    expect(r.value.httpApis[1].auth).toEqual({
      type: "header",
      headerName: "X-Key",
      headerValue: "secret",
    });
    expect(r.value.httpApis[1].note).toBe("固定 key");
    expect(r.value.httpApis[2].auth.type).toBe("login");
    if (r.value.httpApis[2].auth.type === "login") {
      expect(r.value.httpApis[2].auth.tokenPath).toBe("data.token");
    }
    expect(r.value.httpApis[3].auth).toEqual({ type: "none" });
    expect(r.warnings.some((w) => w.includes("auth.type"))).toBe(true);
  });

  it("readonly 显式 false 保留", () => {
    const n = normalizeCompanyEnv({
      pg: [
        {
          host: "h",
          port: 5432,
          user: "u",
          password: "p",
          dbTemplates: [],
          readonly: false,
        },
      ],
      xxljob: [
        {
          env: "test",
          baseUrl: "http://x",
          username: "a",
          password: "b",
          readonly: false,
        },
      ],
      nacos: [
        {
          baseUrl: "http://n",
          username: "",
          password: "",
          namespaces: [],
          readonly: false,
        },
      ],
    });
    expect(n.pg[0].readonly).toBe(false);
    expect(n.xxljob[0].readonly).toBe(false);
    expect(n.nacos[0].readonly).toBe(false);
  });
});

// PG / Nacos / ELK 从「单个对象」改成数组之前，用户已经把真实凭据填进去了——
// 读时必须原样升级、绝不能让人重填密码。
describe("normalizeCompanyEnv 旧单对象格式升级", () => {
  const legacy = {
    servers: [
      {
        name: "app-test-01",
        env: "test",
        host: "10.0.1.10",
        port: 22,
        user: "deploy",
        password: "ssh-secret",
      },
    ],
    pg: {
      host: "10.0.3.20",
      port: 15432,
      user: "readonly_user",
      password: "pg-Secret!@#123",
      dbTemplates: ["{project}-test"],
      readonly: false,
    },
    logPathTemplates: ["/apps/{project}/logs/console.log*"],
    xxljob: [],
    nacos: {
      baseUrl: "http://nacos.example.com:8848",
      username: "nacos",
      password: "nacos-Secret-456",
      namespaces: ["test", "dev"],
    },
    elk: {
      baseUrl: "https://kibana.example.com",
      username: "kib",
      password: "elk-Secret-789",
      dataView: "app-logs-*",
    },
    httpApis: [],
  };

  it("单对象 → 单元素数组，密码 / 端口 / 列表原样保留", () => {
    const warnings: string[] = [];
    const n = normalizeCompanyEnv(legacy, warnings);

    expect(n.pg).toHaveLength(1);
    expect(n.pg[0].host).toBe("10.0.3.20");
    expect(n.pg[0].port).toBe(15432);
    expect(n.pg[0].user).toBe("readonly_user");
    expect(n.pg[0].password).toBe("pg-Secret!@#123");
    expect(n.pg[0].dbTemplates).toEqual(["{project}-test"]);
    // 显式 false 不被「默认只读」覆盖
    expect(n.pg[0].readonly).toBe(false);

    expect(n.nacos).toHaveLength(1);
    expect(n.nacos[0].baseUrl).toBe("http://nacos.example.com:8848");
    expect(n.nacos[0].password).toBe("nacos-Secret-456");
    expect(n.nacos[0].namespaces).toEqual(["test", "dev"]);
    expect(n.nacos[0].readonly).toBe(true);

    expect(n.elk).toHaveLength(1);
    expect(n.elk[0].baseUrl).toBe("https://kibana.example.com");
    expect(n.elk[0].password).toBe("elk-Secret-789");
    expect(n.elk[0].dataView).toBe("app-logs-*");

    // 升级是正常路径、不该报 warning 吓用户
    expect(warnings).toEqual([]);
  });

  it("升级后的实例标识为空 → 环境变量回到无环境段的老键名", () => {
    const vars = companyEnvToEnvVars(normalizeCompanyEnv(legacy));
    expect(vars.FS_ENV_PG_HOST).toBe("10.0.3.20");
    expect(vars.FS_ENV_PG_PASSWORD).toBe("pg-Secret!@#123");
    expect(vars.FS_ENV_PG_READONLY).toBe("0");
    expect(vars.FS_ENV_NACOS_BASE_URL).toBe("http://nacos.example.com:8848");
    expect(vars.FS_ENV_ELK_DATA_VIEW).toBe("app-logs-*");
  });

  it("导入旧格式 JSON 文件也走同一升级", () => {
    const r = parseCompanyEnvImport(JSON.stringify(legacy));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pg).toHaveLength(1);
    expect(r.value.pg[0].password).toBe("pg-Secret!@#123");
    expect(r.value.nacos[0].password).toBe("nacos-Secret-456");
    expect(r.value.elk[0].password).toBe("elk-Secret-789");
    expect(r.warnings).toEqual([]);
  });

  it("重复归一幂等（第二次读到的已经是数组）", () => {
    const once = normalizeCompanyEnv(legacy);
    const twice = normalizeCompanyEnv(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe("cloneCompanyEnv", () => {
  it("各实例与其内部数组都不共享引用", () => {
    const src = cloneCompanyEnv(COMPANY_ENV_TEMPLATE);
    const copy = cloneCompanyEnv(src);
    expect(copy).toEqual(src);

    expect(copy.pg).not.toBe(src.pg);
    expect(copy.pg[0]).not.toBe(src.pg[0]);
    expect(copy.pg[0].dbTemplates).not.toBe(src.pg[0].dbTemplates);
    expect(copy.nacos[0]).not.toBe(src.nacos[0]);
    expect(copy.nacos[0].namespaces).not.toBe(src.nacos[0].namespaces);
    expect(copy.elk).not.toBe(src.elk);
    expect(copy.elk[0]).not.toBe(src.elk[0]);

    // 改副本不回写源
    copy.pg[0].password = "changed";
    copy.pg[0].dbTemplates.push("extra");
    copy.nacos[0].namespaces.push("extra");
    copy.elk[0].dataView = "changed";
    expect(src.pg[0].password).toBe("【填写】");
    expect(src.pg[0].dbTemplates).toEqual(["{project}-test", "{project}-dev"]);
    expect(src.nacos[0].namespaces).toEqual(["test", "dev"]);
    expect(src.elk[0].dataView).toBe("app-logs-*");
  });
});

describe("isCompanyEnvConfigured", () => {
  it("空 / 全空字段 → false", () => {
    expect(isCompanyEnvConfigured(undefined)).toBe(false);
    expect(isCompanyEnvConfigured(emptyCompanyEnv())).toBe(false);
    expect(
      isCompanyEnvConfigured({
        ...emptyCompanyEnv(),
        servers: [
          {
            name: "x",
            env: "test",
            host: "  ",
            port: 22,
            user: "u",
            password: "p",
          },
        ],
        pg: [pgRow({ host: "   " })],
      }),
    ).toBe(false);
  });

  it("有 server host / pg host / xxl baseUrl → true", () => {
    expect(
      isCompanyEnvConfigured({
        ...emptyCompanyEnv(),
        servers: [
          {
            name: "x",
            env: "test",
            host: "1.1.1.1",
            port: 22,
            user: "",
            password: "",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isCompanyEnvConfigured({
        ...emptyCompanyEnv(),
        pg: [pgRow({ host: "db" })],
      }),
    ).toBe(true);
  });
});

describe("buildCompanyEnvBrief", () => {
  const ABS = "/tmp/fe-data/company-env.json";

  it("无配置 / 仅空字段 → 空串", () => {
    expect(buildCompanyEnvBrief(null, ABS)).toBe("");
    expect(buildCompanyEnvBrief(undefined, ABS)).toBe("");
    expect(buildCompanyEnvBrief(emptyCompanyEnv(), ABS)).toBe("");
  });

  it("只配 HTTP API → 注入 brief（与 isCompanyEnvConfigured 对齐）", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        httpApis: [
          {
            name: "biz",
            env: "test",
            baseUrl: "https://api.example.com",
            auth: { type: "none" },
          },
        ],
      },
      ABS,
    );
    expect(brief).toContain("## 公司环境");
    expect(brief).toContain("HTTP API 1 条");
    expect(brief).toContain(ABS);
  });

  it("只配 XXL / Nacos / ELK → 也注入", () => {
    expect(
      buildCompanyEnvBrief(
        {
          ...emptyCompanyEnv(),
          xxljob: [
            {
              env: "test",
              baseUrl: "http://x",
              username: "a",
              password: "secret-should-not-appear",
              readonly: true,
            },
          ],
        },
        ABS,
      ),
    ).toContain("XXL-Job");
    expect(
      buildCompanyEnvBrief(
        {
          ...emptyCompanyEnv(),
          nacos: [
            {
              name: "",
              env: "test",
              baseUrl: "http://nacos",
              username: "a",
              password: "b",
              namespaces: [],
              readonly: true,
            },
          ],
        },
        ABS,
      ),
    ).toContain("Nacos 1 个集群");
    expect(
      buildCompanyEnvBrief(
        {
          ...emptyCompanyEnv(),
          elk: [
            {
              name: "",
              env: "test",
              baseUrl: "http://elk",
              username: "",
              password: "",
              dataView: "logs-*",
            },
          ],
        },
        ABS,
      ),
    ).toContain("ELK 1 个实例");
  });

  it("有服务器+子系统 → 含路径与枚举、不含密码 / note", () => {
    const brief = buildCompanyEnvBrief(COMPANY_ENV_TEMPLATE, ABS);
    expect(brief).toContain("## 公司环境");
    expect(brief).toContain(ABS);
    expect(brief).toContain("服务器 2 台");
    expect(brief).toContain(
      "PostgreSQL 2 个实例（只读——只允许 SELECT，禁止 INSERT/UPDATE/DELETE/DDL）",
    );
    expect(brief).toContain("日志路径模板");
    expect(brief).toContain(
      "XXL-Job（只读——只允许查看任务与日志、禁止触发/修改任务）",
    );
    expect(brief).toContain("Nacos 1 个集群（只读——只允许读配置、禁止发布修改）");
    expect(brief).toContain("ELK 1 个实例");
    expect(brief).toContain("HTTP API 2 条");
    expect(brief).toContain("禁止 cat");
    expect(brief).toContain("PGPASSWORD");
    expect(brief).not.toContain("【填写】");
    expect(brief).not.toContain("password");
    expect(brief).not.toContain("有效期约 2h");
    // host / 库名之类的具体连接信息也别抄进 prompt、让 AI 回配置文件读
    expect(brief).not.toContain("10.0.3.20");
  });

  it("多实例只读性不一致 → 报只读条数、让 AI 回配置文件逐条判断", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        pg: [
          pgRow({ host: "db1", readonly: true }),
          pgRow({ host: "db2", readonly: false }),
          pgRow({ host: "db3", readonly: true }),
        ],
        nacos: [
          {
            name: "",
            env: "test",
            baseUrl: "http://n1",
            username: "",
            password: "",
            namespaces: [],
            readonly: true,
          },
          {
            name: "",
            env: "prod",
            baseUrl: "http://n2",
            username: "",
            password: "",
            namespaces: [],
            readonly: false,
          },
        ],
      },
      ABS,
    );
    expect(brief).toContain(
      "PostgreSQL 3 个实例（其中 2 个只读——只允许 SELECT，禁止 INSERT/UPDATE/DELETE/DDL；其余可写，以配置文件里每条的 readonly 为准）",
    );
    expect(brief).toContain(
      "Nacos 2 个集群（其中 1 个只读——只允许读配置、禁止发布修改；其余可写，以配置文件里每条的 readonly 为准）",
    );
  });

  it("空壳实例（没填 host / baseUrl）不计数", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        pg: [pgRow({ host: "db1" }), pgRow({ host: "  " })],
        elk: [
          {
            name: "",
            env: "",
            baseUrl: "",
            username: "",
            password: "",
            dataView: "",
          },
        ],
      },
      ABS,
    );
    expect(brief).toContain("PostgreSQL 1 个实例");
    expect(brief).not.toContain("ELK");
  });

  it("readonly=false → brief 不加只读括号说明", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        servers: [
          {
            name: "s",
            env: "test",
            host: "1.1.1.1",
            port: 22,
            user: "u",
            password: "p",
          },
        ],
        pg: [pgRow({ host: "db", readonly: false })],
        xxljob: [
          {
            env: "test",
            baseUrl: "http://x",
            username: "a",
            password: "b",
            readonly: false,
          },
        ],
        nacos: [
          {
            name: "",
            env: "test",
            baseUrl: "http://n",
            username: "a",
            password: "b",
            namespaces: [],
            readonly: false,
          },
        ],
      },
      ABS,
    );
    expect(brief).toContain("PostgreSQL 1 个实例、");
    expect(brief).not.toContain("只允许 SELECT");
    expect(brief).toContain("XXL-Job");
    expect(brief).not.toContain("禁止触发");
    expect(brief).toContain("Nacos 1 个集群");
    expect(brief).not.toContain("禁止发布");
    expect(brief).not.toContain("其余可写");
  });

  it("仅 PG → 声明含 PostgreSQL（默认只读文案）", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        pg: [pgRow({ host: "db.example", password: "nope" })],
      },
      ABS,
    );
    expect(brief).toContain("PostgreSQL 1 个实例（只读——");
    expect(brief).toContain("只允许 SELECT");
    expect(brief).not.toContain("nope");
  });
});
