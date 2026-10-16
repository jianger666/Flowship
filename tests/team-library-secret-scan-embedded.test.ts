/**
 * 团队库密钥扫描：第五轮审查 F2-03 / F2-04 的漏报（YAML 缩进嵌套 / URL 首个查询参数 / 整体被吞的引号载荷）
 *
 * 实测（用现有函数跑一遍，HEAD 之前全部漏报）：
 * 1. YAML 缩进嵌套：`password:` 换行 `  value: …`。继承只认括号栈（`{` / `[`），缩进式父子完全没有继承——
 *    括号版 `{"password":{"value":"…"}}` 能报，同一份配置写成 YAML 反而漏。
 * 2. URL 首个查询参数：`https://x/p?token=…`。无引号取值只在 `&` 后面跟「键名 + =」时才切开，`?` 不切，
 *    于是 `https:` 的值被吃成 `//x/p?token=…`，`token` 整个漏报（`&` 之后的参数、较长 URL 靠高熵规则偶然兜住，不是靠键名）。
 * 3. 整体被吞的引号载荷：`payload: "{\"password\":\"…\"}"` / `data: '{"password":"…"}'` / `url = "…?api_key=…"`。
 *    外层键的引号串值被整体消费（刻意：字符串里的 `a: b` 不当键，防误报），里面的 JSON / 查询串敏感键没人看。
 *
 * 刻意**不做**的（与 HANDOFF 第五轮记录的设计一致，别在这里破坏）：
 * - 孙子层不继承（括号版与 YAML 版同口径）：`secrets:` 下挂 `meta:` 再挂 `owner:` 这类大对象不能因此误报爆炸；
 * - 嵌入载荷只下钻有限层（见下方深度用例），更深的不追；
 * - 纯标量的 YAML 列表项（`passwords:` 下 `- value`）本轮不补，见文件末尾「已知残留」。
 *
 * 所有口令都是无害的合成值；只断言「会命中 / 不命中」与脱敏后的 snippet。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const scan = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/cfg.yaml", content }]);
const snippets = (content: string): string[] => scan(content).map((h) => h.snippet);
const lines = (...ls: string[]): string => ls.join("\n");

/** 无害的合成口令（16 位字母 + 数字、不含任何占位词） */
const PW = "Zx9fQ2mK7pLw1234";
const PW2 = "Qa1bWc2dXe3f4g5h";

