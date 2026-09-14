/** 推进弹窗内换提供方（先切后推）的源码契约。
 * 脚手架性质：入口收敛完成后可删（JSX 写法断言保质期短，重构即红），行为由 e2e/集成测试接管；
 * 文案类断言别往这里加，只断行为开关。
 * 注意：本文件用 fs.read 读源码、不 import，vitest --watch 下改源码不会触发重跑，只在 --run 下有效。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string): string =>
  readFileSync(path.resolve(import.meta.dirname, "..", relativePath), "utf8");

const dialog = read("src/components/tasks/advance-dialog.tsx");
const page = read("src/app/tasks/[id]/page.tsx");

describe("推进弹窗内可选提供方", () => {
  it("模型选择器露出提供方列（不再 showProvider={false} 锁死）", () => {
    expect(dialog).not.toContain("showProvider={false}");
    expect(dialog).toContain("onProviderChange={handleProviderChange}");
    expect(dialog).toContain("providerId={pickedProvider || taskProvider}");
  });

  it("换提供方后模型回到新家默认、续用自动关", () => {
    expect(dialog).toContain("defaultModelForProvider(getSettings(), nextId)");
    expect(dialog).toContain("setReuseAgent(false)");
  });

  it("提交先切后推：切失败直接停，续用被强制关", () => {
    // 切换动作收敛进 useProviderSwitch（有锚点确认、清覆盖、toast 同一套）
    expect(dialog).toContain("await switchProvider(");
    expect(dialog).toContain("if (!switchedTask) return;");
    // 续用强制关必须用提交期精确值 needSwitch（跟打开快照比的 providerChanged 只做 UI），防别处已切后重复关
    expect(dialog).toContain("const effectiveReuse = needSwitch ? false : reuseAgent");
    expect(dialog).toContain("reuseAgent: effectiveReuse,");
    expect(dialog).toContain("switchedTask,");
  });

  it("续用开关在换提供方时禁用 + 行内提示上下文代价", () => {
    expect(dialog).toContain("disabled={submitting || switchingProvider || providerChanged}");
    expect(dialog).toContain("本次推进将换到新提供方");
  });
});

describe("父组件用切后的任务算新家凭据", () => {
  it("handleAdvance 优先用 switchedTask 跑 prepareRunArgs", () => {
    expect(page).toContain("const t = input.switchedTask ?? task;");
    expect(page).toContain("prepareRunArgs(t)");
  });
});

describe("提供方入口位置（用户拍板）：输入条 + 推进弹窗，顶栏不放", () => {
  it("顶栏 chip 已摘（组件文件删除、详情页无引用）", () => {
    expect(page).not.toContain("TaskProviderSwitch");
  });

  it("输入条底部有提供方下拉（跟模型并排、走共享 hook）", () => {
    const composer = read("src/components/tasks/task-talk-composer.tsx");
    expect(composer).toContain("handleProviderChange");
    expect(composer).toContain("useProviderSwitch");
    expect(composer).toContain("setOverrideModel(null)");
    expect(composer).toContain("listProviderOptions(getSettings())");
  });

  it("输入条模型列表按提供方重拉（切家后不留旧家列表）", () => {
    const composer = read("src/components/tasks/task-talk-composer.tsx");
    expect(composer).toContain("[task.id, providerId, fetchModels]");
  });

  it("推进弹窗切家走共享 hook + 成功立刻 absorb", () => {
    expect(dialog).toContain("useProviderSwitch");
    expect(dialog).toContain("onTaskUpdate");
    expect(dialog).not.toContain("await setTaskProvider(");
  });

  it("providerChanged 跟打开快照比（SSE 推 task 不误触发）", () => {
    expect(dialog).toContain("openProviderRef");
    expect(dialog).toContain("openProviderRef.current || taskProvider");
  });
});

describe("useProviderSwitch 共享动作（三入口同款）", () => {
  const hook = read("src/hooks/use-provider-switch.ts");

  it("有会话锚点先确认、无锚点静默切（读 ref 最新值防 SSE 间隙漏弹）", () => {
    expect(hook).toContain("sessionAgentIdRef.current?.trim()");
    expect(hook).toContain("切换提供方？");
  });

  it("setTaskProvider + 清覆盖 + 成功回最新 task", () => {
    expect(hook).toContain("await setTaskProvider(");
    expect(hook).toContain("clearTalkOverride(taskId)");
    expect(hook).toContain("onSwitched(latest)");
    expect(hook).toContain("切换提供方失败");
  });

  it("三处调用方都走它（对话 / 输入条 / 推进弹窗）", () => {
    for (const f of [
      "src/components/tasks/chat-provider-model-picker.tsx",
      "src/components/tasks/task-talk-composer.tsx",
      "src/components/tasks/advance-dialog.tsx",
    ]) {
      expect(read(f)).toContain("useProviderSwitch");
    }
    // 旧的三份手写实现已清，不留分叉
    expect(read("src/components/tasks/chat-provider-model-picker.tsx")).not.toContain(
      "await setTaskProvider(",
    );
  });
});
