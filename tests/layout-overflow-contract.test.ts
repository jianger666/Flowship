/**
 * 长文本撑破容器的两处布局修复的 className 契约（Bug #1 / #6）
 *
 * ⚠ 这是**弱保护**：vitest 没有布局引擎，这里只能断言「关键 className 还在」，
 * 断不了「真的不溢出」。真正的验证要看界面——**目前没有做过**界面级验证（#1 的根因还是读代码推断的，
 * 见 HANDOFF 对应小节的「没做」），要看效果用 `pnpm dev:web` 打开推进弹窗 / 带长选项的问答卡。
 * 它的价值是：有人顺手「清理」掉这些看似多余的类时，测试会拦一下，并把原因写在报错旁边。
 *
 * #6 问答卡选项长串：选项按钮是 flex、文字是 flex 子项，默认 min-width:auto，
 *    一整串不可断的字段名 / 路径 / URL 会把它撑得比按钮还宽，wrap-break-word 也救不了。
 * #1 推进弹窗批次区：三层 `grid` 只写了 gap、没写列模板，隐式列是 auto，
 *    被 nowrap 的长标题撑到比弹窗内容区还宽，truncate 永远截不到，「全选」和 #N 徽标被挤出弹窗。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string =>
  fs.readFileSync(path.join(REPO, rel), "utf-8");

/** 取 start 与 end 两个标记之间的源码（任一找不到就让测试在这里直接失败，别静默放过） */
const between = (src: string, start: string, end: string): string => {
  const a = src.indexOf(start);
  expect(a, `找不到起点标记：${start}`).toBeGreaterThan(-1);
  const b = src.indexOf(end, a + start.length);
  expect(b, `找不到终点标记：${end}`).toBeGreaterThan(a);
  return src.slice(a, b);
};

const classTokens = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

/** 区域里所有 `className="..."` 的纯字符串字面量 */
const classNamesIn = (region: string): string[] =>
  [...region.matchAll(/className="([^"]*)"/g)].map((m) => m[1]!);

describe("#6 · 问答卡选项文字不撑破按钮", () => {
  const src = read("src/components/tasks/ask-user-inline.tsx");

  it("渲染 opt.label 的 span 带 min-w-0（连同 wrap-break-word）", () => {
    const m = src.match(/<span className="([^"]*)">\{opt\.label\}<\/span>/);
    expect(m, "找不到渲染 {opt.label} 的 span（结构变了就更新这条契约）").not.toBeNull();
    const tokens = classTokens(m![1]!);
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("wrap-break-word");
  });

  it("整个问答卡里渲染选项文字的只有这一处（别处新增要同样处理）", () => {
    expect(src.match(/\{opt\.label\}/g) ?? []).toHaveLength(1);
  });
});

/**
 * #8 问答卡底部操作行窄栏溢出（V13-03）
 *
 * review 按文案宽度算过：左「已答 N / M」+ 右「稍后再补充」「提交全部回答」两枚按钮，
 * 单行需要的宽度在 307px 侧栏缺约 11px、窗口 1180 缺 41px、1100 缺 65px——按钮会被挤出卡片右缘。
 * 根因：容器是不换行的 flex、右侧按钮组是 flex item（min-width:auto = 内容宽，不会收缩），
 * 放不下时只能溢出。修法：容器 `flex-wrap gap-y-1.5`（放不下就折到第二行、行间留缝），
 * 按钮组 `ml-auto`（折行后仍靠右，与单行时的位置一致）。
 * 弱保护：只断言类名还在，**没有在浏览器里实测过**（上面的缺口数字来自 review 的计算，不是本测试量的）。
 */
describe("#8 · 问答卡底部操作行窄栏折行而不是溢出", () => {
  const src = read("src/components/tasks/ask-user-inline.tsx");

  const container = src.match(
    /<div className="([^"]*)">\s*<span className="[^"]*">\s*已答 \{answeredCount\}/,
  );
  const group = src.match(
    /已答 \{answeredCount\} \/ \{questions\.length\}\s*<\/span>\s*<div className="([^"]*)">[\s\S]*?稍后再补充/,
  );

  it("能定位到操作行容器与按钮组（结构变了就更新这条契约）", () => {
    expect(container, "找不到包着「已答 N / M」的操作行容器").not.toBeNull();
    expect(group, "找不到「已答」之后、含「稍后再补充」的按钮组").not.toBeNull();
  });

  it("操作行容器：flex-wrap + gap-y-1.5（放不下折到第二行、行间不贴死）", () => {
    expect(classTokens(container![1]!)).toEqual(
      expect.arrayContaining(["flex", "flex-wrap", "gap-y-1.5"]),
    );
  });

  it("按钮组：ml-auto（折行后仍靠右）", () => {
    expect(classTokens(group![1]!)).toContain("ml-auto");
  });
});

