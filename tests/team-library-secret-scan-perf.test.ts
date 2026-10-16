/**
 * 团队库密钥扫描：对抗性 / 超大输入下必须线性、不抛栈溢出
 *
 * 为什么要这组用例：`scanSensitiveFiles` 是纯同步函数，直接跑在 server 主线程上（上传 / 镜像推送前），
 * 而 `collectStagedTextFilesForScan` 对单文件大小没有任何上限。真实执行（5~160k 字符不等的对抗输入）实测到两类缺陷：
 *
 * 1. **二次方回溯**（单行 160k 字符就是十几 ~ 四十秒，事件循环整段被卡死）——全是同一个形态：
 *    「无锚点起点的 `X+$`」或「每个键起点都向后扫到行尾」：
 *    - `splitKeyWords` 里 `([A-Z]+)([A-Z][a-z])`：一长串大写字母做键名（`AAAA…=x`），每个起点都吃到串尾再回退；
 *    - `splitKeyWords` 里 `\d+$`：`a111…1b` 这种「长数字串 + 末尾字母」的键名，每个数字起点都吃到数字串尾、`$` 失败；
 *    - `isNonSecretLiteralValue` 里 `[)\]]+$`：`password: )))…)x`，同理；
 *    - `KEY_VALUE_PAIR_RE` 里 `\{\{[^}]*\}\}`：`a:{{ a:{{ …` 且全行没有 `}`，每个键起点的 `[^}]*` 都扫到行尾。
 * 2. **正则回溯栈溢出**（V8 抛 `RangeError: Maximum call stack size exceeded`，不是死循环、是直接抛出）：
 *    `{20,}` 这类带下界的计数量词、`(?:[^"\\]|\\.)*` 这类按字符迭代的交替循环，每次迭代都往回溯栈压一项，
 *    单个 token / 单个字符串值到约 8~16MB 就爆栈。异常一路冒出 `commitAndPush`，
 *    上传 / 镜像整个失败，**且 force 也救不了**（扫描照跑、照抛）。
 *
 * 时间上限放得很宽（修后都是毫秒级、上限 1000ms，留 100 倍以上余量）：目的是挡二次方，不是测性能基线。
 */
import { describe, expect, it } from "vitest";

import { scanSensitiveFiles } from "@/lib/server/team-library-secret-scan";

const MB = 1024 * 1024;

const scanOne = (content: string) =>
  scanSensitiveFiles([{ path: "skills/fe/demo/big.txt", content }]);

/** 跑一次扫描并返回 [命中, 耗时 ms]；扫描里抛的异常原样冒出（栈溢出用例要的就是「不抛」） */
const timed = (content: string) => {
  const t0 = performance.now();
  const hits = scanOne(content);
  return { hits, ms: performance.now() - t0 };
};

describe("对抗输入下的线性复杂度（单行、无锚点回溯的几种形态）", () => {
  // n 取「修前已经 > 2 秒、修后毫秒级」的量级；上限 1000ms
  it.each([
    ["超长大写字母键名（splitKeyWords 的 [A-Z]+ 回溯）", "A".repeat(40_000) + "=x"],
    ["长数字串收尾字母的键名（splitKeyWords 的 \\d+$ 回溯）", `a${"1".repeat(40_000)}b: v`],
    ["敏感键 + 超长右括号串（isNonSecretLiteralValue 的 [)\\]]+$ 回溯）", `password: ${")".repeat(40_000)}x`],
    ["敏感键 + 超长右方括号串", `password: ${"]".repeat(40_000)}x`],
    ["无 } 的 `{{` 模板片段（KEY_VALUE_PAIR_RE 的 {{[^}]*}} 向后扫到行尾）", "a:{{ ".repeat(20_000)],
    ["带空格的 `a: {{ x ` 重复（同上）", "a: {{ x ".repeat(12_500)],
  ])("%s", (_name, content) => {
    const { ms } = timed(content);
    expect(ms).toBeLessThan(1000);
  });

  it("修法不改语义：长键名的敏感度判定与修前一致（大写缩写 / 尾部序号 / 复数）", () => {
    // 这几个都依赖 splitKeyWords 的拆词结果：APIKey → api key、token2 → token、secrets → secret
    const snippets = (c: string) => scanOne(c).map((h) => h.snippet);
    expect(snippets("APIKey: RealApiKeyValue99")).toEqual(["APIKey=Rea***"]);
    expect(snippets("clientSecret2: RealSecretValue99")).toEqual(["clientSecret2=Rea***"]);
    expect(snippets("AWS_SECRET_ACCESS_KEY=RealSecretValue99")).toEqual([
      "AWS_SECRET_ACCESS_KEY=Rea***",
    ]);
    expect(snippets("XMLHttpRequestToken: RealTokenValue99")).toEqual([
      "XMLHttpRequestToken=Rea***",
    ]);
    // 右括号收尾的取值仍按「去掉调用语法右括号后」判开关（M2-10）
    expect(snippets("login(requirePassword=False)")).toEqual([]);
    expect(snippets("connect(password=RealPassw0rd99)")).toEqual(["password=Rea***"]);
  });
});

describe("超大单行不抛 RangeError（回溯栈溢出）", () => {
  it("单个超长 token 做取值（高熵赋值规则的 {20,}）：9MB 不抛、照样命中高熵", () => {
    // 取 12 种不同字符循环：高熵判定要求「字符多样性够」，`aB3aB3…` 这种纯重复本来就不算
    const { hits, ms } = timed(`SESSION_ID=${"aB3dE5fG7hI9".repeat((9 * MB) / 12)}`);
    expect(hits.map((h) => h.kind)).toEqual(["high-entropy"]);
    expect(ms).toBeLessThan(5000);
  });

  it.each([
    ["sk-", "sk-Ab12"],
    ["ghp_", "ghp_Ab12"],
    ["glpat-", "glpat-Ab12"],
    ["xox", "xoxb-Ab12"],
    ["Bearer", "Bearer Ab12"],
  ])("超长平台令牌形态（%s 的 {N,} 计数量词）：9MB 不抛、照样命中 known-token", (_name, prefix) => {
    const { hits, ms } = timed(`${prefix}${"Cd34".repeat(Math.ceil((9 * MB) / 4))}`);
    expect(hits.map((h) => h.kind)).toEqual(["known-token"]);
    expect(ms).toBeLessThan(5000);
  });

  it.each([
    ["双引号", '"'],
    ["单引号", "'"],
  ])("超长%s字符串值（按字符迭代的交替循环）：18MB 不抛", (_name, q) => {
    const { hits, ms } = timed(`{${q}x${q}:${q}${"a".repeat(18 * MB)}${q}}`);
    expect(hits).toEqual([]);
    expect(ms).toBeLessThan(5000);
  });

  it("超长字符串值之后的敏感键照样被找到（不是溢出后整行放弃）", () => {
    const hits = scanOne(`{"blob":"${"a".repeat(18 * MB)}","password":"RealPassw0rd99"}`);
    expect(hits.map((h) => h.snippet)).toEqual(["password=Rea***"]);
  });
});