describe("YAML 缩进嵌套：敏感父键下紧邻的子键继承敏感度（F2-03）", () => {
  it.each([
    ["password.value", lines("password:", `  value: ${PW}`), [[2, "password.value=Zx9***"]]],
    ["apiKey.value（camelCase 父键）", lines("apiKey:", `  value: ${PW}`), [[2, "apiKey.value=Zx9***"]]],
    ["secrets 下的 db_pass（子键自己不敏感）", lines("secrets:", `  db_pass: ${PW}`), [[2, "secrets.db_pass=Zx9***"]]],
    ["父键行带行尾空白", lines("password:   ", `  value: ${PW}`), [[2, "password.value=Zx9***"]]],
    ["引号父键", lines('"password":', `  value: ${PW}`), [[2, "password.value=Zx9***"]]],
    [
      "多个子键都继承（同一层的兄弟）",
      lines("secret:", `  db_pass: ${PW}`, `  cache_pw: ${PW2}`),
      [
        [2, "secret.db_pass=Zx9***"],
        [3, "secret.cache_pw=Qa1***"],
      ],
    ],
    [
      "列表项里的父键（有效缩进要把 `- ` 算进去）",
      lines("accounts:", "  - password:", `      value: ${PW}`),
      [[3, "password.value=Zx9***"]],
    ],
    [
      "父键与子键之间有空行 / 注释行",
      lines("password:", "", "  # 说明", `  value: ${PW}`),
      [[4, "password.value=Zx9***"]],
    ],
    ["CRLF 换行", `password:\r\n  value: ${PW}\r\n`, [[2, "password.value=Zx9***"]]],
    [
      "缩进回退后同级键不再继承",
      lines("password:", `  value: ${PW}`, `owner: ${PW2}`),
      [[2, "password.value=Zx9***"]],
    ],
    [
      "兄弟父键各自继承，互不串",
      lines("password:", `  value: ${PW}`, "service:", `  endpoint_note: ${PW2}`, "secret:", `  data: ${PW2}`),
      [
        [2, "password.value=Zx9***"],
        [6, "secret.data=Qa1***"],
      ],
    ],
  ] as Array<[string, string, Array<[number, string]>]>)("%s", (_name, content, expected) => {
    const hits = scan(content);
    expect(hits.map((h) => [h.line, h.snippet]), content).toEqual(expected);
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
    // 绝不回传完整密文
    for (const h of hits) expect(h.snippet).not.toContain(PW.slice(3));
  });

  it("父键行带行尾注释：子键照样继承（只看第 2 行）", () => {
    // 注意：`password: # 生产库` 这一行本身会被现有逻辑把 `#` 当成口令值误报，是本轮之前就有的行为（旧版同样），
    // 不在 F2-03 范围，这里只断言子键的继承不受行尾注释影响
    const hits = scan(lines("password: # 生产库", `  value: ${PW}`)).filter((h) => h.line === 2);
    expect(hits.map((h) => h.snippet)).toEqual(["password.value=Zx9***"]);
  });

  it("对照：子键自己敏感时照旧只报一次（不因继承重复）", () => {
    expect(snippets(lines("secrets:", `  password: ${PW}`))).toEqual(["password=Zx9***"]);
  });

  it("对照：孙子键自己敏感仍命中", () => {
    expect(snippets(lines("secrets:", "  meta:", `    password: ${PW}`))).toEqual(["password=Zx9***"]);
  });
});

describe("YAML 缩进继承的误报面（与括号版同一套值过滤）", () => {
  it.each([
    ["孙子层不继承（刻意：与括号版同口径）", lines("secrets:", "  meta:", "    owner: team-alpha-2024-x")],
    ["键行自己带值就不是父键", lines(`title: ${PW}`, `  other: ${PW2}`)],
    ["父键不敏感", lines("service:", `  endpoint_note: ${PW}`)],
    [
      "元数据子键不继承（路径 / 身份 / 开关 / 长度）",
      lines("password:", "  file: ~/.pw-store", "  username: deploy-2024-admin", "  enabled: true", "  min_length: 8"),
    ],
    ["环境变量引用 / 占位符 / your- 模板", lines("password:", "  value: ${DB_PASSWORD}", "  alt: <password>", "  other: your-password")],
    ["CI 模板插值", lines("secrets:", "  token: ${{ secrets.NPM_TOKEN }}", "  value: ${{ secrets.DB }}")],
    ["token 计数 / 过期", lines("token:", "  ttl: 3600", "  max_tokens: 4096")],
    ["弱敏感父键 + 值不像口令", lines("auth:", "  type: basic", "  mode: none", "  scheme: bearer")],
    ["k8s 引用不是密文", lines("secretKeyRef:", "  name: db-credentials", "  key: db-password")],
    ["design tokens（颜色 / 尺寸）", lines("tokens:", "  primary: '#1890ff'", "  radius: 6px")],
    ["无引号纯标识符（代码变量名）", lines("secret:", "  value: secretValue")],
    ["TS 类型标注里的 `password: string;`", lines("interface Cfg {", "  password: string;", "  token: string;", "}")],
    ["文档说明文字，没有键值对", lines("Password:", "  see the docs for details")],
    ["同缩进的下一个键不是子层", lines("password:", `value: ${PW}`)],
    ["tab 缩进不参与 YAML 继承（YAML 本来就不许 tab）", lines("password:", `\tvalue: ${PW}`)],
  ])("%s", (_name, content) => {
    expect(scan(content), content).toEqual([]);
  });

  it("括号内不走缩进继承：多行 JSON 里的缩进与 YAML 无关，存量括号版行为不变", () => {
    expect(
      snippets(lines("{", '  "name": "x",', '  "password": {', `    "value": "${PW}"`, "  },", `  "owner": "${PW2}"`, "}")),
    ).toEqual(["password.value=Zx9***"]);
  });

  it("上一个文件没收尾的父键不会影响下一个文件", () => {
    const hits = scanSensitiveFiles([
      { path: "a.yaml", content: "password:" },
      { path: "b.yaml", content: `  value: ${PW}` },
    ]);
    expect(hits).toEqual([]);
  });
});

