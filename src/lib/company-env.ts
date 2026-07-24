/**
 * 公司环境配置（companyEnv）纯函数
 *
 * 用途：设置页结构化表单 + 导入/导出/模板；运行时打平为 FS_ENV_*（供 skill 脚本读）。
 * 凭据不进 prompt——只进 config.json / `<dataRoot>/company-env.json`。
 * note / readonly 落文件；brief 只枚举子系统 + 只读软约束文案，不落密码 / note 正文。
 */

import type {
  CompanyEnv,
  CompanyEnvHttpApi,
  CompanyEnvHttpApiAuth,
  CompanyEnvServer,
  CompanyEnvXxlJob,
} from "./types";

/** 空配置（DEFAULT_SETTINGS / 表单初始） */
export const emptyCompanyEnv = (): CompanyEnv => ({
  servers: [],
  logPathTemplates: [],
  xxljob: [],
  httpApis: [],
});

/** 模板预览用示例（密码统一 `【填写】`，导出给同事填） */
export const COMPANY_ENV_TEMPLATE: CompanyEnv = {
  servers: [
    {
      name: "app-test-01",
      env: "test",
      host: "10.0.1.10",
      port: 22,
      user: "deploy",
      password: "【填写】",
    },
    {
      name: "app-dev-01",
      env: "dev",
      host: "10.0.2.10",
      port: 22,
      user: "deploy",
      password: "【填写】",
    },
  ],
  pg: {
    host: "10.0.3.20",
    port: 5432,
    user: "readonly",
    password: "【填写】",
    dbTemplates: ["{project}-test", "{project}-dev"],
    readonly: true,
  },
  logPathTemplates: ["/apps/{project}/logs/console.log*"],
  xxljob: [
    {
      env: "test",
      baseUrl: "http://xxljob-test.example.com/xxl-job-admin",
      username: "admin",
      password: "【填写】",
      readonly: true,
    },
  ],
  nacos: {
    baseUrl: "http://nacos.example.com:8848",
    username: "nacos",
    password: "【填写】",
    namespaces: ["test", "dev"],
    readonly: true,
  },
  elk: {
    baseUrl: "https://kibana.example.com",
    username: "readonly",
    password: "【填写】",
    dataView: "app-logs-*",
  },
  httpApis: [
    {
      name: "CRM",
      env: "test",
      baseUrl: "https://api-test.example.com",
      auth: {
        type: "login",
        loginUrl: "https://api-test.example.com/auth/login",
        username: "readonly",
        password: "【填写】",
        tokenPath: "token",
        authHeaderName: "Authorization",
        authHeaderTemplate: "Bearer {token}",
      },
      note: "登录后 token 有效期约 2h；分页参数用 page/pageSize",
    },
    {
      name: "OpenAPI",
      env: "test",
      baseUrl: "https://openapi-test.example.com",
      auth: {
        type: "header",
        headerName: "X-Api-Key",
        headerValue: "【填写】",
      },
    },
  ],
};

/** 模板 JSON 字符串（预览 dialog / 一键复制） */
export const companyEnvTemplateJson = (): string =>
  `${JSON.stringify(COMPANY_ENV_TEMPLATE, null, 2)}\n`;

const asTrimmedString = (v: unknown): string | undefined =>
  typeof v === "string" ? v.trim() : undefined;

const asPort = (v: unknown, fallback: number): number => {
  if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 65535) {
    return Math.floor(v);
  }
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n) && n > 0 && n <= 65535) return Math.floor(n);
  }
  return fallback;
};

const asStringArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
};

/** 缺省 / 非显式 false → true（只读默认开） */
const asReadonlyDefaultTrue = (v: unknown): boolean => v !== false;

const normalizeServer = (
  raw: unknown,
  warnings: string[],
  idx: number,
): CompanyEnvServer | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`servers[${idx}] 不是对象、已跳过`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const envRaw = asTrimmedString(o.env);
  const env =
    envRaw === "test" || envRaw === "dev" ? envRaw : undefined;
  if (!env) {
    warnings.push(`servers[${idx}].env 非法、已跳过`);
    return null;
  }
  return {
    name: asTrimmedString(o.name) ?? "",
    env,
    host: asTrimmedString(o.host) ?? "",
    port: asPort(o.port, 22),
    user: asTrimmedString(o.user) ?? "",
    password: typeof o.password === "string" ? o.password : "",
  };
};

