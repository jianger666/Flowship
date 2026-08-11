/**
 * 公司环境配置（companyEnv）纯函数
 *
 * 用途：设置页结构化表单 + 导入/导出/模板；运行时打平为 FS_ENV_*（供 skill 脚本读）。
 * 凭据不进 prompt——只进 config.json / `<dataRoot>/company-env.json`。
 * note / readonly 落文件；brief 只枚举子系统 + 只读软约束文案，不落密码 / note 正文。
 */

import type {
  CompanyEnv,
  CompanyEnvCustom,
  CompanyEnvElk,
  CompanyEnvHttpApi,
  CompanyEnvNacos,
  CompanyEnvPg,
  CompanyEnvRedis,
  CompanyEnvServer,
  CompanyEnvXxlJob,
} from "./types";

/** 空配置（DEFAULT_SETTINGS / 表单初始） */
export const emptyCompanyEnv = (): CompanyEnv => ({
  servers: [],
  pg: [],
  redis: [],
  custom: [],
  xxljob: [],
  nacos: [],
  elk: [],
  httpApis: [],
});

export type CompanyEnvServerIssue = "missing-env" | "missing-user";

/** 已填 host 的服务器必须同时有 env 和 user，否则 ssh-exec 无法选中 / 连接 */
export const findCompanyEnvServerIssue = (
  env: Pick<CompanyEnv, "servers">,
): CompanyEnvServerIssue | null => {
  const missingEnv = env.servers.find((s) => s.host.trim() && !s.env.trim());
  if (missingEnv) return "missing-env";
  const missingUser = env.servers.find((s) => s.host.trim() && !s.user.trim());
  if (missingUser) return "missing-user";
  return null;
};