describe("URL 首个查询参数（`?` 后的第一个参数也要能切开，F2-03）", () => {
  it.each([
    ["token 作首个查询参数", `https://x.example.com/p?token=${PW}`, ["token=Zx9***"]],
    ["api_key 作首个查询参数（curl 带引号）", `curl 'https://api.example.com/v1/x?api_key=${PW}'`, ["api_key=Zx9***"]],
    ["access_key", `https://x.example.com/p?access_key=${PW}`, ["access_key=Zx9***"]],
    ["JDBC URL 首个参数", `jdbc:mysql://h/db?password=${PW}`, ["password=Zx9***"]],
    ["首个参数非敏感、第二个敏感（原有 & 行为不退化）", `https://x/p?user=a&api_key=${PW}`, ["api_key=Zx9***"]],
    ["两个敏感参数各报一次", `https://x/p?password=${PW}&token=${PW2}`, ["password=Zx9***", "token=Qa1***"]],
  ])("%s", (_name, content, expected) => {
    const hits = scan(content);
    expect(hits.map((h) => h.snippet), content).toEqual(expected);
    // 以键名命中（不是偶然被高熵规则兜住）
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
  });

  it.each([
    // URL 前缀刻意取短（`//x.io/search` 不足 20 字符）：长 URL 会被高熵规则当成高熵值报（HANDOFF 已记的另一个设计盲区），与本条无关
    ["普通查询串", "https://x.io/search?q=hello&page=2"],
    ["next 跳转路径", "url: https://x/y?next=/a/b/c"],
    ["开关型键（M2-10 原有）", "https://x/y?requirePassword=false&x=1"],
    ["token 计数（数字豁免）", "https://x/y?token=3600"],
    ["占位符", "https://x/y?token=<token>&api_key=your-api-key"],
    ["环境变量引用", "https://x/y?api_key=${API_KEY}"],
    ["模板插值", "https://x/y?api_key={{ secrets.KEY }}"],
    ["键名指向文件 / 路径", "https://x/y?token_file=/etc/tok&secret_name=my-secret"],
  ])("误报面：%s", (_name, content) => {
    expect(scan(content), content).toEqual([]);
  });

  it("`?` 后面不是「键名 + =」时仍是取值的一部分（与 `&` 同一套口径）：口令里的 ? 不会把口令截成两位数字放行", () => {
    expect(snippets("password=12?abc")).toEqual(["password=12?***"]);
    expect(snippets("password=ab?cd")).toEqual(["password=ab?***"]);
    expect(snippets("secret=Zx9?Qw7?Er5")).toEqual(["secret=Zx9***"]);
  });
});

