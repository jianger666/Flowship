/**
 * 团队库密钥扫描：H4-03（第六轮 review，第五轮 YAML 缩进继承引入的误报）
 *
 * 实测（修前）：`secrets:` 换行 `  backend: "aws-secrets-manager"` 报了 `secrets.backend=aws***`。
 * 原因：继承来的子值只排除「元数据」黑名单里的键名（path / name / type / provider …），`backend` 不在里面；
 * 引号值 + strong 父键（secrets / password …）只要 ≥ 6 位、无空白就算口令。配置性子键（backend / engine / driver / store …）
 * 的取值是产品名 / 引擎名，这个名单永远补不完。
 * 括号版（`{"secrets":{"backend":"aws-secrets-manager"}}`）走的是同一个 `emitMatch`，同样误报——两边口径一致，一起修。
 *
 * 修法：继承只对「语义上像凭据本体」的子键生效——键名最后一个词（经 `splitKeyWords` 归一）是 value / data / key / secret / token /
 * password / pass / pw / cred / content … 才继承；`backend` / `engine` / `driver` / `mode` / `mechanism` 这类配置性子键不继承。
 *
 * 钉四件事：
 *   A. 误报面：配置性子键（YAML / JSON / JS 对象，引号与否）不再报；
 *   B. 漏报面不退化：真凭据在 secrets / credentials / tokens / password 下的 value / data / key / db_pass / cache_pw … 仍报，
 *      同块里夹配置性子键时只报凭据那一行；
 *   C. 对照：子键自己敏感（`password:` 等）照旧只报一次；数组字面量继承（`secrets[]`）不受影响；
 *   D. 已知残留（取舍）：「名字 → 密文」型映射（`secrets:` 下 `smtp: <口令>`）的子键名不是凭据词，不再靠父键继承命中；
 *      **兜底的高熵规则只管「某个 `:` / `=` 之后连续 ≥ 20 个字符都在 `[A-Za-z0-9+/=_.~-]` 里」的值**（≥ 20 位还不够：含 `!` `@` `#` 等的口令，这类字符落在口令开头那 20 位内就无命中；
 *      口令内部若含 `=` / `:`，则从那个符号之后重新起算），
 *      16 位这类口令在这种映射写法下没有任何规则能命中（见 D 组注释里的核实结论与 `L4-07` 组的边界用例）。
 *
 * 所有口令都是无害的合成值；只断言「会命中 / 不命中」与脱敏后的 snippet。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const scanAs = (path: string, content: string) => scanSensitiveFiles([{ path, content }]);
const yaml = (content: string) => scanAs("skills/fe/demo/cfg.yaml", content);
const json = (content: string) => scanAs("skills/fe/demo/cfg.json", content);
const lines = (...ls: string[]): string => ls.join("\n");

/** 无害的合成口令（16 位字母 + 数字、不含任何占位词） */
const PW = "Zx9fQ2mK7pLw1234";