/** 模板预览用示例（密码统一 `【填写】`，导出给同事填） */
export const COMPANY_ENV_TEMPLATE: CompanyEnv = {
  servers: [
    {
      env: "test",
      host: "10.0.1.10",
      port: 22,
      user: "deploy",
      password: "【填写】",
    },
    {
      env: "dev",
      host: "10.0.2.10",
      port: 22,
      user: "deploy",
      password: "【填写】",
    },
  ],
  // 两条：体现「不同环境 / 不同业务库是不同 host + 不同账号」的多实例用法
  pg: [
    {
      env: "test",
      host: "10.0.3.20",
      port: 5432,
      user: "readonly",
      password: "【填写】",
      readonly: true,
    },
    {
      env: "pre",
      host: "10.0.4.20",
      port: 5432,
      user: "readonly",
      password: "【填写】",
      readonly: true,
    },
  ],
  // Redis / 自定义：真实凭据不进模板（预览/导入空态用），
  // 用户在自己配置里填实际值
  redis: [
    {
      env: "test",
      host: "10.0.5.10",
      port: 6379,
      db: 0,
      password: "【填写】",
      readonly: true,
    },
  ],
  custom: [
    {
      name: "日志路径模板",
      content: "/apps/{project}/logs/console.log*\n/apps/{project}/logs/{project}*",
    },
    {
      name: "应用配置文件路径",
      content: "/apps/{project}/application.properties",
    },
  ],
  xxljob: [
    {
      env: "test",
      baseUrl: "http://xxljob-test.example.com/xxl-job-admin",
      username: "admin",
      password: "【填写】",
      readonly: true,
    },
  ],
  nacos: [
    {
      env: "test",
      baseUrl: "http://nacos-test.example.com:8848",
      username: "nacos",
      password: "【填写】",
      namespaces: ["test", "dev"],
      readonly: true,
    },
  ],
  elk: [
    {
      env: "test",
      baseUrl: "https://kibana-test.example.com",
      username: "readonly",
      password: "【填写】",
      dataView: "app-logs-*",
    },
  ],
  httpApis: [
    {
      env: "test",
      url: "https://api-test.example.com",
      note: "鉴权：先 POST /auth/login 拿 token（响应 JSON 的 token 字段），后续带 Authorization: Bearer <token>；分页参数用 page/pageSize",
    },
    {
      env: "test",
      url: "https://openapi-test.example.com",
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
  const env = envRaw ?? "";
  const host = asTrimmedString(o.host) ?? "";
  if (host && !env) {
    warnings.push(`servers[${idx}] 有主机但缺环境名、SSH 的 --env 无法选中（已保留，请补 env）`);
  }
  if (host && !(asTrimmedString(o.user) ?? "")) {
    warnings.push(`servers[${idx}] 有主机但缺用户、SSH 无法连接（已保留，请补 user）`);
  }
  return {
    env,
    host,
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
  return {
    env: asTrimmedString(o.env) ?? "",
    baseUrl: asTrimmedString(o.baseUrl) ?? "",
    username: asTrimmedString(o.username) ?? "",
    password: typeof o.password === "string" ? o.password : "",
    readonly: asReadonlyDefaultTrue(o.readonly),
  };
};

/** 多实例小节的公共标识字段（env 允许留空；空 = 不带环境段） */
const instanceEnv = (o: Record<string, unknown>): string =>
  asTrimmedString(o.env) ?? "";

const normalizePg = (o: Record<string, unknown>): CompanyEnvPg => ({
  env: instanceEnv(o),
  host: asTrimmedString(o.host) ?? "",
  port: asPort(o.port, 5432),
  user: asTrimmedString(o.user) ?? "",
  password: typeof o.password === "string" ? o.password : "",
  readonly: asReadonlyDefaultTrue(o.readonly),
});

const normalizeRedis = (o: Record<string, unknown>): CompanyEnvRedis => ({
  env: instanceEnv(o),
  host: asTrimmedString(o.host) ?? "",
  port: asPort(o.port, 6379),
  db: typeof o.db === "number" && Number.isFinite(o.db) && o.db >= 0 ? Math.floor(o.db) : 0,
  password: typeof o.password === "string" ? o.password : "",
  readonly: asReadonlyDefaultTrue(o.readonly),
});

const normalizeCustom = (o: Record<string, unknown>): CompanyEnvCustom => ({
  name: asTrimmedString(o.name) ?? "",
  content: typeof o.content === "string" ? o.content.trim() : "",
});

const normalizeNacos = (o: Record<string, unknown>): CompanyEnvNacos => ({
  env: instanceEnv(o),
  baseUrl: asTrimmedString(o.baseUrl) ?? "",
  username: asTrimmedString(o.username) ?? "",
  password: typeof o.password === "string" ? o.password : "",
  namespaces: asStringArray(o.namespaces),
  readonly: asReadonlyDefaultTrue(o.readonly),
});

const normalizeElk = (o: Record<string, unknown>): CompanyEnvElk => ({
  env: instanceEnv(o),
  baseUrl: asTrimmedString(o.baseUrl) ?? "",
  username: asTrimmedString(o.username) ?? "",
  password: typeof o.password === "string" ? o.password : "",
  dataView: asTrimmedString(o.dataView) ?? "",
});

/**
 * 归一 pg / nacos / elk 这三个多实例小节。
 *
 * **单个对象 = 旧版单实例格式**（这三项以前不是数组）——读时原样升级成单元素数组，
 * 用户已填的 host / 账号 / 密码全部保留、不用重填。一次性数据迁移、不是长期兼容层。
 */
const normalizeInstanceList = <T>(
  raw: unknown,
  key: string,
  warnings: string[],
  one: (o: Record<string, unknown>) => T,
): T[] => {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    const out: T[] = [];
    raw.forEach((row, i) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        warnings.push(`${key}[${i}] 不是对象、已跳过`);
        return;
      }
      out.push(one(row as Record<string, unknown>));
    });
    return out;
  }
  if (typeof raw !== "object") {
    warnings.push(`${key} 既不是数组也不是对象、已忽略`);
    return [];
  }
  return [one(raw as Record<string, unknown>)];
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
    env: asTrimmedString(o.env) ?? "",
    url: asTrimmedString(o.url) ?? "",
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

  return {
    servers,
    pg: normalizeInstanceList(o.pg, "pg", warnings, normalizePg),
    redis: normalizeInstanceList(o.redis, "redis", warnings, normalizeRedis),
    custom: normalizeInstanceList(o.custom, "custom", warnings, normalizeCustom),
    xxljob,
    nacos: normalizeInstanceList(o.nacos, "nacos", warnings, normalizeNacos),
    elk: normalizeInstanceList(o.elk, "elk", warnings, normalizeElk),
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
    "redis" in o ||
    "custom" in o ||
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
 * 多实例小节的只读括号文案，三态：
 * 全只读 → 整节约束；全可写 → 不加括号（同 {@link isXxljobReadonly} 的「任一条显式 false → 整节可写」口径）；
 * 混合 → 报只读条数 + 让 AI 回配置文件逐条看 readonly，避免整节口径把可写实例误说成只读。
 */
const readonlyNote = (
  rows: { readonly: boolean }[],
  constraint: string,
): string => {
  const readonlyCount = rows.filter((r) => r.readonly !== false).length;
  if (readonlyCount === 0) return "";
  if (readonlyCount === rows.length) return `（只读——${constraint}）`;
  return `（部分只读——${constraint}；其余可写，以配置文件里每条的 readonly 为准）`;
};

/**
 * 常驻 prompt 声明：有实质配置（≥1 台有 host 的服务器，或 PG host 已填）时返回一段，
 * 否则空串。fileAbsPath = company-env.json 绝对路径（调用方传入，保持本函数纯、可单测）。
 * **绝不写入任何密码 / note 正文**——只枚举已配置子系统 + 只读软约束。
 */
export const buildCompanyEnvBrief = (
  env: CompanyEnv | null | undefined,
  fileAbsPath: string,
  /** SSH 执行脚本路径（agent 用 shell 调；缺省给名字、正式调用方传绝对路径） */
  sshExecPath = "ssh-exec.mjs",
): string => {
  if (!env) return "";
  // 闸门与 isCompanyEnvConfigured 同一谓词：任一子系统有实质配置即注入
  //（旧闸门只认 server/PG host → 只配 HTTP/XXL/Nacos/ELK 时 brief 半残）
  if (!isCompanyEnvConfigured(env)) return "";

  const serverCount = env.servers.filter((s) => s.host.trim()).length;
  // 只统计「填了 host / baseUrl」的实例——空壳条目不该让 AI 以为有得用
  const pgRows = env.pg.filter((p) => p.host.trim());
  const nacosRows = env.nacos.filter((n) => n.baseUrl.trim());
  const elkCount = env.elk.filter((e) => e.baseUrl.trim()).length;

  const parts: string[] = [];
  if (serverCount > 0) parts.push("服务器");
  if (pgRows.length > 0) {
    parts.push(
      `PostgreSQL${readonlyNote(
        pgRows,
        "只允许 SELECT，禁止 INSERT/UPDATE/DELETE/DDL",
      )}`,
    );
  }
  const customRows = env.custom.filter((c) => c.name.trim() || c.content.trim());
  if (customRows.length > 0) {
    // 名称是语义锚点（如「日志路径模板」让 AI 关联服务器 env 拼命令）——只列名称、不列内容
    const names = customRows.map((c) => c.name.trim()).filter(Boolean);
    parts.push(
      names.length > 0 ? `自定义（${names.join("、")}）` : "自定义",
    );
  }
  const redisRows = env.redis.filter((r) => r.host.trim());
  if (redisRows.length > 0) {
    parts.push(
      `Redis${readonlyNote(
        redisRows,
        "只允许读 key / 查缓存，禁止写入",
      )}`,
    );
  }
  if (env.xxljob.some((x) => x.baseUrl.trim())) {
    parts.push(
      isXxljobReadonly(env.xxljob)
        ? "XXL-Job（只读——只允许查看任务与日志、禁止触发/修改任务）"
        : "XXL-Job",
    );
  }
  if (nacosRows.length > 0) {
    parts.push(
      `Nacos${readonlyNote(
        nacosRows,
        "只允许读配置、禁止发布修改",
      )}`,
    );
  }
  if (elkCount > 0) parts.push("ELK");
  const httpApiCount = (env.httpApis ?? []).filter((h) =>
    h.url.trim(),
  ).length;
  if (httpApiCount > 0) parts.push("HTTP API");

  const abs = fileAbsPath.trim() || "company-env.json";
  const sshNote =
    serverCount > 0
      ? `SSH 登录服务器用平台脚本 \`node "${sshExecPath}" --config "${abs}" --env <环境名> [--user <用户>] -- '<远程命令>'\`（整个远程命令必须作为单个带引号的参数传入，脚本原样执行；凭据由脚本从本文件读取、命令不含密码），不要自行拼 ssh 命令。`
      : "";
  return [
    "## 公司环境",
    `公司环境已配置（配置文件：\`${abs}\`，已填：${parts.join("、")}）。需要查服务器日志 / 查测试库 / 看调度任务 / 查配置中心 / 调业务 API 时读取该文件使用；禁止 cat 整个文件或打印其中密码字段。条目里的 note 字段是给 AI 的用法提示（尤其 HTTP API），读取 company-env.json 时注意。${sshNote}`,
  ].join("\n");
};

/**
 * 核心字段是否已配（推进弹窗缺配置提示用）。
 * 任一：有 host 的服务器 / PG host / XXL baseUrl / Nacos baseUrl / ELK baseUrl / HTTP url。
 */
export const isCompanyEnvConfigured = (env: CompanyEnv | undefined): boolean => {
  if (!env) return false;
  if (env.servers.some((s) => s.host.trim())) return true;
  if (env.pg.some((p) => p.host.trim())) return true;
  if (env.redis.some((r) => r.host.trim())) return true;
  if (env.custom.some((c) => c.name.trim() || c.content.trim())) return true;
  if (env.xxljob.some((x) => x.baseUrl.trim())) return true;
  if (env.nacos.some((n) => n.baseUrl.trim())) return true;
  if (env.elk.some((e) => e.baseUrl.trim())) return true;
  if ((env.httpApis ?? []).some((h) => h.url.trim())) return true;
  return false;
};

/** env 名 → 环境变量段（只留 A-Z0-9_） */
const envSegment = (raw: string): string =>
  raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";

/**
 * 多实例子系统的环境变量前缀：`FS_ENV_<子系统>[_<环境段>][_序号]`。
 * env 留空 → 不带环境段（旧单实例配置升上来的那条正好还是 `FS_ENV_PG_*` 老键名）；
 * 同一环境段第 2 条起加 `_2` / `_3`，与 xxljob / httpApis 的现成规则一致。
 * counter 由调用方按子系统各持一个，跨子系统不互相影响。
 */
const instanceVarPrefix = (
  subsystem: string,
  env: string,
  counter: Map<string, number>,
): string => {
  const seg = env.trim() ? `_${envSegment(env)}` : "";
  const n = (counter.get(seg) ?? 0) + 1;
  counter.set(seg, n);
  return `FS_ENV_${subsystem}${seg}${n === 1 ? "" : `_${n}`}`;
};

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

  const serverCount = new Map<string, number>();
  for (const s of env.servers) {
    const seg = s.env.trim() ? envSegment(s.env) : "";
    const n = (serverCount.get(seg) ?? 0) + 1;
    serverCount.set(seg, n);
    const suffix = n === 1 ? "" : `_${n}`;
    const prefix = seg ? `FS_ENV_${seg}_SSH${suffix}` : `FS_ENV_SSH${suffix}`;
    put(out, `${prefix}_HOST`, s.host.trim());
    put(out, `${prefix}_PORT`, s.port);
    put(out, `${prefix}_USER`, s.user.trim());
    put(out, `${prefix}_PASSWORD`, s.password);
  }

  const pgCount = new Map<string, number>();
  for (const p of env.pg) {
    const prefix = instanceVarPrefix("PG", p.env, pgCount);
    put(out, `${prefix}_HOST`, p.host.trim());
    put(out, `${prefix}_PORT`, p.port);
    put(out, `${prefix}_USER`, p.user.trim());
    put(out, `${prefix}_PASSWORD`, p.password);
    put(out, `${prefix}_READONLY`, p.readonly !== false ? "1" : "0");
  }

  const redisCount = new Map<string, number>();
  for (const r of env.redis) {
    const prefix = instanceVarPrefix("REDIS", r.env, redisCount);
    put(out, `${prefix}_HOST`, r.host.trim());
    put(out, `${prefix}_PORT`, r.port);
    put(out, `${prefix}_DB`, r.db);
    put(out, `${prefix}_PASSWORD`, r.password);
    put(out, `${prefix}_READONLY`, r.readonly !== false ? "1" : "0");
  }

  const xxlCount = new Map<string, number>();
  for (const x of env.xxljob) {
    const prefix = instanceVarPrefix("XXLJOB", x.env, xxlCount);
    put(out, `${prefix}_BASE_URL`, x.baseUrl.trim());
    put(out, `${prefix}_USERNAME`, x.username.trim());
    put(out, `${prefix}_PASSWORD`, x.password);
    put(out, `${prefix}_READONLY`, x.readonly !== false ? "1" : "0");
  }

  const nacosCount = new Map<string, number>();
  for (const n of env.nacos) {
    const prefix = instanceVarPrefix("NACOS", n.env, nacosCount);
    put(out, `${prefix}_BASE_URL`, n.baseUrl.trim());
    put(out, `${prefix}_USERNAME`, n.username.trim());
    put(out, `${prefix}_PASSWORD`, n.password);
    put(out, `${prefix}_READONLY`, n.readonly !== false ? "1" : "0");
    if (n.namespaces.length > 0) {
      put(out, `${prefix}_NAMESPACES`, n.namespaces.join("\n"));
    }
  }

  const elkCount = new Map<string, number>();
  for (const e of env.elk) {
    const prefix = instanceVarPrefix("ELK", e.env, elkCount);
    put(out, `${prefix}_BASE_URL`, e.baseUrl.trim());
    put(out, `${prefix}_USERNAME`, e.username.trim());
    put(out, `${prefix}_PASSWORD`, e.password);
    put(out, `${prefix}_DATA_VIEW`, e.dataView.trim());
  }

  const httpCount = new Map<string, number>();
  for (const h of env.httpApis ?? []) {
    const seg = envSegment(h.env || "API");
    const n = (httpCount.get(seg) ?? 0) + 1;
    httpCount.set(seg, n);
    const suffix = n === 1 ? "" : `_${n}`;
    const prefix = `FS_ENV_HTTPAPI_${seg}${suffix}`;
    put(out, `${prefix}_URL`, h.url.trim());
    if (h.note?.trim()) put(out, `${prefix}_NOTE`, h.note.trim());
  }

  return out;
};

/** 深拷贝（settings clone / dirty 比较前防共享引用） */
export const cloneCompanyEnv = (env: CompanyEnv): CompanyEnv => ({
  servers: env.servers.map((s) => ({ ...s })),
  pg: env.pg.map((p) => ({ ...p })),
  redis: env.redis.map((r) => ({ ...r })),
  custom: env.custom.map((c) => ({ ...c })),
  xxljob: env.xxljob.map((x) => ({ ...x })),
  nacos: env.nacos.map((n) => ({ ...n, namespaces: [...n.namespaces] })),
  elk: env.elk.map((e) => ({ ...e })),
  httpApis: (env.httpApis ?? []).map((h) => ({ ...h })),
});
