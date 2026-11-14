/**
 * 推进弹窗「高级选项」折叠区的接线契约 + 开合记忆（view-memory）。
 *
 * 要守的是「折叠只是 UI 呈现」这条线，三件事：
 *  1. 分类没串：低频运行参数（续用 / 模型 / 删源分支）在高级区里；会决定对外副作用走向的选项
 *     （dev 直推 / 提 PR、批次选择）和所有阻断 / 警示内容留在主区、绝不被折叠区吞掉；
 *  2. 默认值 / 提交 payload / 校验一个字没改（逐字段钉住表达式）；
 *  3. 开合走 view-memory 单一收口、触发器带 aria-expanded、纯函数无 React / DOM 依赖。
 *
 * 脚手架性质：JSX 写法断言保质期短，重构即红——红了先看是不是真的把东西挪错了地方，再更新断言。
 * 注意：本文件用 fs.read 读源码、不 import，vitest --watch 下改源码不会触发重跑，只在 --run 下有效。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = (rel: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", rel), "utf8");
// 剥注释：注释里点名「devPushMode」「AlertTriangle」之类不该影响结构断言（`://` 的 URL 放过）
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
// 折叠空白：payload 表达式换行 / 缩进变了不该让契约红
const squash = (s: string): string => s.replace(/\s+/g, " ");

const DIALOG = "src/components/tasks/advance-dialog.tsx";
const SECTION = "src/components/tasks/advance-advanced-section.tsx";
const HOOK = "src/hooks/use-advance-advanced-open.ts";
const SUMMARY = "src/lib/advance-advanced-summary.ts";

const dialog = stripComments(read(DIALOG));

// 高级区子树：<AdvanceAdvancedSection …> … </AdvanceAdvancedSection>；前 / 后 = 主区其余部分
const sectionStart = dialog.indexOf("<AdvanceAdvancedSection");
const sectionEnd = dialog.lastIndexOf("</AdvanceAdvancedSection>");
const insideAdvanced = dialog.slice(sectionStart, sectionEnd);
const beforeAdvanced = dialog.slice(0, sectionStart);
const afterAdvanced = dialog.slice(sectionEnd);

describe("分类：折进高级区 vs 必须留主区", () => {
  it("能定位到高级区子树（结构变了就更新这条契约）", () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    // 只渲染一处，别在别的分支又渲染一份
    expect(dialog.match(/<AdvanceAdvancedSection\b/g)).toHaveLength(1);
  });

  it("折进高级区：续用 agent / 模型 + 提供方 / 合并后删源分支", () => {
    expect(insideAdvanced).toContain('id="advance-reuse-agent"');
    expect(insideAdvanced).toContain("<ProviderModelPicker");
    expect(insideAdvanced).toContain("onModelChange={setPickedModel}");
    expect(insideAdvanced).toContain("onProviderChange={handleProviderChange}");
    expect(insideAdvanced).toContain('id="advance-remove-source"');
  });

  it("高级区内没有任何「对外副作用走向 / 阻断 / 警示」相关的东西", () => {
    for (const forbidden of [
      // dev 直推 / 提 PR
      "devPushMode",
      "setDevPushMode",
      // 批次选择 / 自由改动
      "selectedBatchIds",
      "freeFormBuild",
      "toggleBatch",
      "renderBatchChoice",
      // plan 追加提示
      "hasPlanHistory",
      // 准入 / 只读仓 / 缺 token / host 拦截
      "disabledReason",
      "disabledHint",
      "gitToken",
      "gitHostError",
      "resolvedGitHost",
      // 警示图标 / 推进失败原因
      "AlertTriangle",
      "submitError",
      // action 选择与指令输入
      "renderActionChip",
      "RichInput",
      "ChoiceButton",
    ]) {
      expect(insideAdvanced, `高级区里不该出现 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("主区仍在：action 选择（含分组 / 自定义）、批次选择、指令输入、dev 推送方式（都在高级区之外）", () => {
    // dev 推送方式 / 批次选择 / 指令输入 / action 选择：全在高级区之前
    for (const keep of [
      "renderActionChip(key)",
      'actionType === "build" && hasBatches && (',
      "自由改动（不绑定批次）",
      "<RichInput",
      'actionType === "dev" && (',
      "setDevPushMode(",
    ]) {
      expect(beforeAdvanced, `${keep} 应在高级区之前（主区）`).toContain(keep);
    }
    // 推进失败原因在高级区之后、role="alert" 保持（阻断性内容原位原样）
    expect(afterAdvanced).toContain("submitError && !submitting");
    expect(afterAdvanced).toContain('role="alert"');
  });

  it("警示 / 提示都留在主区原位：准入灰卡的 AlertTriangle 角标、批次缺失警示、plan 追加提示、环境配置提示", () => {
    expect(beforeAdvanced.match(/<AlertTriangle\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(beforeAdvanced).toContain("latestPlanMissingBatches");
    expect(beforeAdvanced).toContain("本次会追加到现有方案");
    expect(beforeAdvanced).toContain("需先在设置页填环境配置");
  });

  it("高级区只在有适用项时渲染（不出空折叠），适用项由纯函数判定", () => {
    expect(dialog).toContain("hasAdvancedItems(advancedItems) && (");
    expect(dialog).toContain("resolveAdvancedItems(actionType)");
    // 删源分支开关只在 ship 的适用项里渲染
    expect(insideAdvanced).toContain("advancedItems.removeSourceBranch && (");
    expect(insideAdvanced).toContain("advancedItems.agentRuntime && (");
  });

  it("devPushMode 块仍在 action 专属附加区（empty:hidden 容器）里、且只在 dev 时渲染", () => {
    const i = beforeAdvanced.indexOf('<div className="empty:hidden">');
    expect(i).toBeGreaterThan(-1);
    const extra = beforeAdvanced.slice(i);
    expect(extra).toContain('actionType === "dev" && (');
    // 删源分支开关已不在这块里（折进高级区了）
    expect(extra).not.toContain("advance-remove-source");
  });
});

describe("默认值 / payload / 校验：折叠前后一个字没改", () => {
  const code = squash(dialog);

  it("打开时的默认值来源不变：续用走设置页偏好、模型走 task 最近 action → task.model → 设置页默认、删源分支走 task 上次选择、dev 回直推、批次回未表态", () => {
    expect(code).toContain("const initialReuse = s.reuseAgentDefault ?? false;");
    expect(code).toContain(
      "const initialModel: ModelSelection = defaultPickedModelRef.current ?? defaultModelForProvider(s, providerId) ?? { id: \"\" };",
    );
    expect(code).toContain("setReuseAgent(initialReuse);");
    expect(code).toContain("setPickedModel(initialModel);");
    expect(code).toContain("setRemoveSourceBranch(defaultRemoveSourceBranch);");
    expect(code).toContain('setDevPushMode("direct");');
    expect(code).toContain("setSelectedBatchIds([]);");
    expect(code).toContain("setFreeFormBuild(false);");
    expect(code).toContain("() => task.removeSourceBranchOnMerge ?? false,");
  });

  it("提交 payload 每个字段的表达式不变", () => {
    const submit = code.slice(code.indexOf("await onSubmit({"));
    for (const field of [
      "actionType,",
      "userInstruction: text,",
      "reuseAgent: effectiveReuse,",
      "model: !effectiveReuse && pickedModel.id ? pickedModel : undefined,",
      "switchedTask,",
      "images,",
      "skillRefs,",
      "attachments,",
      'removeSourceBranch: actionType === "ship" ? removeSourceBranch : undefined,',
      'requestedBatchIds: actionType === "build" && hasBatches && selectedBatchIds.length > 0 ? selectedBatchIds : undefined,',
      'devPushMode: actionType === "dev" ? devPushMode : undefined,',
      'replanMode: actionType === "plan" && hasPlanHistory ? "append" : undefined,',
      'customActionId: actionType === "custom" ? (selectedCustomActionId ?? undefined) : undefined,',
    ]) {
      expect(submit, `payload 缺 ${field}`).toContain(field);
    }
    // 续用强制关仍用提交期精确值 needSwitch（advance-provider-switch 契约同款）
    expect(code).toContain("const effectiveReuse = needSwitch ? false : reuseAgent;");
  });

  it("校验不变：canSubmit 的条件一条没增没减（折叠区不参与可提交判定）", () => {
    const start = code.indexOf("const canSubmit = useMemo(() => {");
    const body = code.slice(start, code.indexOf("]);", start));
    for (const cond of [
      "if (submitting || switchingProvider) return false;",
      "if (!actionType) return false;",
      "if (disabledReason) return false;",
      'if (actionType === "custom" && !selectedCustomActionId) return false;',
      'actionType === "build" && hasBatches && selectedBatchIds.length === 0 && !freeFormBuild',
    ]) {
      expect(body, `canSubmit 缺 ${cond}`).toContain(cond);
    }
    // 高级区的开合 / 摘要 / 强制展开都不进 canSubmit
    expect(body).not.toMatch(/advanced/i);
  });

  it("强制展开只展开、不拦提交：handleSubmit 里它在 onSubmit 之前、且不带 return", () => {
    const start = code.indexOf("const handleSubmit = async () => {");
    const body = code.slice(start);
    const call = "if (!reuseAgent && !pickedModel.id.trim()) forceAdvancedExpand();";
    expect(body).toContain(call);
    expect(body.indexOf(call)).toBeLessThan(body.indexOf("await onSubmit({"));
    // 打开时：起新 agent 且没模型 → 撑开（让选择器看得见）
    expect(code).toContain("if (!initialReuse && !initialModel.id.trim()) forceAdvancedExpand();");
  });

  it("续用开关的禁用条件 / 提供方提示文案不变（advance-provider-switch 契约同款）", () => {
    expect(code).toContain("disabled={submitting || switchingProvider || providerChanged}");
    expect(code).toContain("本次推进将换到新提供方");
  });
});

describe("开合记忆走 view-memory 单一收口 + 无障碍", () => {
  const hook = stripComments(read(HOOK));
  const section = stripComments(read(SECTION));

  it("hook 只经 view-memory 读写，不直接碰 localStorage；弹窗 / 折叠壳也不碰", () => {
    expect(hook).toContain('from "@/lib/view-memory"');
    expect(hook).toContain("loadAdvanceAdvancedOpen");
    expect(hook).toContain("saveAdvanceAdvancedOpen");
    for (const [name, src] of [
      ["hook", hook],
      ["section", section],
      ["dialog", dialog],
    ] as const) {
      expect(src, name).not.toMatch(/localStorage|sessionStorage/);
    }
  });

  it("弹窗经 hook 拿开合态，打开 / 用户点触发器的语义分开：用户点才落盘，强制展开不落盘", () => {
    expect(dialog).toContain("useAdvanceAdvancedOpen(open)");
    expect(dialog).toContain("onOpenChange={setAdvancedExpanded}");
    // 落盘只发生在 setExpanded（用户点触发器）里
    const saves = hook.match(/saveAdvanceAdvancedOpen\(/g) ?? [];
    expect(saves).toHaveLength(1);
    expect(hook).toMatch(/const setExpanded = useCallback\(\(next: boolean\) => \{[\s\S]*saveAdvanceAdvancedOpen\(next\)/);
    expect(hook).toMatch(/const forceExpand = useCallback\(\(\) => setForced\(true\), \[\]\)/);
  });

  it("折叠头是 shadcn Button（不手写原生 button），带 aria-expanded / aria-controls；展开体收起时 inert", () => {
    expect(section).toContain('import { Button } from "@/components/ui/button"');
    expect(section).not.toMatch(/<button\b/);
    expect(section).toContain("aria-expanded={open}");
    expect(section).toContain("aria-controls={panelId}");
    expect(section).toContain("inert={!open}");
    // 展开体 id 与 aria-controls 同源
    expect(section).toContain("id={panelId}");
  });

  it("摘要只在收起时显示；强调段用 Badge warning（语义色 token、不手写色号），读屏有「注意：」前缀", () => {
    expect(section).toContain("!open && summary.length > 0");
    expect(section).toContain('<Badge variant="warning" size="xs">');
    expect(section).toContain("注意：");
  });

  it("弹窗里摘要由纯函数 buildAdvancedSummary 生成，不在组件里拼文案", () => {
    expect(dialog).toContain("buildAdvancedSummary({");
    expect(dialog).toContain("summary={advancedSummary}");
    // 模型标签 / 思考档与模型下拉 trigger 同源
    expect(dialog).toContain("compactModelLabel(availableModels, pickedModel.id)");
    expect(dialog).toContain("resolveThinkingTriggerLabel(");
  });

  it("摘要纯函数无 React / DOM / 存储依赖（client / server 都能 import）", () => {
    const summary = stripComments(read(SUMMARY));
    expect(summary).not.toMatch(/from "react"|window\b|document\b|localStorage/);
    // 只依赖纯 lib：模型指纹 + 类型
    const imports = [...summary.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/task-model", "@/lib/types"]);
  });
});

// ---------------------------------------------------------------- view-memory 行为

const KEY = "flowship:advance-advanced-open";

interface FakeLocal {
  data: Map<string, string>;
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
}

const makeLocal = (opts: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}): FakeLocal => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((k: string) => {
      if (opts.throwOnRead) throw new DOMException("denied", "SecurityError");
      return data.get(k) ?? null;
    }),
    setItem: vi.fn((k: string, v: string) => {
      if (opts.throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
      data.set(k, v);
    }),
  };
};

describe("view-memory：推进弹窗高级区开合", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("没存过 → 收起（默认收起）", async () => {
    vi.stubGlobal("localStorage", makeLocal());
    const vm = await import("@/lib/view-memory");
    expect(vm.loadAdvanceAdvancedOpen()).toBe(false);
  });

  it("展开 / 收起都能存、能读回，key 对齐既有 flowship: 前缀、值 1 / 0", async () => {
    const local = makeLocal();
    vi.stubGlobal("localStorage", local);
    const vm = await import("@/lib/view-memory");
    vm.saveAdvanceAdvancedOpen(true);
    expect(local.data.get(KEY)).toBe("1");
    expect(vm.loadAdvanceAdvancedOpen()).toBe(true);
    vm.saveAdvanceAdvancedOpen(false);
    expect(local.data.get(KEY)).toBe("0");
    expect(vm.loadAdvanceAdvancedOpen()).toBe(false);
  });

  it("只认 \"1\"：脏值（true / yes / 空串 / 数字 2）一律当收起", async () => {
    for (const bad of ["true", "yes", "", "2", "on"]) {
      vi.resetModules();
      const local = makeLocal();
      local.data.set(KEY, bad);
      vi.stubGlobal("localStorage", local);
      const vm = await import("@/lib/view-memory");
      expect(vm.loadAdvanceAdvancedOpen(), JSON.stringify(bad)).toBe(false);
    }
  });

  it("存储被禁 / 配额满：读按收起、写不抛（记忆丢了无妨、不能影响主流程）", async () => {
    vi.stubGlobal("localStorage", makeLocal({ throwOnRead: true, throwOnWrite: true }));
    const vm = await import("@/lib/view-memory");
    expect(vm.loadAdvanceAdvancedOpen()).toBe(false);
    expect(() => vm.saveAdvanceAdvancedOpen(true)).not.toThrow();
  });

  it("没有 localStorage（SSR 首渲）：读收起、写不抛", async () => {
    const vm = await import("@/lib/view-memory");
    expect(vm.loadAdvanceAdvancedOpen()).toBe(false);
    expect(() => vm.saveAdvanceAdvancedOpen(true)).not.toThrow();
  });
});