describe("#1 · 推进弹窗批次区不被长标题撑出弹窗", () => {
  const src = read("src/components/tasks/advance-dialog.tsx");

  it("三层 grid（区块 / 批次列表 / 疑似重复框）都带 grid-cols-1", () => {
    const region = between(
      src,
      'actionType === "build" && hasBatches && (',
      "自由改动（不绑定批次）",
    );
    const grids = classNamesIn(region).filter((c) =>
      classTokens(c).includes("grid"),
    );
    // 恰好三层：区块外层 / 批次列表 / 疑似重复虚线框——数量变了说明结构动过，需要人重新评估
    expect(grids).toHaveLength(3);
    for (const cls of grids) {
      expect(classTokens(cls), `这层 grid 缺 grid-cols-1：${cls}`).toContain(
        "grid-cols-1",
      );
    }
  });

  it("批次卡片：卡片 min-w-0、标题 truncate + 悬停全文、说明行封顶到父宽", () => {
    const card = between(
      src,
      "const renderBatchChoice",
      "const handleSubmit",
    );

    // 卡片本体
    const button = card.match(
      /<ChoiceButton[\s\S]*?className="([^"]*)"[\s\S]*?>/,
    );
    expect(button).not.toBeNull();
    expect(classTokens(button![1]!)).toContain("min-w-0");

    // 标题：min-w-0 truncate，且包 Tooltip 让被截断的标题悬停可读（规范「Hover 提示」：不用原生 title）
    const title = card.match(
      /<Tooltip content=\{b\.title\}>\s*<span className="([^"]*)">\s*\{b\.title\}\s*<\/span>\s*<\/Tooltip>/,
    );
    expect(title, "标题 span 要包 <Tooltip content={b.title}>").not.toBeNull();
    expect(card).not.toMatch(/\btitle=\{b\.title\}/);
    expect(classTokens(title![1]!)).toEqual(
      expect.arrayContaining(["min-w-0", "truncate"]),
    );

    // 第二行说明：items-start 下 min-w-0 管不到横向，必须 max-w-full
    const note = card.match(
      /<span className="([^"]*)">\s*\{b\.rawId\}/,
    );
    expect(note, "找不到批次说明行").not.toBeNull();
    expect(classTokens(note![1]!)).toEqual(
      expect.arrayContaining(["max-w-full", "min-w-0", "truncate"]),
    );
  });
});

/**
 * #7 输入框底栏窄屏：模型选择器压住右侧附件 / 发送按钮
 *
 * 与上面两条不同，这一条**做过界面级实测**（2026-10-12，Chrome headless + 隔离数据，窗口宽度 1440 → 375）：
 *   修前：窗口 720 起模型按钮就顶穿左 slot，640 压住右侧图标 60px、560 压 140px、480 压 220px；
 *   修后：1440 ~ 700 单行、680 及以下右动作组折到第二行，全程两组按钮矩形交叠面积 = 0，宽屏观感与修前一致。
 *   ≤ 520 时整个应用（侧栏固定 ~281px）已不可用，composer 比框宽属壳层问题、不在这条范围。
 * 根因：trigger 是 <button>，`width:auto` 按 shrink-to-fit 算、下限 = 内容 min-content（nowrap 文案即全宽）——
 * 祖先每一层 `min-w-0`（含 RichInput 的 `*:min-w-0` 兜底）都收不住它，内部 truncate 永远不生效。
 * 仍然是弱保护（断言类名还在）；task 说话条（task-talk-composer）只做了源码层同步，没有单独实测。
 */