const normalizeXxl = (
  raw: unknown,
  warnings: string[],
  idx: number,
): CompanyEnvXxlJob | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`xxljob[${idx}] 不是对象、已跳过`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const env = asTrimmedString(o.env);
  if (!env) {
    warnings.push(`xxljob[${idx}].env 缺失、已跳过`);
    return null;
  }
  return {
    env,
    baseUrl: asTrimmedString(o.baseUrl) ?? "",
    username: asTrimmedString(o.username) ?? "",
    password: typeof o.password === "string" ? o.password : "",
    readonly: asReadonlyDefaultTrue(o.readonly),
  };
};

const normalizeHttpAuth = (
  raw: unknown,
  warnings: string[],
  idx: number,
): CompanyEnvHttpApiAuth => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`httpApis[${idx}].auth 缺失或非法、回落 none`);
    return { type: "none" };
  }
  const a = raw as Record<string, unknown>;
  const type = a.type;
  if (type === "header") {
    return {
      type: "header",
      headerName: asTrimmedString(a.headerName) ?? "",
      headerValue: typeof a.headerValue === "string" ? a.headerValue : "",
    };
  }
  if (type === "login") {
    return {
      type: "login",
      loginUrl: asTrimmedString(a.loginUrl) ?? "",
      username: asTrimmedString(a.username) ?? "",
      password: typeof a.password === "string" ? a.password : "",
      tokenPath: asTrimmedString(a.tokenPath) ?? "",
      authHeaderName: asTrimmedString(a.authHeaderName) ?? "",
      authHeaderTemplate: asTrimmedString(a.authHeaderTemplate) ?? "",
    };
  }
  if (type !== "none" && type !== undefined) {
    warnings.push(`httpApis[${idx}].auth.type 未知（${String(type)}）、回落 none`);
  }
  return { type: "none" };
};

const normalizeHttpApi = (
  raw: unknown,
  warnings: string[],
  idx: number,
): CompanyEnvHttpApi | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`httpApis[${idx}] 不是对象、已跳过`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const note = asTrimmedString(o.note);
  return {
    name: asTrimmedString(o.name) ?? "",
    env: asTrimmedString(o.env) ?? "",
    baseUrl: asTrimmedString(o.baseUrl) ?? "",
    auth: normalizeHttpAuth(o.auth, warnings, idx),
    ...(note ? { note } : {}),
  };
};

/**
 * 归一 CompanyEnv：坏字段丢弃并记 warning；缺省补空数组。
 * settings 读盘 / 导入共用。
 */
export const normalizeCompanyEnv = (
  raw: unknown,
  warnings: string[] = [],
): CompanyEnv => {
  if (raw == null) return emptyCompanyEnv();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("根节点不是对象、已回落空配置");
    return emptyCompanyEnv();
  }
  const o = raw as Record<string, unknown>;

  const servers: CompanyEnvServer[] = [];
  if (o.servers !== undefined) {
    if (!Array.isArray(o.servers)) {
      warnings.push("servers 不是数组、已忽略");
    } else {
      o.servers.forEach((row, i) => {
        const s = normalizeServer(row, warnings, i);
        if (s) servers.push(s);
      });
    }
  }

  const xxljob: CompanyEnvXxlJob[] = [];
  if (o.xxljob !== undefined) {
    if (!Array.isArray(o.xxljob)) {
      warnings.push("xxljob 不是数组、已忽略");
    } else {
      o.xxljob.forEach((row, i) => {
        const x = normalizeXxl(row, warnings, i);
        if (x) xxljob.push(x);
      });
    }
  }

  const httpApis: CompanyEnvHttpApi[] = [];
  if (o.httpApis !== undefined) {
    if (!Array.isArray(o.httpApis)) {
      warnings.push("httpApis 不是数组、已忽略");
    } else {
      o.httpApis.forEach((row, i) => {
        const h = normalizeHttpApi(row, warnings, i);
        if (h) httpApis.push(h);
      });
    }
  }

  let pg: CompanyEnv["pg"];
  if (o.pg !== undefined && o.pg !== null) {
    if (typeof o.pg !== "object" || Array.isArray(o.pg)) {
      warnings.push("pg 不是对象、已忽略");
    } else {
      const p = o.pg as Record<string, unknown>;
      pg = {
        host: asTrimmedString(p.host) ?? "",
        port: asPort(p.port, 5432),
        user: asTrimmedString(p.user) ?? "",
        password: typeof p.password === "string" ? p.password : "",
        dbTemplates: asStringArray(p.dbTemplates),
        readonly: asReadonlyDefaultTrue(p.readonly),
      };
    }
  }

  let nacos: CompanyEnv["nacos"];
  if (o.nacos !== undefined && o.nacos !== null) {
    if (typeof o.nacos !== "object" || Array.isArray(o.nacos)) {
      warnings.push("nacos 不是对象、已忽略");
    } else {
      const n = o.nacos as Record<string, unknown>;
      nacos = {
        baseUrl: asTrimmedString(n.baseUrl) ?? "",
        username: asTrimmedString(n.username) ?? "",
        password: typeof n.password === "string" ? n.password : "",
        namespaces: asStringArray(n.namespaces),
        readonly: asReadonlyDefaultTrue(n.readonly),
      };
    }
  }

  let elk: CompanyEnv["elk"];
  if (o.elk !== undefined && o.elk !== null) {
    if (typeof o.elk !== "object" || Array.isArray(o.elk)) {
      warnings.push("elk 不是对象、已忽略");
    } else {
      const e = o.elk as Record<string, unknown>;
      elk = {
        baseUrl: asTrimmedString(e.baseUrl) ?? "",
        username: asTrimmedString(e.username) ?? "",
        password: typeof e.password === "string" ? e.password : "",
        dataView: asTrimmedString(e.dataView) ?? "",
      };
    }
  }

  return {
    servers,
    ...(pg ? { pg } : {}),
    logPathTemplates: asStringArray(o.logPathTemplates),
    xxljob,
    ...(nacos ? { nacos } : {}),
    ...(elk ? { elk } : {}),
    httpApis,
  };
};

