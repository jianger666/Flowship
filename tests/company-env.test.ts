/**
 * companyEnv：打平 FS_ENV_* + 导入校验 + brief / auth 三模式 / readonly
 */
import { describe, expect, it } from "vitest";

import {
  COMPANY_ENV_TEMPLATE,
  buildCompanyEnvBrief,
  companyEnvToEnvVars,
  emptyCompanyEnv,
  isCompanyEnvConfigured,
  normalizeCompanyEnv,
  parseCompanyEnvImport,
} from "@/lib/company-env";
import type { CompanyEnv } from "@/lib/types";

describe("companyEnvToEnvVars", () => {
  it("空配置 → 空对象", () => {
    expect(companyEnvToEnvVars(undefined)).toEqual({});
    expect(companyEnvToEnvVars(null)).toEqual({});
    expect(companyEnvToEnvVars(emptyCompanyEnv())).toEqual({});
  });

  it("未填字段不注入", () => {
    const env: CompanyEnv = {
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
      logPathTemplates: [],
      xxljob: [],
      httpApis: [],
      pg: {
        host: "",
        port: 5432,
        user: "u",
        password: "p",
        dbTemplates: [],
        readonly: true,
      },
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("10.0.0.1");
    expect(vars.FS_ENV_TEST_SSH_PORT).toBe("22");
    expect(vars.FS_ENV_TEST_SSH_USER).toBeUndefined();
    expect(vars.FS_ENV_TEST_SSH_PASSWORD).toBeUndefined();
    expect(vars.FS_ENV_PG_HOST).toBeUndefined();
    expect(vars.FS_ENV_PG_USER).toBe("u");
    expect(vars.FS_ENV_PG_PASSWORD).toBe("p");
    expect(vars.FS_ENV_PG_READONLY).toBe("1");
  });

  it("完整配置按约定命名", () => {
    const vars = companyEnvToEnvVars(COMPANY_ENV_TEMPLATE);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("10.0.1.10");
    expect(vars.FS_ENV_TEST_SSH_USER).toBe("deploy");
    expect(vars.FS_ENV_TEST_SSH_PASSWORD).toBe("【填写】");
    expect(vars.FS_ENV_DEV_SSH_HOST).toBe("10.0.2.10");
    expect(vars.FS_ENV_PG_HOST).toBe("10.0.3.20");
    expect(vars.FS_ENV_PG_PORT).toBe("5432");
    expect(vars.FS_ENV_PG_DB_TEMPLATES).toBe("{project}-test\n{project}-dev");
    expect(vars.FS_ENV_PG_READONLY).toBe("1");
    expect(vars.FS_ENV_LOG_PATH_TEMPLATES).toContain("/apps/{project}/logs");
    expect(vars.FS_ENV_XXLJOB_TEST_BASE_URL).toContain("xxljob-test");
    expect(vars.FS_ENV_XXLJOB_TEST_READONLY).toBe("1");
    expect(vars.FS_ENV_NACOS_BASE_URL).toContain("nacos");
    expect(vars.FS_ENV_NACOS_NAMESPACES).toBe("test\ndev");
    expect(vars.FS_ENV_NACOS_READONLY).toBe("1");
    expect(vars.FS_ENV_ELK_DATA_VIEW).toBe("app-logs-*");
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
      logPathTemplates: [],
      xxljob: [],
      httpApis: [],
    };
    const vars = companyEnvToEnvVars(env);
    expect(vars.FS_ENV_TEST_SSH_HOST).toBe("1.1.1.1");
    expect(vars.FS_ENV_TEST_SSH_2_HOST).toBe("2.2.2.2");
    expect(vars.FS_ENV_TEST_SSH_2_PORT).toBe("2222");
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
      pg: { host: "h", port: 5432, user: "u", password: "p" },
      nacos: { baseUrl: "http://n" },
    });
    expect(n.servers).toEqual([]);
    expect(n.xxljob).toEqual([]);
    expect(n.logPathTemplates).toEqual([]);
    expect(n.httpApis).toEqual([]);
    expect(n.pg?.readonly).toBe(true);
    expect(n.nacos?.readonly).toBe(true);
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
      pg: {
        host: "h",
        port: 5432,
        user: "u",
        password: "p",
        dbTemplates: [],
        readonly: false,
      },
      xxljob: [
        {
          env: "test",
          baseUrl: "http://x",
          username: "a",
          password: "b",
          readonly: false,
        },
      ],
      nacos: {
        baseUrl: "http://n",
        username: "",
        password: "",
        namespaces: [],
        readonly: false,
      },
    });
    expect(n.pg?.readonly).toBe(false);
    expect(n.xxljob[0].readonly).toBe(false);
    expect(n.nacos?.readonly).toBe(false);
  });
});

