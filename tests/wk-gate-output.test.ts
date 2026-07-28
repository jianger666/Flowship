/**
 * 门禁脚本输出 → 事件流那条文案
 *
 * 用户看到的是这条文案（事件流 / postCheck 红条），所以要保证：
 * 英文结论行剥掉 `FAIL:` 前缀、明细逐条列、条数超上限折成「还有 N 条」、
 * 脚本崩了（traceback 没有 FAIL/`- ` 结构）也不能把线索吞掉。
 *
 * **只排版、不改写**（2026-07-28 用户拍板「不翻译，团队规范怎么返回就怎么展示」）：
 * 不按根因换成中文说法、不替脚本补「下一步」建议。
 */
import { describe, expect, it } from "vitest";

import { formatWkGateFailure, parseWkGateOutput } from "@/lib/wk-gate-output";

const REAL_FAIL = `FAIL: wk:repo-execute hard gate failed
- wk:repo-execute requires repo_status REPO_DESIGN_READY
- tasks.md: missing marker \`## Execution Plan\`
`;

describe("parseWkGateOutput", () => {
  it("拆出结论行 + 明细", () => {
    expect(parseWkGateOutput(REAL_FAIL)).toEqual({
      headline: "wk:repo-execute hard gate failed",
      items: [
        "wk:repo-execute requires repo_status REPO_DESIGN_READY",
        "tasks.md: missing marker `## Execution Plan`",
      ],
      omitted: 0,
      structured: true,
    });
  });

  it("PASS 行也当结论行剥（同一套格式）", () => {
    expect(parseWkGateOutput("PASS: wk:repo-design hard gate passed\n").headline).toBe(
      "wk:repo-design hard gate passed",
    );
  });

  it("只认第一条结论行——baseline 子进程会再打一条", () => {
    const nested = `FAIL: wk:repo-design delivery baseline failed
- FAIL: artifact newer on hub
`;
    const parsed = parseWkGateOutput(nested);
    expect(parsed.headline).toBe("wk:repo-design delivery baseline failed");
    expect(parsed.items).toEqual(["FAIL: artifact newer on hub"]);
  });

  // 去噪≠改写：这两下只动格式和重复，一个字的语义都没碰
  it("剥掉父脚本多加的一层 `- `、完全重复的行只留一条", () => {
    const nested = [
      "FAIL: wk:biz-analyze delivery baseline failed",
      "- - status.yaml: local file has unsynced changes",
      "- - status.yaml: local file has unsynced changes",
      "- - tasks.md: pulled hash mismatch local=a remote=b",
    ].join("\n");
    expect(parseWkGateOutput(nested).items).toEqual([
      "status.yaml: local file has unsynced changes",
      "tasks.md: pulled hash mismatch local=a remote=b",
    ]);
  });

  it("明细超 20 条 → 截断并记 omitted", () => {
    const many = [
      "FAIL: repo-execute quality gate failed for /x",
      ...Array.from({ length: 24 }, (_, i) => `- item ${i}`),
    ].join("\n");
    const parsed = parseWkGateOutput(many);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.omitted).toBe(4);
  });

  it("超长单条截到 240 字（traceback 里的绝对路径 + 行号就有 180 字）", () => {
    const long = `FAIL: x\n- ${"a".repeat(400)}`;
    const [item] = parseWkGateOutput(long).items;
    expect(item).toHaveLength(240);
    expect(item!.endsWith("…")).toBe(true);
  });

  it("python traceback（没有 FAIL / `- ` 结构）→ 原样当明细，别把线索吞了", () => {
    const traceback =
      'Traceback (most recent call last):\n  File "x.py", line 1\nModuleNotFoundError: No module named \'gates\'\n';
    const parsed = parseWkGateOutput(traceback);
    expect(parsed.headline).toBe("");
    expect(parsed.items[0]).toContain("Traceback");
    expect(parsed.items.at(-1)).toContain("ModuleNotFoundError");
  });
});