describe("#7 · 输入框底栏窄屏不压叠（模型选择器 vs 右侧动作组）", () => {
  const rich = read("src/components/rich-input.tsx");
  const picker = read("src/components/ui/provider-model-picker.tsx");
  const modelSelect = read("src/components/ui/model-select.tsx");
  const talk = read("src/components/tasks/task-talk-composer.tsx");

  const footer = between(rich, "{/* footer：左 slot", "{/* 隐藏 input");
  const footerClasses = classNamesIn(footer);
  const footerRow = footerClasses.find((c) =>
    classTokens(c).includes("justify-between"),
  );
  const leftSlot = footerClasses.find((c) =>
    classTokens(c).some((t) => t.startsWith("basis-")),
  );
  const rightGroup = footerClasses.find((c) => classTokens(c).includes("ml-auto"));

  it("footer 整行 flex-wrap：放不下「左保底 + 右动作组」时右组折到第二行，而不是压在一起", () => {
    expect(footerRow, "找不到 footer 行").toBeDefined();
    expect(classTokens(footerRow!)).toContain("flex-wrap");
  });

  it("左 slot：min-w-0 + flex-1 + 保底 basis + *:min-w-0；无 leading 时不渲染（空 slot 的 basis 也会触发折行）", () => {
    expect(leftSlot, "找不到带 basis-* 的左 slot").toBeDefined();
    expect(classTokens(leftSlot!)).toEqual(
      expect.arrayContaining(["min-w-0", "flex-1", "*:min-w-0"]),
    );
    expect(footer).toContain("{leading ? (");
  });

  it("右动作组：ml-auto（折行后仍靠右）+ shrink-0（图标不被挤变形）", () => {
    expect(rightGroup, "找不到右动作组").toBeDefined();
    expect(classTokens(rightGroup!)).toEqual(
      expect.arrayContaining(["ml-auto", "shrink-0"]),
    );
  });

  it("ModelSelect compact：trigger 自己 max-w-full（button 的 width:auto 是 shrink-to-fit、祖先 min-w-0 收不住）、上限 max-w-48 放 wrapper", () => {
    expect(modelSelect).toContain(
      'variant === "compact" ? "h-7 min-w-0 w-auto max-w-full text-xs" : undefined',
    );
    expect(modelSelect).toContain(
      'variant === "compact" ? "w-auto min-w-0 max-w-48" : undefined',
    );
  });

  it("ProviderModelPicker（compact）：模型保底 min-w-32、提供方 96px 不让位；full 表单不保底", () => {
    expect(picker).toContain(
      'const modelSlotClass = compact ? "min-w-32 flex-1" : "min-w-0 flex-1";',
    );
    expect(picker).toContain(
      '<div className="w-auto max-w-24 shrink-0">{providerEl}</div>',
    );
  });

  it("任务说话条的 leading 与 ProviderModelPicker 同一套收缩契约", () => {
    expect(talk).toContain('<span className="min-w-32 flex-1">');
    expect(talk).toContain('className="h-7 min-w-0 w-auto max-w-24 text-xs"');
    expect(talk).toContain('<span className="inline-flex w-auto max-w-24 shrink-0">');
  });

  it("折行基准 basis ≥ 提供方 + 间距 + 模型保底（三个数字联动，改了其一要同步改 rich-input 的 basis）", () => {
    // Tailwind 间距：n × 4px
    const px = (n: string | undefined): number => Number(n) * 4;
    const basis = px(/basis-(\d+)\b/.exec(leftSlot!)?.[1]);
    const modelMin = px(/"min-w-(\d+) flex-1" : "min-w-0 flex-1"/.exec(picker)?.[1]);
    const providerMax = px(
      /<div className="w-auto max-w-(\d+) shrink-0">\{providerEl\}/.exec(picker)?.[1],
    );
    const gap = px(/flex min-w-0 flex-1 items-center gap-([\d.]+)"/.exec(picker)?.[1]);
    expect(modelMin, "没解析到模型保底").toBeGreaterThan(0);
    expect(providerMax, "没解析到提供方上限").toBeGreaterThan(0);
    expect(gap, "没解析到间距").toBeGreaterThan(0);
    expect(
      basis,
      `basis ${basis}px < 提供方 ${providerMax} + 间距 ${gap} + 模型保底 ${modelMin}`,
    ).toBeGreaterThanOrEqual(providerMax + gap + modelMin);
  });
});