describe("A · 配置性子键不继承父键的敏感度（误报面）", () => {
  it.each([
    // 评审给的原始复现
    ["secrets 下的 backend（引号 kebab 名）", lines("secrets:", '  backend: "aws-secrets-manager"')],
    ["secrets 下的 backend（无引号、字母 + 数字）", lines("secrets:", "  backend: aws-sm-v2")],
    ["credentials 下的 backend", lines("credentials:", '  backend: "vault-kv-v2"')],
    ["tokens 下的 backend", lines("tokens:", "  backend: redis-cluster-01")],
    ["password 下的 backend", lines("password:", '  backend: "keychain-2024"')],
    // 同类配置性子键
    ["engine", lines("secrets:", '  engine: "hashicorp-vault-1"')],
    ["driver", lines("secrets:", "  driver: sqlcipher-v4-2")],
    ["store", lines("secrets:", '  store: "k8s-secret-store-2"')],
    ["storage", lines("tokens:", "  storage: redis-cluster-01")],
    ["source", lines("secrets:", '  source: "gitlab-vars-1"')],
    ["method", lines("credentials:", "  method: oauth2-client-1")],
    ["strategy", lines("credentials:", "  strategy: rotate-every-90d")],
    ["adapter", lines("secrets:", '  adapter: "aws-sm-adapter-2"')],
    ["namespace", lines("secrets:", "  namespace: team-alpha-prod-1")],
    ["manager", lines("secrets:", '  manager: "external-secrets-v2"')],
    ["vendor", lines("secrets:", "  vendor: hashicorp-ent-1")],
    // 弱敏感父键 auth：mechanism 的取值（SCRAM-SHA-256）字母 + 数字 + 够长，过去也被当成口令
    ["auth 下的 mechanism", lines("auth:", "  mechanism: SCRAM-SHA-256")],
    ["auth 下的 backend", lines("auth:", "  backend: ldap-directory-01")],
    // 已有豁免的元数据键（对照，防退化）
    ["provider", lines("secrets:", '  provider: "aws-secrets-manager"')],
    ["type", lines("secrets:", '  type: "opaque-secret-2"')],
    ["kind / mode / scheme", lines("secrets:", "  kind: ExternalSecret-v1", "  mode: readonly-mode-1", "  scheme: bearer-token-1")],
    // 同一块里多个配置性子键
    [
      "同块多个配置性子键 + 数字配置",
      lines("secrets:", '  backend: "aws-secrets-manager"', "  region: us-east-1", "  rotation_days: 90", "  enabled: true"),
    ],
    // 列表项里的父键
    ["列表项里的父键", lines("services:", "  - secrets:", '      backend: "aws-secrets-manager"')],
    // 缩进回退后不再继承
    ["缩进回退到上层后的普通键", lines("secrets:", "  region: us-east-1", `owner: ${PW}`)],
  ])("YAML：%s", (_name, content) => {
    expect(yaml(content), content).toEqual([]);
  });

  it.each([
    ["JSON 单行", '{"secrets":{"backend":"aws-secrets-manager"}}'],
    ["JSON 单行（kebab + 数字）", '{"secrets":{"backend":"aws-sm-v2"}}'],
    ["JSON 多行", lines("{", '  "secrets": {', '    "backend": "aws-secrets-manager",', '    "engine": "hashicorp-vault-1"', "  }", "}")],
    ["JSON auth.mechanism", '{"auth":{"mechanism":"SCRAM-SHA-256"}}'],
    ["JSON 数组里的对象", '{"secrets":[{"backend":"aws-secrets-manager"}]}'],
  ])("括号版同口径：%s", (_name, content) => {
    expect(json(content), content).toEqual([]);
  });

  it.each([
    ["JS 对象（无引号键）", 'const cfg = { secrets: { backend: "aws-secrets-manager" } };'],
    ["YAML 流式映射", 'secrets: {backend: "aws-secrets-manager"}'],
    ["py dict（单引号）", "cfg = {'secrets': {'backend': 'aws-secrets-manager'}}"],
  ])("其它语法同口径：%s", (_name, content) => {
    expect(json(content), content).toEqual([]);
  });
});