// structured 是「这坨输出到底是不是门禁结论」的唯一判据：
// wk-gate 拿它决定「非 0 退出」该硬拦还是当工具故障放行，判错任一侧都有人受伤。
describe("structured：门禁结论 vs 工具自身故障", () => {
  it("有 FAIL: 结论行 / 有 `- ` 明细行 → 都算门禁结论", () => {
    expect(parseWkGateOutput(REAL_FAIL).structured).toBe(true);
    expect(parseWkGateOutput("PASS: biz-analyze quality gate passed\n").structured).toBe(true);
    // 结论行被截断、只剩明细的场景（管道中断）也得认
    expect(parseWkGateOutput("- status.yaml: expected `repo_status: X`\n").structured).toBe(true);
  });

  it("traceback / argparse 报错 / 空输出 → 不是门禁结论", () => {
    expect(
      parseWkGateOutput(
        'Traceback (most recent call last):\n  File "x.py", line 20\nKeyError: \'repo-execute\'\n',
      ).structured,
    ).toBe(false);
    // argparse 的 usage 行会换行缩进，但一行都不以 `- ` 开头
    expect(
      parseWkGateOutput(
        "usage: doc-quality-gate.py [-h] [--stage {repo-execute}]\n" +
          "                          [--command {wk:repo-execute}]\n" +
          "doc-quality-gate.py: error: argument --command: invalid choice: 'wk:repo-exec'\n",
      ).structured,
    ).toBe(false);
    expect(parseWkGateOutput("").structured).toBe(false);
  });
});

describe("formatWkGateFailure", () => {
  it("语境前缀 + 结论 + 明细，去掉 FAIL: 噪声", () => {
    const text = formatWkGateFailure("wk:repo-execute 执行前门禁未过", REAL_FAIL);
    expect(text).toBe(
      [
        "wk:repo-execute 执行前门禁未过：wk:repo-execute hard gate failed",
        "- wk:repo-execute requires repo_status REPO_DESIGN_READY",
        "- tasks.md: missing marker `## Execution Plan`",
      ].join("\n"),
    );
    expect(text).not.toContain("FAIL:");
  });

  it("没结论行时只留前缀 + 明细", () => {
    expect(
      formatWkGateFailure("Delivery Hub 同步失败", "- Connection refused"),
    ).toBe("Delivery Hub 同步失败\n- Connection refused");
  });

  it("截断时补一行「还有 N 条」（明说截了，不是偷偷丢）", () => {
    const many = [
      "FAIL: gate failed",
      ...Array.from({ length: 22 }, (_, i) => `- item ${i}`),
    ].join("\n");
    expect(formatWkGateFailure("阶段门禁未过", many)).toContain("还有 2 条");
  });

  // 用户拍板「不翻译，团队规范怎么返回就怎么展示」——我们编的「下一步：…」全下线
  it("不替脚本补「下一步」建议", () => {
    expect(formatWkGateFailure("wk:repo-execute 执行前门禁未过", REAL_FAIL))
      .not.toContain("下一步");
  });
});

/**
 * 「从 Delivery Hub 拉 baseline」失败：**原样透传**。
 *
 * 下面三坨输入都是 2026-07-28 拿真脚本实跑抓下来的（临时 HOME + 假 hub，
 * 没碰用户真实的 ~/.wk/config.yaml）。曾经按根因把它们改写成中文
 * （「Delivery Hub 连不上 / 检查网络或 VPN」之类），用户拍板撤掉：团队脚本的输出
 * 才是权威的，改写有失真风险，同事之间还要对着同一段错误信息沟通。
 * 这一组用例就是防止「好心翻译」再长回来。
 */
const TITLE = "wk:biz-analyze 执行前门禁未过";