describe("整体被吞的引号载荷：JSON / 查询串 URL 要下钻扫描（F2-04）", () => {
  it.each([
    ["双引号串里转义的 JSON", `payload: "{\\"password\\":\\"${PW}\\"}"`, ["password=Zx9***"]],
    ["单引号串里的 JSON（YAML / py）", `data: '{"password":"${PW}"}'`, ["password=Zx9***"]],
    ["env 赋值里转义的 JSON", `CONFIG="{\\"apiKey\\":\\"${PW}\\"}"`, ["apiKey=Zx9***"]],
    ["JSON 里的字符串字段再嵌 JSON", `"body": "{\\"user\\":\\"a\\",\\"password\\":\\"${PW}\\"}"`, ["password=Zx9***"]],
    ["载荷内部的嵌套继承照常生效", `payload: "{\\"password\\":{\\"value\\":\\"${PW}\\"}}"`, ["password.value=Zx9***"]],
    ["载荷是数组里的对象", `payload: "[{\\"secret\\":\\"${PW}\\"}]"`, ["secret=Zx9***"]],
    ["引号里的 URL 带敏感查询参数", `url = "https://x.example.com/p?api_key=${PW}"`, ["api_key=Zx9***"]],
    ["引号里的 URL，敏感参数不在首位", `url: 'https://x.example.com/p?a=1&token=${PW}'`, ["token=Zx9***"]],
    [
      // 用 JSON.stringify 逐层构造转义，避免手写反斜杠写错：外层引号串反转义一次得到 {"a":"{\"password\":…}"}，
      // 其中字段 a 的值又是一层转义串，再下钻一次才见到 password
      "两层转义（JSON 字符串里再嵌一层 JSON）",
      `x: ${JSON.stringify(JSON.stringify({ a: JSON.stringify({ password: PW }) }))}`,
      ["password=Zx9***"],
    ],
  ])("%s", (_name, content, expected) => {
    const hits = scan(content);
    expect(hits.map((h) => h.snippet), content).toEqual(expected);
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
    for (const h of hits) expect(h.snippet).not.toContain(PW.slice(3));
  });

  it("载荷与外层同一行的其它键各自照常判（外层敏感键、载荷里的敏感键都报，不互相吞）", () => {
    expect(snippets(`token: ${PW2}, payload: "{\\"password\\":\\"${PW}\\"}"`)).toEqual([
      "token=Qa1***",
      "password=Zx9***",
    ]);
  });

  it.each([
    ["载荷里是环境变量引用", 'payload: "{\\"password\\":\\"${DB_PASSWORD}\\"}"'],
    ["载荷里是占位符", 'payload: "{\\"apiKey\\":\\"your-api-key\\",\\"token\\":\\"<token>\\"}"'],
    ["载荷里键敏感但值是开关", 'payload: "{\\"requirePassword\\":false}"'],
    ["载荷里没有敏感键", 'payload: "{\\"name\\":\\"x\\",\\"id\\":1}"'],
    ["非 JSON 的花括号文本", 'msg: "{docs} and {more}"'],
    ["普通字符串里的 `token: x` 仍不当键（原有设计，防误报）", 'note: "set token: RealTokenValue99 later"'],
    ["普通 URL 字符串，没有敏感查询参数", 'url: "https://x.example.com/p?a=1&b=2"'],
    ["引号里是文字说明", 'hint: "请把 password 填到下面的配置里"'],
    ["URL 里的查询参数键敏感但值是占位", 'url: "https://x/p?api_key=<your-key>"'],
  ])("误报面：%s", (_name, content) => {
    expect(scan(content), content).toEqual([]);
  });

  it("下钻深度有限：三层转义以上不追（记录现状，防递归无限放大）", () => {
    // 两层（上面的用例）命中；再多包一层转义不追。这里只钉「不抛、不卡」，不要求命中
    const v1 = JSON.stringify({ password: PW });
    const v2 = JSON.stringify({ a: v1 });
    const v3 = JSON.stringify({ a: v2 });
    const v4 = JSON.stringify({ a: v3 });
    expect(() => scan(`x: ${JSON.stringify(v4)}`)).not.toThrow();
  });
});