export type CompanyEnvImportResult =
  | { ok: true; value: CompanyEnv; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/** 是否像 Flowship companyEnv 根对象（含任一已知键） */
const isFlowshipCompanyEnvShape = (raw: unknown): boolean => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return (
    "servers" in o ||
    "pg" in o ||
    "logPathTemplates" in o ||
    "xxljob" in o ||
    "nacos" in o ||
    "elk" in o ||
    "httpApis" in o
  );
};

const IMPORT_FORMAT_HINT =
  "不是有效的环境配置文件，点「预览模板」看格式";

/**
 * 解析导入 JSON 文本 → 归一后的 CompanyEnv（仅 Flowship 模板 / 直出结构）。
 * 异形包（如其它工具导出）→ ok:false，避免「空配置假成功」。
 */
export const parseCompanyEnvImport = (text: string): CompanyEnvImportResult => {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "不是合法 JSON", warnings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: IMPORT_FORMAT_HINT, warnings };
  }
  if (!isFlowshipCompanyEnvShape(parsed)) {
    return { ok: false, error: IMPORT_FORMAT_HINT, warnings };
  }
  const value = normalizeCompanyEnv(parsed, warnings);
  return { ok: true, value, warnings };
};

/** XXL 小节是否只读（任一条显式 false → 整节可写；空列表视同只读） */
export const isXxljobReadonly = (rows: CompanyEnvXxlJob[]): boolean =>
  rows.length === 0 || rows.every((x) => x.readonly !== false);

/**
 * 常驻 prompt 声明：有实质配置（≥1 台有 host 的服务器，或 PG host 已填）时返回一段，
 * 否则空串。fileAbsPath = company-env.json 绝对路径（调用方传入，保持本函数纯、可单测）。
 * **绝不写入任何密码 / note 正文**——只枚举已配置子系统 + 只读软约束。
 */