describe("B · 真凭据子键照旧继承（漏报面不退化）", () => {
  it.each([
    ["password.value", lines("password:", `  value: ${PW}`), [[2, "password.value=Zx9***"]]],
    ["secrets.value（YAML 引号值）", lines("secrets:", `  value: "${PW}"`), [[2, "secrets.value=Zx9***"]]],
    ["secret.data", lines("secret:", `  data: ${PW}`), [[2, "secret.data=Zx9***"]]],
    ["apiKey.key", lines("apiKey:", `  key: ${PW}`), [[2, "apiKey.key=Zx9***"]]],
    ["token.value", lines("token:", `  value: ${PW}`), [[2, "token.value=Zx9***"]]],
    ["credentials.value（弱敏感父键，值像口令）", lines("credentials:", `  value: ${PW}`), [[2, "credentials.value=Zx9***"]]],
    ["secrets.db_pass（pass 词）", lines("secrets:", `  db_pass: ${PW}`), [[2, "secrets.db_pass=Zx9***"]]],
    ["secrets.cache_pw（pw 词）", lines("secrets:", `  cache_pw: ${PW}`), [[2, "secrets.cache_pw=Zx9***"]]],
    ["secrets.admin_cred（cred 词）", lines("secrets:", `  admin_cred: ${PW}`), [[2, "secrets.admin_cred=Zx9***"]]],
    ["secrets.ssh_key（key 作末词）", lines("secrets:", `  ssh_key: ${PW}`), [[2, "secrets.ssh_key=Zx9***"]]],
    ["secrets.content", lines("secrets:", `  content: ${PW}`), [[2, "secrets.content=Zx9***"]]],
    ["secrets.encrypted_data（data 作末词）", lines("secrets:", `  encrypted_data: ${PW}`), [[2, "secrets.encrypted_data=Zx9***"]]],
    ["复数 values（归一后是 value）", lines("secrets:", `  values: ${PW}`), [[2, "secrets.values=Zx9***"]]],
    [
      "同块里夹配置性子键：只报凭据那一行",
      lines("secrets:", '  backend: "aws-secrets-manager"', `  value: ${PW}`, "  engine: hashicorp-vault-1"),
      [[3, "secrets.value=Zx9***"]],
    ],
    [
      "列表项里的父键 + 缩进继承",
      lines("accounts:", "  - password:", `      value: ${PW}`),
      [[3, "password.value=Zx9***"]],
    ],
  ] as Array<[string, string, Array<[number, string]>]>)("YAML：%s", (_name, content, expected) => {
    const hits = yaml(content);
    expect(hits.map((h) => [h.line, h.snippet]), content).toEqual(expected);
    expect(hits.every((h) => h.kind === "credential-key")).toBe(true);
    for (const h of hits) expect(h.snippet).not.toContain(PW.slice(3));
  });

  it.each([
    ["password.value", `{"password":{"value":"${PW}"}}`, ["password.value=Zx9***"]],
    ["secret.data", `{"secret":{"data":"${PW}"}}`, ["secret.data=Zx9***"]],
    ["apiKey.key", `{"apiKey":{"key":"${PW}"}}`, ["apiKey.key=Zx9***"]],
    ["secrets 数组里对象的 value", `{"secrets":[{"name":"db","value":"${PW}"}]}`, ["secrets.value=Zx9***"]],
    ["secrets.db_pass", `{"secrets":{"db_pass":"${PW}"}}`, ["secrets.db_pass=Zx9***"]],
    ["同对象里夹配置性子键", `{"secrets":{"backend":"aws-secrets-manager","value":"${PW}"}}`, ["secrets.value=Zx9***"]],
    ["yaml 流式映射", `password: {value: ${PW}}`, ["password.value=Zx9***"]],
  ])("括号版：%s", (_name, content, expected) => {
    expect(json(content).map((h) => h.snippet), content).toEqual(expected);
  });
});

describe("C · 对照", () => {
  it("子键自己敏感：照旧只报一次（不因继承重复），且不受白名单影响", () => {
    expect(yaml(lines("secrets:", `  password: ${PW}`)).map((h) => h.snippet)).toEqual(["password=Zx9***"]);
    expect(yaml(lines("secrets:", `  clientSecret: ${PW}`)).map((h) => h.snippet)).toEqual(["clientSecret=Zx9***"]);
    expect(yaml(lines("secrets:", `  api_key: ${PW}`)).map((h) => h.snippet)).toEqual(["api_key=Zx9***"]);
  });

  it("数组字面量继承（`secrets[]`）不走子键名白名单，照旧命中", () => {
    expect(json(`{"secrets": [ "${PW}", "x" ]}`).map((h) => h.snippet)).toEqual(["secrets[]=Zx9***"]);
  });

  it("元数据子键即便取值像口令也不继承（既有口径）", () => {
    expect(
      yaml(lines("password:", "  file: ~/.pw-store", "  username: deploy-2024-admin", `  name: ${PW}`, `  key_name: ${PW}`)),
    ).toEqual([]);
  });

  it("孙子层仍不继承（既有口径）", () => {
    expect(yaml(lines("secrets:", "  meta:", `    value: ${PW}`))).toEqual([]);
  });
});