describe("新增规则的线性复杂度（不引入二次型正则）", () => {
  const timed = (content: string) => {
    const t0 = performance.now();
    const hits = scan(content);
    return { hits, ms: performance.now() - t0 };
  };

  it.each([
    ["大量 `?a` 分段（无 =）", "x=" + "?a".repeat(40_000)],
    ["`?` 后超长标识符、无 =", `x=?${"a".repeat(80_000)}`],
    ["大量 `?k=` 分段", "x=" + "?k=1".repeat(20_000)],
    ["大量 `&?` 交替", "x=" + "&?".repeat(40_000)],
  ])("`?` 分段：%s", (_name, content) => {
    expect(timed(content).ms).toBeLessThan(1000);
  });

  it("YAML：超长前导空白 + 非键内容", () => {
    expect(timed(`${" ".repeat(200_000)}-${" ".repeat(200_000)}x`).ms).toBeLessThan(1000);
    expect(timed(`${" ".repeat(200_000)}${"a".repeat(100_000)}`).ms).toBeLessThan(1000);
  });

  it("YAML：超长键名但没有冒号收尾 / 超长键名带冒号", () => {
    expect(timed(`${"a".repeat(100_000)} b`).ms).toBeLessThan(1000);
    expect(timed(`${"a".repeat(100_000)}:`).ms).toBeLessThan(1000);
  });

  it("YAML：几万行缩进越来越深 / 越来越浅的父键行（栈上限，弹栈摊还 O(1)）", () => {
    const ls: string[] = [];
    for (let i = 0; i < 30_000; i++) ls.push(`${" ".repeat(i % 200)}k${i}:`);
    expect(timed(ls.join("\n")).ms).toBeLessThan(2500);
  });

  it("YAML：3 万个 `password:` 块，命中数线性、耗时线性", () => {
    const ls: string[] = [];
    const N = 30_000;
    for (let i = 0; i < N; i++) ls.push("password:", `  value: Zx9fQ2mK7pLw${i}`);
    const { hits, ms } = timed(ls.join("\n"));
    expect(hits).toHaveLength(N);
    expect(ms).toBeLessThan(2500);
  });

  it("引号载荷：单个超长载荷（5MB 字符串字段）下钻不二次方、不抛", () => {
    const { hits, ms } = timed(`payload: "{\\"a\\":\\"${"a".repeat(5 * 1024 * 1024)}\\",\\"password\\":\\"${PW}\\"}"`);
    expect(hits.map((h) => h.snippet)).toEqual(["password=Zx9***"]);
    expect(ms).toBeLessThan(3000);
  });

  it("引号载荷：同一行 2 万个小载荷", () => {
    const one = 'a: "{\\"x\\":1}" ';
    const { hits, ms } = timed(one.repeat(20_000));
    expect(hits).toEqual([]);
    expect(ms).toBeLessThan(2500);
  });

  it("引号载荷：深层转义套娃不指数放大", () => {
    // 每套一层反斜杠数量翻倍，12 层已有上百 KB；再深构造串本身就会爆（与被测代码无关）
    let s = `{"password":"${PW}"}`;
    for (let i = 0; i < 12; i++) s = JSON.stringify({ a: s });
    expect(timed(`x: ${JSON.stringify(s)}`).ms).toBeLessThan(1000);
  });

  it("引号载荷：长串里大量 `?` / `&` 的 URL 形态判定不回溯", () => {
    expect(timed(`u: "https://x/${"?a".repeat(40_000)}"`).ms).toBeLessThan(1000);
    expect(timed(`u: "https://x/?${"a".repeat(80_000)}"`).ms).toBeLessThan(1000);
  });
});

describe("已知残留（本轮刻意不补，现状钉住；将来补了请同步改这里）", () => {
  it("纯标量的 YAML 列表项：`passwords:` 下的 `- value` 不继承", () => {
    // 括号版 `"passwords": ["…"]` 会报；YAML 版的标量列表项需要另一套规则（含「列表项与父键同缩进」的写法），
    // 本轮只补键值型子项
    expect(snippets(lines("passwords:", `  - ${PW}`))).toEqual([]);
  });
});