/** ① Hub 不通：官方 baseline 脚本在 URLError 分支漏了 `conflicts` 键、直接 KeyError 崩了 */
const BASELINE_UNREACHABLE = `FAIL: wk:biz-analyze delivery baseline failed
- Traceback (most recent call last):
-   File "/x/wk-harness/scripts/wk-delivery-baseline.py", line 657, in <module>
-     sys.exit(main())
-              ~~~~^^
-   File "/x/wk-harness/scripts/wk-delivery-baseline.py", line 650, in main
-     return check_baseline(args)
-   File "/x/wk-harness/scripts/wk-delivery-baseline.py", line 475, in check_baseline
-     if result["conflicts"]:
-        ~~~~~~^^^^^^^^^^^^^
- KeyError: 'conflicts'
`;

/** ② require_baseline 为真但没有 base_url（同事手写的半截配置 / 环境变量开了 require） */
const BASELINE_NO_URL = `FAIL: wk:biz-analyze delivery baseline failed
- FAIL: delivery hub URL missing; set --hub-url or delivery_hub.base_url
`;

/** ③ Hub 活着、本地产物跟它对不上——注意子脚本的明细被父脚本又加了一层 `- ` */
const BASELINE_STALE = `FAIL: wk:biz-analyze delivery baseline failed
- FAIL: local WK artifacts are stale or could not be verified against delivery hub
- - prd-review.md: pulled hash mismatch local=c18243bc remote=deadbeef
- - status.yaml: local file has unsynced changes; remote baseline saved to /d/status.yaml.baseline
- - status.yaml: local file has unsynced changes; remote baseline saved to /d/status.yaml.baseline
`;

describe("baseline 失败：原样展示脚本返回", () => {
  it("Hub 不通：traceback 原样端出来——KeyError 是团队脚本自己的 bug，露出来才好修", () => {
    const text = formatWkGateFailure(TITLE, BASELINE_UNREACHABLE);
    expect(text.split("\n")[0]).toBe(
      `${TITLE}：wk:biz-analyze delivery baseline failed`,
    );
    // 整段 traceback 一行不少（10 行、都在 20 条上限内），最后那句异常尤其得在——
    // 它是团队拿去定位自己那个 bug 的关键
    expect(text).toContain("- Traceback (most recent call last):");
    expect(text).toContain("line 475, in check_baseline");
    expect(text).toContain("- KeyError: 'conflicts'");
    expect(text).not.toContain("还有");
    // 调用栈的缩进也留着（`-   File …`），不然读不出层级
    expect(text).toContain(
      '-   File "/x/wk-harness/scripts/wk-delivery-baseline.py"',
    );
    // 一个字的中文解释 / 建议都不许加
    expect(text).not.toContain("连不上");
    expect(text).not.toContain("VPN");
    expect(text).not.toContain("下一步");
  });

  it("没配地址：把脚本那句 delivery hub URL missing 原样端出来", () => {
    const text = formatWkGateFailure(TITLE, BASELINE_NO_URL);
    expect(text).toContain(
      "- FAIL: delivery hub URL missing; set --hub-url or delivery_hub.base_url",
    );
    expect(text).not.toContain("设置页");
    expect(text).not.toContain("下一步");
  });

  it("产物对不上：明细原样，但去掉重复行和父脚本多加的那层 `- `", () => {
    const text = formatWkGateFailure(TITLE, BASELINE_STALE);
    // 子脚本自己那行英文结论也是脚本说的话，留着
    expect(text).toContain(
      "- FAIL: local WK artifacts are stale or could not be verified against delivery hub",
    );
    expect(text).toContain("- prd-review.md: pulled hash mismatch");
    // 去噪（不是改写）：重复 8 遍的 status.yaml 只留一条、嵌套的 `- - ` 剥成一层
    expect(text.match(/local file has unsynced changes/g)).toHaveLength(1);
    expect(text).not.toContain("- - ");
    expect(text).not.toContain("对不上");
  });
});