describe("D · 已知残留（取舍，现状钉住；将来补了请同步改这里）", () => {
  it("「名字 → 密文」型映射：secrets 下的 `smtp: <口令>` 子键名不是凭据词，不再靠继承命中", () => {
    // 修前会报 `secrets.smtp=Zx9***`。取舍：配置性子键的取值（产品名 / 引擎名 / 机制名）满地都是、名单补不完，
    // 所以「子键名随便起 + 值是口令」的映射写法不再靠父键继承命中；改成真正的凭据键名（password / secret / token …）就能命中。
    //
    // ⚠️ 其它规则能兜住多少（第七轮 K4-06 核实；此前这里写的「值形态 / 高熵另有机会兜住」不成立，别再这么写）：
    //   - 高熵规则（team-library-secret-scan.ts 的 `HIGH_ENTROPY_ASSIGN_RE` 的 `{20}` + `looksHighEntropySecret` 的
    //     `length < 20`）要求某个 `:` / `=` 之后（容忍空白与一个引号）**连续 ≥ 20 个字符都在 `[A-Za-z0-9+/=_.~-]` 里**
    //     （另需 ≥2 类字符、多样性够、不是纯小写 slug、不是占位词）。口令开头那 20 位都在字符集内的映射口令
    //     （`secrets:\n  smtp: <口令>`）仍会以 `high-entropy` 命中
    //     （实测：20 位命中、19 位不命中；23 位含 `!` 的 `Zx9fQ2m!K7pLw1234AbCdEf` 无命中——「≥ 20 位仍命中」的说法过宽，
    //     边界与字符集用例见下面的 `L4-07` 组；第八轮复核订正）。
    //   - 本用例的 PW 只有 16 位：既不被继承命中、也过不了高熵的 20 位门槛 → **没有任何命中**。这就是残留，
    //     典型例子是 16 位以内的 SMTP / 数据库口令。
    //   - 「值形态」规则（KNOWN_TOKEN_RULES）只认平台令牌前缀（sk- / ghp_ / glpat- / xox / AKIA / Bearer），
    //     对普通口令不起作用。
    // 要把 < 20 位的映射口令也补回来，需要「值形态够像随机口令」这一层，本轮没做（记入残余）。
    expect(yaml(lines("secrets:", `  smtp: ${PW}`))).toEqual([]);
    expect(json(`{"secrets":{"smtp":"${PW}"}}`)).toEqual([]);
  });

  // 第八轮 L4-07：上面「≥ 20 位的映射口令仍会命中」说得不精确——命中还要求**某个 `:` / `=` 之后连续 ≥ 20 个字符都在
  // `[A-Za-z0-9+/=_.~-]`**（映射口令通常就是「开头那 20 位」；口令内部含 `=` / `:` 时的例外见下面「重新起算」用例）。
  // 真实规则（team-library-secret-scan.ts，本组用例逐条实测过）：
  //   1. `HIGH_ENTROPY_ASSIGN_RE`：在 `:` / `=` 之后（容忍空白与一个引号）要**连续 ≥ 20 个**字符集内的字符才匹配；
  //      取到的值 = 这一段字符集内字符的最长连续串（遇到第一个字符集之外的字符就停）。
  //   2. `looksHighEntropySecret(值)`：长度 ≥ 20、≥ 2 类字符、字符多样性够、不是纯小写 slug、不是占位词。
  //   所以：口令**前 20 位里**只要有字符集之外的字符（`!` `@` `#` `$` `%` `&` `*` 空格 …），整条就没有任何命中——
  //   23 位的 `Zx9fQ2m!K7pLw1234AbCdEf`（`!` 在第 8 位）无命中；`!` 落在第 21 位或更后面，前 20 位仍然全在字符集里，
  //   命中的是 `!` 之前那一段。含特殊符号的 SMTP / 数据库口令因此可能漏报（记入残余，本轮不改扫描逻辑）。
  //   例外（实测）：口令内部若含 `=` / `:`，正则会把它当新的起点——它之后若连续 ≥ 20 个字符集内字符，即便口令开头 20 位含 `!` 也命中，
  //   命中的值是该符号之后那一段（脱敏后以 `w12` 开头，不是整个口令）。
  describe("L4-07 · 高熵兜底的字符集条件：某个 `:` / `=` 之后连续 ≥ 20 个字符都在 [A-Za-z0-9+/=_.~-]", () => {
    const smtp = (value: string) => yaml(lines("secrets:", `  smtp: "${value}"`));
    const kinds = (value: string) => smtp(value).map((h) => `${h.kind}:${h.line}`);

    it("边界：20 位命中、19 位不命中（同一串去掉最后一位）", () => {
      const v20 = "Zx9fQ2mK7pLw1234AbCd";
      expect(v20).toHaveLength(20);
      expect(kinds(v20)).toEqual(["high-entropy:2"]);
      expect(kinds(v20.slice(0, 19))).toEqual([]);
      // 更长的纯字母数字照样命中；16 位（本组 PW）不命中
      expect(kinds(`${v20}EfG`)).toEqual(["high-entropy:2"]);
      expect(kinds(PW)).toEqual([]);
    });

    it("命中的 snippet 已脱敏（不含口令后半段）", () => {
      const v20 = "Zx9fQ2mK7pLw1234AbCd";
      const [hit] = smtp(v20);
      expect(hit?.snippet).not.toContain(v20.slice(6));
    });

    it("报告复现：23 位含 `!`（第 8 位）→ 无命中；同样 23 位但全是字符集内字符 → 命中", () => {
      const withBang = "Zx9fQ2m!K7pLw1234AbCdEf";
      expect(withBang).toHaveLength(23);
      expect(kinds(withBang)).toEqual([]);
      expect(kinds("Zx9fQ2mK7pLw1234AbCdEfG")).toEqual(["high-entropy:2"]);
    });

    it("`!` 的位置决定生死：第 20 位及更前 → 无命中；第 21 位起 → 命中（取 `!` 之前那一段）", () => {
      const base = "Zx9fQ2mK7pLw1234AbCdEfGh"; // 24 位字符集内
      const at = (idx: number) => `${base.slice(0, idx)}!${base.slice(idx + 1)}`; // 第 idx 位（从 0 起）换成 `!`
      expect(kinds(at(19))).toEqual([]); // 前 19 位 + `!`：连续段只有 19 位
      expect(kinds(at(20))).toEqual(["high-entropy:2"]); // 前 20 位完整
      expect(kinds(at(23))).toEqual(["high-entropy:2"]);
      expect(kinds(at(7))).toEqual([]);
    });

    it("字符集之外的符号（出现在前 20 位内）都让整条无命中", () => {
      for (const ch of ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")", ",", ";", "?", "<", ">", "{", "}", "|", "\\", " ", "`"]) {
        const v = `Zx9fQ2m${ch}K7pLw1234AbCdEf`;
        expect(kinds(v), JSON.stringify(ch)).toEqual([]);
      }
    });

    it("字符集之内的符号（+ / = _ . ~ -）不影响命中", () => {
      for (const ch of ["+", "/", "=", "_", ".", "~", "-"]) {
        const v = `Zx9fQ2m${ch}K7pLw1234AbCdEf`;
        expect(kinds(v), JSON.stringify(ch)).toEqual(["high-entropy:2"]);
      }
    });

    it("口令内部含 `=` / `:`：从那个符号之后重新起算——其后连续 ≥ 20 个字符集内字符仍命中（开头 20 位含 `!` 也不例外），19 个不命中", () => {
      const tail = "w1234AbCdEfGhIjKlMnOpQrS"; // 24 位字符集内
      for (const sep of ["=", ":"]) {
        const v = (n: number) => `Zx9fQ2m!K7pL${sep}${tail.slice(0, n)}`; // `!` 在开头 20 位内
        expect(kinds(v(19)), `${sep} 之后 19 位`).toEqual([]);
        expect(kinds(v(20)), `${sep} 之后 20 位`).toEqual(["high-entropy:2"]);
        expect(kinds(v(24)), `${sep} 之后 24 位`).toEqual(["high-entropy:2"]);
        // 取到的是符号之后那一段（脱敏后以 w12 开头），不是整个口令
        expect(smtp(v(20))[0]?.snippet, sep).toContain("w12");
        expect(smtp(v(20))[0]?.snippet, sep).not.toContain("Zx9");
      }
    });

    it("括号版（JSON）口径一致：同样 20 位命中 / 19 位不命中 / 前 20 位含 `!` 不命中", () => {
      const j = (v: string) => json(`{"secrets":{"smtp":"${v}"}}`).map((h) => h.kind);
      expect(j("Zx9fQ2mK7pLw1234AbCd")).toEqual(["high-entropy"]);
      expect(j("Zx9fQ2mK7pLw1234AbC")).toEqual([]);
      expect(j("Zx9fQ2m!K7pLw1234AbCdEf")).toEqual([]);
    });
  });
});