export const buildCompanyEnvBrief = (
  env: CompanyEnv | null | undefined,
  fileAbsPath: string,
): string => {
  if (!env) return "";
  // 闸门与 isCompanyEnvConfigured 同一谓词：任一子系统有实质配置即注入
  //（旧闸门只认 server/PG host → 只配 HTTP/XXL/Nacos/ELK 时 brief 半残）
  if (!isCompanyEnvConfigured(env)) return "";

  const serverCount = env.servers.filter((s) => s.host.trim()).length;
  const hasPg = !!env.pg?.host?.trim();

  const parts: string[] = [];
  if (serverCount > 0) parts.push(`服务器 ${serverCount} 台`);
  if (hasPg) {
    parts.push(
      env.pg!.readonly !== false
        ? "PostgreSQL（只读——只允许 SELECT，禁止 INSERT/UPDATE/DELETE/DDL）"
        : "PostgreSQL",
    );
  }
  if (env.logPathTemplates.some((t) => t.trim())) parts.push("日志路径模板");
  if (env.xxljob.some((x) => x.baseUrl.trim())) {
    parts.push(
      isXxljobReadonly(env.xxljob)
        ? "XXL-Job（只读——只允许查看任务与日志、禁止触发/修改任务）"
        : "XXL-Job",
    );
  }
  if (env.nacos?.baseUrl?.trim()) {
    parts.push(
      env.nacos.readonly !== false
        ? "Nacos（只读——只允许读配置、禁止发布修改）"
        : "Nacos",
    );
  }
  if (env.elk?.baseUrl?.trim()) parts.push("ELK");
  const httpApiCount = (env.httpApis ?? []).filter((h) =>
    h.baseUrl.trim(),
  ).length;
  if (httpApiCount > 0) parts.push(`HTTP API ${httpApiCount} 条`);

  const abs = fileAbsPath.trim() || "company-env.json";
  return [
    "## 公司环境",
    `公司环境已配置（配置文件：\`${abs}\`，已填：${parts.join("、")}）。需要查服务器日志 / 查测试库 / 看调度任务 / 查配置中心 / 调业务 API 时读取该文件使用；禁止 cat 整个文件或打印其中密码字段，只允许在命令中引用（如 PGPASSWORD 环境变量方式）。`,
  ].join("\n");
};

/**
 * 核心字段是否已配（推进弹窗缺配置提示用）。
 * 任一：有 host 的服务器 / PG host / XXL baseUrl / Nacos baseUrl / ELK baseUrl / HTTP baseUrl。
 */
export const isCompanyEnvConfigured = (env: CompanyEnv | undefined): boolean => {
  if (!env) return false;
  if (env.servers.some((s) => s.host.trim())) return true;
  if (env.pg?.host?.trim()) return true;
  if (env.xxljob.some((x) => x.baseUrl.trim())) return true;
  if (env.nacos?.baseUrl?.trim()) return true;
  if (env.elk?.baseUrl?.trim()) return true;
  if ((env.httpApis ?? []).some((h) => h.baseUrl.trim())) return true;
  return false;
};

/** env 名 → 环境变量段（只留 A-Z0-9_） */
const envSegment = (raw: string): string =>
  raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";

/** 仅非空字符串才写入 */
const put = (
  out: Record<string, string>,
  key: string,
  value: string | number | undefined | null,
): void => {
  if (value == null) return;
  const s = typeof value === "number" ? String(value) : value;
  if (!s) return;
  out[key] = s;
};

/**
 * CompanyEnv → FS_ENV_* 扁平环境变量。
 * 未配置（空串 / 缺省小节）的项不注入。
 */
