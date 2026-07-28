/**
 * wk 门禁脚本输出 → 事件流那条文案（纯函数、无 node 依赖，client / server / 测试通用）
 *
 * 官方脚本（`doc-quality-gate.py`）的输出形态固定：
 *   PASS: wk:repo-design hard gate passed
 *   FAIL: repo-execute quality gate failed for /abs/path
 *   - tasks.md: missing marker `## Execution Plan`
 *   - status.yaml: expected `repo_status: REPO_DESIGN_READY`
 *
 * 直接把 stdout+stderr 一坨塞进事件流没法看（条目可能几十条），所以这里拆成
 * 「结论行 + 有限条明细」、超出的折成「还有 N 条」。
 *
 * ⚠️ **只排版、不改写**（2026-07-28 用户拍板「不翻译，团队规范怎么返回就怎么展示」）：
 * 团队脚本的输出是权威的，我们替它解释根因 / 给「下一步」建议既有失真风险，
 * 也让同事之间没法对着同一段错误信息沟通。这里允许做的只有三件事——
 * 剥 `FAIL:` / `PASS:` 前缀当结论、限量截断、去掉重复行与嵌套 `- ` 前缀。
 */

/**
 * 明细最多展示几条——再多就是刷屏、用户该去看 WK 产出目录里的原文了。
 *
 * 20 而不是原来的 8：脚本挂掉时吐的是完整 python traceback（这个场景 10 行），
 * 8 条正好把最后那句 `KeyError: 'conflicts'`（整段 traceback 里最有用的一行）截没了，
 * 跟「原样展示脚本返回」直接打架。截断规则本身保留、只是把 N 放到够装下一个调用栈。
 */
const MAX_ITEMS = 20;
/**
 * 单条明细最长字符数。
 *
 * 240 而不是原来的 160：traceback 的 `File "…", line 657, in <module>` 里那串绝对路径
 * 光是团队库镜像那段就 150 字，160 会把行号连同函数名一起削掉——而行号正是拿去给
 * 团队报 bug 的东西。仍然留着上限，防某行输出失控刷屏。
 */
const MAX_ITEM_LEN = 240;

export interface WkGateOutputSummary {
  /** 结论行（已剥掉 `FAIL:` / `PASS:` 前缀）；脚本没打结论行时为空串 */
  headline: string;
  /** `- xxx` 明细（已截断到 MAX_ITEMS 条） */
  items: string[];
  /** 被截掉的明细条数 */
  omitted: number;
  /**
   * 这坨输出里有没有门禁脚本的结构（`FAIL:` / `PASS:` 结论行、或 `- ` 明细行）。
   *
   * 官方脚本每条非 0 返回前都先打一行 `FAIL: …`（`doc-quality-gate.main` 里
   * 每个 `return 1/2` 无一例外），而 python traceback、argparse 的
   * `usage: … error: …` 都没有这个结构。所以 `structured === false` 等于
   * 「这不是门禁给的结论、是门禁工具自己出问题了」——调用方据此把硬拦降级放行。
   */
  structured: boolean;
}

const clip = (s: string): string =>
  s.length > MAX_ITEM_LEN ? `${s.slice(0, MAX_ITEM_LEN - 1)}…` : s;

/**
 * 明细去噪——**只去重复和嵌套前缀，不碰任何语义**：
 *
 * ① `doc-quality-gate.py` 会把子脚本（`wk-delivery-baseline.py`）的每行输出再加一层
 *    `- ` 前缀，于是真明细长这样：`- - status.yaml: …`。剥掉多出来的那层，
 *    否则渲染出来是 `- - - status.yaml`。
 * ② 完全一模一样的行只留第一条：同一个文件会因为命中多个 stage 候选被判好几遍
 *    （实测 `status.yaml` 连刷 8 行字符完全相同的）。
 */
const denoiseItems = (items: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const text = item.replace(/^-\s+/, "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
};

/** 扫一遍输出：抓结论行 + 全部 `- ` 明细行（**不截断**，截断留给调用方） */
const scanGateOutput = (
  raw: string,
): Omit<WkGateOutputSummary, "omitted"> => {
  const lines = raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  let headline = "";
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const verdict = /^(FAIL|PASS):\s*(.*)$/.exec(trimmed);
    // 只认第一条结论行——baseline 子进程可能再打一条、以最外层为准
    if (verdict && !headline) {
      headline = verdict[2]!.trim();
      continue;
    }
    if (trimmed.startsWith("- ")) {
      // 只吃掉 `- ` 这个标记，**后面的缩进原样留着**：子脚本的 traceback 被父脚本
      // 逐行加前缀后长这样 `-   File "…", line 475`，缩进 trim 掉就读不出调用栈层级了
      // （事件流那条提示是 whitespace-pre-wrap 渲染的，留着能正常显示）
      items.push(clip(trimmed.slice(2)));
      continue;
    }
    // 非结论非明细：脚本极少输出，忽略（traceback 走 stderr 兜底分支）
  }

  const structured = !!headline || items.length > 0;
  // 结论行 + 明细都没抓到（如 python traceback）→ 把每行原样当明细，别丢线索
  // （`lines` 已经 trimEnd 过；行首缩进同样留着）
  if (!structured) {
    for (const line of lines) items.push(clip(line));
  }

  return { headline, items: denoiseItems(items), structured };
};

/** 明细截到上限，顺带算出被截掉几条 */
const takeItems = (
  items: string[],
): Pick<WkGateOutputSummary, "items" | "omitted"> => ({
  items: items.slice(0, MAX_ITEMS),
  omitted: Math.max(0, items.length - MAX_ITEMS),
});

/** 拆解脚本输出：抓结论行 + `- ` 明细行，其余噪声丢弃 */
export const parseWkGateOutput = (raw: string): WkGateOutputSummary => {
  const { headline, items, structured } = scanGateOutput(raw);
  return { headline, ...takeItems(items), structured };
};

/**
 * 渲染成事件流 / postCheck 里那条可读文案。
 *
 * 只做「加语境前缀 + 限量展示」，**脚本说什么就显示什么**——不替它解释原因、不给建议
 * （2026-07-28 用户拍板「不翻译，团队规范怎么返回就怎么展示」：脚本输出才是权威的，
 * 改写有失真风险，同事之间还要对着同一段错误信息沟通）。
 *
 * @param title 前缀语境，如「wk:repo-design 执行前门禁未过」——说的是「哪个环节失败了」，
 *   不是对脚本内容的改写
 */
export const formatWkGateFailure = (title: string, raw: string): string => {
  const { headline, items, omitted } = parseWkGateOutput(raw);
  const parts: string[] = [headline ? `${title}：${headline}` : title];
  for (const item of items) parts.push(`- ${item}`);
  if (omitted > 0) parts.push(`- …还有 ${omitted} 条（详见 WK 产出目录）`);
  return parts.join("\n");
};