describe("isCompanyEnvConfigured", () => {
  it("空 / 全空字段 → false", () => {
    expect(isCompanyEnvConfigured(undefined)).toBe(false);
    expect(isCompanyEnvConfigured(emptyCompanyEnv())).toBe(false);
    expect(
      isCompanyEnvConfigured({
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
        logPathTemplates: [],
        xxljob: [],
        httpApis: [],
      }),
    ).toBe(false);
  });

  it("有 server host / pg host / xxl baseUrl → true", () => {
    expect(
      isCompanyEnvConfigured({
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
        logPathTemplates: [],
        xxljob: [],
        httpApis: [],
      }),
    ).toBe(true);
    expect(
      isCompanyEnvConfigured({
        ...emptyCompanyEnv(),
        pg: {
          host: "db",
          port: 5432,
          user: "",
          password: "",
          dbTemplates: [],
          readonly: true,
        },
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
          nacos: {
            baseUrl: "http://nacos",
            username: "a",
            password: "b",
            namespaces: [],
            readonly: true,
          },
        },
        ABS,
      ),
    ).toContain("Nacos");
    expect(
      buildCompanyEnvBrief(
        {
          ...emptyCompanyEnv(),
          elk: {
            baseUrl: "http://elk",
            username: "",
            password: "",
            dataView: "logs-*",
          },
        },
        ABS,
      ),
    ).toContain("ELK");
  });

  it("有服务器+子系统 → 含路径与枚举、不含密码 / note", () => {
    const brief = buildCompanyEnvBrief(COMPANY_ENV_TEMPLATE, ABS);
    expect(brief).toContain("## 公司环境");
    expect(brief).toContain(ABS);
    expect(brief).toContain("服务器 2 台");
    expect(brief).toContain(
      "PostgreSQL（只读——只允许 SELECT，禁止 INSERT/UPDATE/DELETE/DDL）",
    );
    expect(brief).toContain("日志路径模板");
    expect(brief).toContain(
      "XXL-Job（只读——只允许查看任务与日志、禁止触发/修改任务）",
    );
    expect(brief).toContain("Nacos（只读——只允许读配置、禁止发布修改）");
    expect(brief).toContain("ELK");
    expect(brief).toContain("HTTP API 2 条");
    expect(brief).toContain("禁止 cat");
    expect(brief).toContain("PGPASSWORD");
    expect(brief).not.toContain("【填写】");
    expect(brief).not.toContain("password");
    expect(brief).not.toContain("有效期约 2h");
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
        pg: {
          host: "db",
          port: 5432,
          user: "u",
          password: "p",
          dbTemplates: [],
          readonly: false,
        },
        xxljob: [
          {
            env: "test",
            baseUrl: "http://x",
            username: "a",
            password: "b",
            readonly: false,
          },
        ],
        nacos: {
          baseUrl: "http://n",
          username: "a",
          password: "b",
          namespaces: [],
          readonly: false,
        },
      },
      ABS,
    );
    expect(brief).toMatch(/已填：.*PostgreSQL(?!（)/);
    expect(brief).toContain("PostgreSQL");
    expect(brief).not.toContain("只允许 SELECT");
    expect(brief).toContain("XXL-Job");
    expect(brief).not.toContain("禁止触发");
    expect(brief).toContain("Nacos");
    expect(brief).not.toContain("禁止发布");
  });

  it("仅 PG → 声明含 PostgreSQL（默认只读文案）", () => {
    const brief = buildCompanyEnvBrief(
      {
        ...emptyCompanyEnv(),
        pg: {
          host: "db.example",
          port: 5432,
          user: "u",
          password: "nope",
          dbTemplates: [],
          readonly: true,
        },
      },
      ABS,
    );
    expect(brief).toContain("只允许 SELECT");
    expect(brief).not.toContain("nope");
  });
});