export const companyEnvToEnvVars = (
  env: CompanyEnv | undefined | null,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!env) return out;

  const envCount = new Map<string, number>();
  for (const s of env.servers) {
    const seg = envSegment(s.env);
    const n = (envCount.get(seg) ?? 0) + 1;
    envCount.set(seg, n);
    const suffix = n === 1 ? "" : `_${n}`;
    const prefix = `FS_ENV_${seg}_SSH${suffix}`;
    put(out, `${prefix}_HOST`, s.host.trim());
    put(out, `${prefix}_PORT`, s.port);
    put(out, `${prefix}_USER`, s.user.trim());
    put(out, `${prefix}_PASSWORD`, s.password);
    put(out, `${prefix}_NAME`, s.name.trim());
  }

  if (env.pg) {
    put(out, "FS_ENV_PG_HOST", env.pg.host.trim());
    put(out, "FS_ENV_PG_PORT", env.pg.port);
    put(out, "FS_ENV_PG_USER", env.pg.user.trim());
    put(out, "FS_ENV_PG_PASSWORD", env.pg.password);
    put(out, "FS_ENV_PG_READONLY", env.pg.readonly !== false ? "1" : "0");
    if (env.pg.dbTemplates.length > 0) {
      put(out, "FS_ENV_PG_DB_TEMPLATES", env.pg.dbTemplates.join("\n"));
    }
  }

  if (env.logPathTemplates.length > 0) {
    put(out, "FS_ENV_LOG_PATH_TEMPLATES", env.logPathTemplates.join("\n"));
  }

  const xxlCount = new Map<string, number>();
  for (const x of env.xxljob) {
    const seg = envSegment(x.env);
    const n = (xxlCount.get(seg) ?? 0) + 1;
    xxlCount.set(seg, n);
    const suffix = n === 1 ? "" : `_${n}`;
    const prefix = `FS_ENV_XXLJOB_${seg}${suffix}`;
    put(out, `${prefix}_BASE_URL`, x.baseUrl.trim());
    put(out, `${prefix}_USERNAME`, x.username.trim());
    put(out, `${prefix}_PASSWORD`, x.password);
    put(out, `${prefix}_READONLY`, x.readonly !== false ? "1" : "0");
  }

  if (env.nacos) {
    put(out, "FS_ENV_NACOS_BASE_URL", env.nacos.baseUrl.trim());
    put(out, "FS_ENV_NACOS_USERNAME", env.nacos.username.trim());
    put(out, "FS_ENV_NACOS_PASSWORD", env.nacos.password);
    put(
      out,
      "FS_ENV_NACOS_READONLY",
      env.nacos.readonly !== false ? "1" : "0",
    );
    if (env.nacos.namespaces.length > 0) {
      put(out, "FS_ENV_NACOS_NAMESPACES", env.nacos.namespaces.join("\n"));
    }
  }

  if (env.elk) {
    put(out, "FS_ENV_ELK_BASE_URL", env.elk.baseUrl.trim());
    put(out, "FS_ENV_ELK_USERNAME", env.elk.username.trim());
    put(out, "FS_ENV_ELK_PASSWORD", env.elk.password);
    put(out, "FS_ENV_ELK_DATA_VIEW", env.elk.dataView.trim());
  }

  const httpCount = new Map<string, number>();
  for (const h of env.httpApis ?? []) {
    const seg = envSegment(h.env || h.name || "API");
    const n = (httpCount.get(seg) ?? 0) + 1;
    httpCount.set(seg, n);
    const suffix = n === 1 ? "" : `_${n}`;
    const prefix = `FS_ENV_HTTPAPI_${seg}${suffix}`;
    put(out, `${prefix}_NAME`, h.name.trim());
    put(out, `${prefix}_BASE_URL`, h.baseUrl.trim());
    put(out, `${prefix}_AUTH_TYPE`, h.auth.type);
    if (h.note?.trim()) put(out, `${prefix}_NOTE`, h.note.trim());
    if (h.auth.type === "header") {
      put(out, `${prefix}_HEADER_NAME`, h.auth.headerName.trim());
      put(out, `${prefix}_HEADER_VALUE`, h.auth.headerValue);
    } else if (h.auth.type === "login") {
      put(out, `${prefix}_LOGIN_URL`, h.auth.loginUrl.trim());
      put(out, `${prefix}_USERNAME`, h.auth.username.trim());
      put(out, `${prefix}_PASSWORD`, h.auth.password);
      put(out, `${prefix}_TOKEN_PATH`, h.auth.tokenPath.trim());
      put(out, `${prefix}_AUTH_HEADER_NAME`, h.auth.authHeaderName.trim());
      put(
        out,
        `${prefix}_AUTH_HEADER_TEMPLATE`,
        h.auth.authHeaderTemplate.trim(),
      );
    }
  }

  return out;
};

const cloneHttpAuth = (auth: CompanyEnvHttpApiAuth): CompanyEnvHttpApiAuth => {
  if (auth.type === "none") return { type: "none" };
  if (auth.type === "header") return { ...auth };
  return { ...auth };
};

/** 深拷贝（settings clone / dirty 比较前防共享引用） */
export const cloneCompanyEnv = (env: CompanyEnv): CompanyEnv => ({
  servers: env.servers.map((s) => ({ ...s })),
  ...(env.pg
    ? {
        pg: {
          ...env.pg,
          dbTemplates: [...env.pg.dbTemplates],
        },
      }
    : {}),
  logPathTemplates: [...env.logPathTemplates],
  xxljob: env.xxljob.map((x) => ({ ...x })),
  ...(env.nacos
    ? {
        nacos: {
          ...env.nacos,
          namespaces: [...env.nacos.namespaces],
        },
      }
    : {}),
  ...(env.elk ? { elk: { ...env.elk } } : {}),
  httpApis: (env.httpApis ?? []).map((h) => ({
    ...h,
    auth: cloneHttpAuth(h.auth),
  })),
});
