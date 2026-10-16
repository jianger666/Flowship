/**
 * 团队库密钥扫描：嵌套结构里的敏感键（N8-03）
 *
 * 根因（读 diff + 对照 HEAD 实测）：现版逐对扫描的正则里，无引号取值分支 `[^\s,;}]*`
 * 会把「紧贴在键后面的 `{` / `[`」连同里面的内层键整个吞成外层键的值——
 * 例如 `{"config":{"accessToken":"…"}}` 里外层键 `config` 的值被吃成 `{"accessToken":"…"`，
 * 内层 `accessToken` 再也轮不到匹配（matchAll 不重叠）。后果：
 * - 单行嵌套 JSON（`{"a":{"b":{"password":"…"}}}`、数组里的对象、`{"config":{"accessToken":…}}`）整体漏报；
 * - **相对 HEAD 的回归**：HEAD 的行内搜索能命中的无引号键嵌套写法
 *   （`config: {password: x}`、`{db:{password:"x"}}`、`users: [{password: x}]`）现版漏了。
 *
 * 修法：值位置遇到「结构起始括号（后面紧跟键 / 另一层括号 / 行尾）」只消费括号本身、
 * 让扫描继续进到括号里面；字面量数组 `["abc…"]`、`[REDACTED]` 这类仍按整体值判。
 *
 * 本文件只补嵌套相关用例；camelCase / 一行多键 / 误报面的存量用例在 tests/team-library.test.ts。
 *
 * 第四轮（M2-01）：上面「只吃开括号」的修法让外层敏感键的敏感度丢了——
 * `{"password":{"value":"…"}}` 里内层键 `value` 自己不敏感、外层 `password` 又只剩一个 `{`，整体漏报。
 * 修法：敏感键后紧跟的 `{` / `[` 记下「父键敏感」，让紧邻的子键值对 / 数组里的字符串字面量继承敏感度，
 * 括号闭合即失效（跨行、字符串里的括号 / 转义引号都要对）。本文件末尾两个 describe 覆盖。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const scan = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/cfg.json", content }]);
const snippets = (content: string): string[] =>
  scan(content).map((h) => h.snippet);

describe("嵌套结构里的敏感键必须命中（N8-03）", () => {
  it.each([
    ["多层嵌套对象", '{"a":{"b":{"password":"RealPassw0rd99"}}}', ["password=Rea***"]],
    ["数组里的对象", '{"users":[{"password":"RealPassw0rd99"}]}', ["password=Rea***"]],
    [
      "config.accessToken（camelCase + 嵌套）",
      '{"config":{"accessToken":"RealTokenValue99"}}',
      ["accessToken=Rea***"],
    ],
    [
      "嵌套前后各有同级键",
      '{"name":"x","config":{"accessToken":"RealTokenValue99"},"id":1}',
      ["accessToken=Rea***"],
    ],
    [
      "内层多个敏感键逐个报",
      '{"a":{"user":"u","password":"RealPassw0rd99","accessToken":"RealTokenValue99","note":"ok"}}',
      ["password=Rea***", "accessToken=Rea***"],
    ],
    [
      "内层 + 外层同级各一个",
      '{"db":{"password":"RealPassw0rd99"},"apiKey":"RealKeyValue99"}',
      ["password=Rea***", "apiKey=Rea***"],
    ],
    ["数组套数组", '[[{"secret":"RealSecretVal99"}]]', ["secret=Rea***"]],
    [
      "对象数组里第二个元素",
      '{"a":[{"b":"c"},{"password":"RealPassw0rd99"}]}',
      ["password=Rea***"],
    ],
    [
      "嵌套里的 auth.clientSecret（弱 + 强键并存）",
      '{"meta":{"id":1},"auth":{"clientSecret":"RealSecretValue99"}}',
      ["clientSecret=Rea***"],
    ],
    [
      "内层键前有空格",
      '{ "config": { "accessToken": "RealTokenValue99" } }',
      ["accessToken=Rea***"],
    ],
  ])("%s", (_name, line, expected) => {
    const hits = scan(line);
    expect(hits.map((h) => h.snippet), line).toEqual(expected);
    // 绝不回传完整密文
    for (const h of hits) expect(h.snippet).not.toMatch(/Real[A-Za-z]+\d{2}/);
  });

  it("跨行缩进 JSON：每个内层敏感键报在它自己的行号上", () => {
    const hits = scan(
      [
        "{",
        '  "db": {',
        '    "host": "db1",',
        '    "password": "RealPassw0rd99"',
        "  },",
        '  "providers": [',
        "    {",
        '      "accessToken": "RealTokenValue99"',
        "    }",
        "  ]",
        "}",
      ].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.snippet])).toEqual([
      [4, "password=Rea***"],
      [8, "accessToken=Rea***"],
    ]);
  });

  // 相对 HEAD 的回归：HEAD 的行内搜索能命中，现版（修前）漏了
  it.each([
    ["yaml 流式映射、键后紧贴 {", "config: {password: RealPassw0rd99}"],
    ["js 对象紧凑嵌套（无引号键）", '{db:{password:"RealPassw0rd99"}}'],
    ["数组里的无引号键对象", "users: [{password: RealPassw0rd99}]"],
    ["env 行里内嵌对象", "x=1;config={password:RealPassw0rd99}"],
    ["py dict 紧凑嵌套（单引号键）", "cfg = {'db':{'password':'RealPassw0rd99'}}"],
  ])("HEAD 能命中的写法不退化：%s", (_name, line) => {
    expect(snippets(line), line).toEqual(["password=Rea***"]);
  });

  it("不退化：上一轮补的一行多键 / camelCase / 字面量数组 仍然命中", () => {
    expect(snippets('{"name":"x","apiKey":"RealKeyValue99","id":1}')).toEqual([
      "apiKey=Rea***",
    ]);
    expect(snippets("  clientSecret: RealSecretValue99")).toEqual([
      "clientSecret=Rea***",
    ]);
    // 字面量数组（值以 [" 开头）仍按整体值判，不被「结构括号」逻辑吞掉
    expect(snippets('"tokens": ["RealTokenValue99"]')).toEqual(['tokens=["R***']);
    // 同级键夹在嵌套对象后面
    expect(snippets('{"a":{"b":1},"password":"RealPassw0rd99"}')).toEqual([
      "password=Rea***",
    ]);
  });
});

describe("嵌套结构的误报面（别把普通配置都当密钥）", () => {
  it.each([
    ["内层是环境变量引用", '{"a":{"b":{"password":"${DB_PASSWORD}"}}}'],
    ["内层是模板插值", '{"a":{"password":"{{ secrets.DB }}"}}'],
    ["内层是占位符", '{"a":{"apiKey":"your-api-key","token":"<token>"}}'],
    ["内层空值", '{"db":{"password":""}}'],
    ["token 计数 / 过期配置", '{"config":{"max_tokens":4096,"token_ttl":3600}}'],
    ["schema 类型标注", '{"schema":{"password":"string","token":"string"}}'],
    ["弱敏感键值不像口令", '{"auth":{"type":"basic"},"credential":{"kind":"none"}}'],
    ["tokenizer 不是 token", '{"tokenizer":{"model":"bert-base-cased"}}'],
    ["键名指向路径 / 名称", '{"a":{"secretName":"my-app-secret-store","token_file":"~/.tok"}}'],
    ["敏感词键名下只是结构", '{"password_policy":{"min_length":8},"secrets":{"enabled":true}}'],
    ["过期时间 / 开关", '{"token":{"expires":3600,"enabled":true}}'],
    ["yaml 流式映射里的变量引用", "config: {password: ${DB_PASS}}"],
    ["yaml 流式映射里的占位符", "config: {token: <token>, secret: xxx}"],
    ["普通花括号文本", "see the config: {docs} and list: [a, b]"],
    ["字符串内容里的 `token: x` 不是键值对", '{"note":{"text":"set token: RealTokenValue99 later"}}'],
  ])("%s", (_name, line) => {
    expect(scan(line), line).toEqual([]);
  });

  it("嵌套 JSON 里的普通长字符串 / 哈希不因此多报", () => {
    expect(
      scan(
        '{"build":{"commit":"deadbeefdeadbeefdeadbeefdeadbeef","sha256":"abcdef0123456789abcdef0123456789ab","name":"fe-ai-flow"}}',
      ),
    ).toEqual([]);
  });
});

describe("敏感键下挂对象 / 数组：子值继承敏感度（M2-01）", () => {
  // 审查者实证的 5 种漏报写法（修前全部漏过扫描）
  it.each([
    ["password.value", '{"password":{"value":"RealPassw0rd99"}}', ["password.value=Rea***"]],
    ["secret.data", '{"secret":{"data":"RealSecretVal99"}}', ["secret.data=Rea***"]],
    ["apiKey.key", '{"apiKey":{"key":"RealKeyValue99"}}', ["apiKey.key=Rea***"]],
    ["token.value", '{"token":{"value":"RealTokenValue99"}}', ["token.value=Rea***"]],
    [
      "多行嵌套的 password",
      ['{', '  "password": {', '    "value": "RealPassw0rd99"', "  }", "}"].join("\n"),
      ["password.value=Rea***"],
    ],
  ])("漏报修复：%s", (_name, content, expected) => {
    const hits = scan(content);
    expect(hits.map((h) => h.snippet), content).toEqual(expected);
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
    // 绝不回传完整密文
    for (const h of hits) expect(h.snippet).not.toMatch(/Real[A-Za-z]+\d{2}/);
  });

  it("对照：扁平写法与内层键本身敏感的写法仍命中（且只报一次，不因继承重复）", () => {
    expect(snippets('{"password":"RealPassw0rd99"}')).toEqual(["password=Rea***"]);
    expect(snippets('{"secret":{"password":"RealPassw0rd99"}}')).toEqual(["password=Rea***"]);
    expect(snippets('{"auth":{"clientSecret":"RealSecretValue99"}}')).toEqual([
      "clientSecret=Rea***",
    ]);
  });

  it("多行：报在子键自己的行号上；括号闭合后同级普通键不再继承", () => {
    const hits = scan(
      [
        "{",
        '  "name": "RealLookingValue11",',
        '  "password": {',
        '    "value": "RealPassw0rd99"',
        "  },",
        '  "owner": "RealLookingValue22",',
        '  "secret": {',
        '    "data": "RealSecretVal99"',
        "  },",
        '  "region": "RealLookingValue33"',
        "}",
      ].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.snippet])).toEqual([
      [4, "password.value=Rea***"],
      [8, "secret.data=Rea***"],
    ]);
  });

  it("多行数组：字符串字面量元素继承父键敏感度，逐行报", () => {
    const hits = scan(
      [
        "{",
        '  "passwords": [',
        '    "RealPassw0rd99",',
        '    "Another99Passw",',
        '    "${DB_PASSWORD}"',
        "  ],",
        '  "names": [',
        '    "RealLookingValue11"',
        "  ]",
        "}",
      ].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.snippet])).toEqual([
      [3, "passwords[]=Rea***"],
      [4, "passwords[]=Ano***"],
    ]);
  });

  it("同一行内的数组：`[` 后带空格 / 嵌套数组 / 数组里的对象都继承", () => {
    expect(snippets('{"secrets": [ "RealSecretVal99", "x" ]}')).toEqual(["secrets[]=Rea***"]);
    // 数组套数组：数组层对继承是「透明」的（元素才是紧邻的子值）
    expect(snippets('{"secrets":[["RealSecretVal99"]]}')).toEqual(["secrets[]=Rea***"]);
    expect(
      snippets('{"secrets":[{"name":"db","value":"RealSecretVal99"}]}'),
    ).toEqual(["secrets.value=Rea***"]);
    expect(
      scan(
        [
          '{"secrets": [',
          '  {"name": "db", "value": "RealSecretVal99"},',
          '  {"name": "cache", "value": "AnotherSecret88"}',
          "]}",
        ].join("\n"),
      ).map((h) => [h.line, h.snippet]),
    ).toEqual([
      [2, "secrets.value=Rea***"],
      [3, "secrets.value=Ano***"],
    ]);
  });

  it("其它语法：yaml 流式映射 / py 字典（单引号）/ 无引号键", () => {
    expect(snippets("password: {value: RealPassw0rd99}")).toEqual(["password.value=Rea***"]);
    expect(snippets("cfg = {'password': {'value': 'RealPassw0rd99'}}")).toEqual([
      "password.value=Rea***",
    ]);
    expect(snippets('{secret:{data:"RealSecretVal99"}}')).toEqual(["secret.data=Rea***"]);
  });

  it("括号深度跟踪：字符串里的括号 / 转义引号不会让继承提前失效或泄漏到外面", () => {
    // 字符串里的 `}`：若误当作闭括号，`value` 就失去继承（漏报）
    expect(
      snippets('{"password":{"hint":"a}b","value":"RealPassw0rd99"},"other":"RealLookingValue11"}'),
    ).toEqual(["password.value=Rea***"]);
    // 字符串里的 `{`：若误当作开括号，闭合后 `other` 仍在 password 帧里（误报）
    expect(
      snippets('{"password":{"hint":"{","value":"RealPassw0rd99"},"other":"RealLookingValue11"}'),
    ).toEqual(["password.value=Rea***"]);
    // 转义引号：`\"}\"` 整个都在字符串里
    expect(
      snippets(
        '{"password":{"hint":"say \\"}\\" ok","value":"RealPassw0rd99"},"other":"RealLookingValue11"}',
      ),
    ).toEqual(["password.value=Rea***"]);
    // 单引号字符串里的括号同理
    expect(
      snippets("{'password': {'hint': '}', 'value': 'RealPassw0rd99'}, 'other': 'RealLookingValue11'}"),
    ).toEqual(["password.value=Rea***"]);
  });

  it("js 对象字面量（无引号键、单引号值）多行：报在子键自己的行上", () => {
    const hits = scan(
      ["module.exports = {", "  password: {", "    value: 'RealPassw0rd99'", "  }", "}"].join("\n"),
    );
    expect(hits.map((h) => [h.line, h.snippet])).toEqual([[3, "password.value=Rea***"]]);
  });

  it("单引号包裹的 JSON（shell `-d '{…}'` / JS 字符串里的 JSON）里的嵌套继承照常生效", () => {
    expect(
      snippets(`curl -X POST -d '{"password":{"value":"RealPassw0rd99"}}' https://x.example.com`),
    ).toEqual(["password.value=Rea***"]);
    expect(snippets(`echo '{"a":{"secret":{"data":"RealSecretVal99"}}}' > cfg.json`)).toEqual([
      "secret.data=Rea***",
    ]);
    // 包裹引号收尾后，同一行后面的普通键值不继承
    expect(
      snippets(`curl -d '{"password":{"value":"RealPassw0rd99"}}' -H 'X-Trace: RealLookingValue11'`),
    ).toEqual(["password.value=Rea***"]);
  });

  it("英文撇号（don't）不会被当成字符串起点而吞掉后面的括号", () => {
    expect(snippets("don't forget, password: {value: RealPassw0rd99}")).toEqual([
      "password.value=Rea***",
    ]);
  });

  it("只继承紧邻的下一层：孙子键不继承（避免 tokens / secrets 下挂大对象时误报爆炸）", () => {
    expect(
      scan('{"secrets":{"meta":{"owner":"team-alpha-2024-x","label":"RealLookingValue11"}}}'),
    ).toEqual([]);
    // 但孙子键自己敏感仍命中
    expect(snippets('{"secrets":{"meta":{"password":"RealPassw0rd99"}}}')).toEqual([
      "password=Rea***",
    ]);
  });

  it("孤立 / 错配的闭括号不会弄坏后续跟踪；跨文件互不影响", () => {
    // 行首多余的 `}`、`]` 忽略；之后的继承仍正确
    expect(snippets('}]\n{"password":{"value":"RealPassw0rd99"}}')).toEqual([
      "password.value=Rea***",
    ]);
    // 文件 A 里没闭合的 `password: {`，不能让文件 B 的普通键继承
    const hits = scanSensitiveFiles([
      { path: "a.json", content: '{"password": {' },
      { path: "b.json", content: '{"owner": "RealLookingValue11"}' },
    ]);
    expect(hits).toEqual([]);
  });

  it("非 JSON 文本里的括号不平衡：不会无限增长 / 不抛错（过深后放弃跟踪）", () => {
    const deep = "{".repeat(5000);
    expect(() => scan(`${deep}\n{"password":{"value":"RealPassw0rd99"}}`)).not.toThrow();
  });

  it("整文件线性：上万行嵌套 JSON 扫描耗时不随命中数二次增长", () => {
    const lines: string[] = ["{"];
    const N = 30000;
    for (let i = 0; i < N; i++) {
      lines.push(`  "svc${i}": {`, `    "password": {`, `      "value": "RealPassw0rd${i}"`, "    }", i === N - 1 ? "  }" : "  },");
    }
    lines.push("}");
    const t0 = performance.now();
    const hits = scan(lines.join("\n"));
    const ms = performance.now() - t0;
    expect(hits).toHaveLength(N);
    // 线性实现约零点几秒；若退回「每行对整个 hits 数组 some 全扫」（O(行数 × 命中数)，这里约 20 亿次比较，
    // 实测要好几秒）或括号栈每行重扫整个文件，会明显超出这个上限
    expect(ms).toBeLessThan(2500);
  });
});

describe("继承敏感度的子值仍走同一套值过滤（M2-01 误报面）", () => {
  it.each([
    ["环境变量引用", '{"password":{"value":"${DB_PASSWORD}"}}'],
    ["模板插值", '{"password":{"value":"{{ secrets.DB }}"}}'],
    ["占位符", '{"password":{"value":"<password>","alt":"your-password"}}'],
    ["空值", '{"password":{"value":""}}'],
    ["布尔 / null", '{"password":{"value":false,"alt":null}}'],
    ["process.env", '{"secret":{"data":"process.env.DB_SECRET"}}'],
    ["token 计数 / 过期", '{"token":{"value":3600,"expires":3600,"enabled":true}}'],
    ["弱敏感键值不像口令", '{"auth":{"mode":"basic","value":"none"}}'],
    ["键名指向路径 / 名称 / 开关（元数据键不继承）", '{"password":{"file":"~/.pw-store","name":"db-password-1","enabled":true,"min_length":8}}'],
    ["身份 / 说明类键不继承", '{"secret":{"username":"deploy-2024-admin","description":"Real secret store 2024"}}'],
    ["裸数字（计数 / 版本）", '{"password":{"retries":3,"version":2}}'],
    ["说明文字（带空白）", '{"password":{"policy_text":"must contain digits 123456"}}'],
    ["太短", '{"password":{"hint":"dog"}}'],
    ["k8s 引用：secretKeyRef 是引用不是密文", '{"secretKeyRef":{"name":"db-credentials","key":"db-password"}}'],
    ["design tokens（CSS 颜色 / 尺寸）", '{"tokens":{"primary":"#1890ff","radius":"6px","gap":"8px"}}'],
    ["token 值不像令牌（纯字母）", '{"token":{"kind":"bearer-only"}}'],
  ])("%s", (_name, content) => {
    expect(scan(content), content).toEqual([]);
  });

  it("仓库自扫实测过的误报：箭头函数体 / TS 类型别名 / 代码表达式取值", () => {
    // 返回类型名 `UseApiKeyInfoResult` 含 api / key，`=> {` 不能把整个函数体当成它的子值
    const arrow = [
      "export const useApiKeyInfo = (): UseApiKeyInfoResult => {",
      "  const abortRef = useRef<AbortController | null>(null);",
      "  const fetchInfo = useCallback(async () => {",
      "    abortRef.current?.abort();",
      "  }, []);",
      "};",
    ].join("\n");
    // 第 1 行本身的 `useApiKeyInfo = ():` 是存量行为（自己敏感的键 + 非占位值），只看后面的行
    expect(scan(arrow).filter((h) => h.line > 1)).toEqual([]);
    // PascalCase 无引号键 = 类型 / 类名：成员声明不是密文
    expect(
      scan(
        ["type ApiKeyInfo = {", "  abortRef: AbortController;", "  retryDelay: ExponentialBackoff;", "};"].join("\n"),
      ),
    ).toEqual([]);
    // shiki 的 `tokens: [[{ content: expr }]]`：父键 tokens、子值是代码表达式
    expect(
      scan("let ui = { tokens: [[{ content: fullCode.slice(0, 260), offset: 0 }]] };"),
    ).toEqual([]);
    expect(
      scan(["const ui = {", "  tokens: [", "    [{ content: realistic.slice(0, 260) }]", "  ]", "};"].join("\n")),
    ).toEqual([]);
    // 无引号的纯标识符（不含数字）不报
    expect(scan("secret: { value: secretValue }")).toEqual([]);
  });

  it("上一轮的误报面用例不退化（敏感词键名下只是结构）", () => {
    expect(scan('{"password_policy":{"min_length":8},"secrets":{"enabled":true}}')).toEqual([]);
    expect(scan('{"token":{"expires":3600,"enabled":true}}')).toEqual([]);
  });
});
