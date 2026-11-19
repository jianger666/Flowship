/**
 * `preview` 工具的接线（不起任何进程）：注册、callerToken 校验、非属主轮硬拒、一次性 agent 清单、提示词里的口径。
 *
 * 业务行为（准入 / 不顶掉别人 / 等地址 / 探活）在 tests/preview-tool.test.ts；
 * 这里钉「工具真的挂得上、没验身份的调用进不去、提示词不再叫 AI 自己用 shell 起服务」。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/preview-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/preview-launch")>()),
  dispatchPreviewTool: vi.fn(async () => ({ ok: true, previews: [] })),
}));

const { flowShipTools, buildSdkCustomTools, invokeFlowshipTool } = await import("@/lib/server/flowship-tools");
const { dispatchPreviewTool } = await import("@/lib/server/preview-launch");
const { setOneShotCallerToken, matchExpectedCallerToken } = await import("@/lib/server/chat-pending");
const { PREVIEW_TOOL_NAME, ONE_SHOT_SYSTEM_TOOL_NAMES, ONE_SHOT_SCHEDULED_SYSTEM_TOOL_NAMES } = await import(
  "@/lib/server/one-shot-tools"
);
const { isFlowshipOwnToolName } = await import("@/lib/server/tool-result-persist");

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(path.join(root, rel), "utf-8");
const def = flowShipTools.find((t) => t.name === "preview")!;
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? "").join("");

describe("注册", () => {
  it("preview 在 flowShipTools 里、名字与一次性清单里的常量一致、被自有工具名单认得（失败不亮绿）", () => {
    expect(def).toBeDefined();
    expect(PREVIEW_TOOL_NAME).toBe("preview");
    expect(isFlowshipOwnToolName("preview")).toBe(true);
    expect(isFlowshipOwnToolName("mcp:custom-user-tools:preview")).toBe(true);
  });

  it("入参 schema：task_id / action 必填，repo_path 可选；action 只有 start / status / stop；没有任何「命令」入参", () => {
    const schema = JSON.parse(JSON.stringify(def.parameters)) as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(schema.required.sort()).toEqual(["action", "task_id"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "repo_path", "task_id"]);
    expect(schema.properties.action!.enum).toEqual(["start", "status", "stop"]);
  });

  it("Cursor 的 customTools 里有它；描述里写明了不能传命令、不顶掉别的任务、起服务只能走它", () => {
    const tools = buildSdkCustomTools("tok", { taskId: "tA" });
    expect(tools.preview).toBeDefined();
    expect(def.description).toContain("不能传命令");
    expect(def.description).toContain("不会");
    expect(def.description).toContain("顶掉");
    expect(def.description).toContain("起服务只能走这个工具");
  });
});

describe("callerToken", () => {
  it("没验过身份（没登记 / token 不对）：不进业务体，回 ok:false", async () => {
    vi.mocked(dispatchPreviewTool).mockClear();
    const r = await def.handler({ task_id: "t_x", action: "start" }, "wrong-token");
    expect(JSON.parse(textOf(r))).toMatchObject({ ok: false });
    expect(dispatchPreviewTool).not.toHaveBeenCalled();
    const none = await def.handler({ task_id: "t_x", action: "start" }, undefined);
    expect(JSON.parse(textOf(none))).toMatchObject({ ok: false });
    expect(dispatchPreviewTool).not.toHaveBeenCalled();
  });

  it("身份对：把 task_id / action / repo_path 原样交给业务体，结果 JSON 化回给 agent；空 repo_path 当没传", async () => {
    setOneShotCallerToken("t_preview_ok", "tok-ok");
    expect(matchExpectedCallerToken("t_preview_ok", "tok-ok")).toBe(true);
    vi.mocked(dispatchPreviewTool).mockClear();
    const r = await def.handler({ task_id: "t_preview_ok", action: "status", repo_path: "" }, "tok-ok");
    expect(JSON.parse(textOf(r))).toEqual({ ok: true, previews: [] });
    expect(dispatchPreviewTool).toHaveBeenCalledWith({ taskId: "t_preview_ok", action: "status", repoPath: undefined });

    await def.handler({ task_id: "t_preview_ok", action: "start", repo_path: "/w/crm-web" }, "tok-ok");
    expect(dispatchPreviewTool).toHaveBeenLastCalledWith({ taskId: "t_preview_ok", action: "start", repoPath: "/w/crm-web" });
  });

  it("业务体抛错：转成 ok:false 的 JSON（不让异常冒给后端、也不亮绿）", async () => {
    setOneShotCallerToken("t_preview_boom", "tok-boom");
    vi.mocked(dispatchPreviewTool).mockRejectedValueOnce(new Error("磁盘炸了"));
    const r = await def.handler({ task_id: "t_preview_boom", action: "start" }, "tok-boom");
    const body = JSON.parse(textOf(r)) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("磁盘炸了");
  });
});

describe("非属主轮 / 一次性 agent", () => {
  it("群里非属主触发的一轮：preview 被硬拒（不在放行白名单里），业务体没被调用", async () => {
    const guard = await import("@/lib/server/non-owner-turn-guard");
    guard.beginNonOwnerTurn("t_preview_nonowner");
    vi.mocked(dispatchPreviewTool).mockClear();
    const r = await invokeFlowshipTool(def, { task_id: "t_preview_nonowner", action: "start" }, "tok", {
      taskId: "t_preview_nonowner",
    });
    expect(textOf(r)).toContain("[DENIED]");
    expect(dispatchPreviewTool).not.toHaveBeenCalled();
  });

  it("用户在场的一次性清单有 preview；定时到点那一轮没有（无人值守不起长驻进程）", () => {
    expect(ONE_SHOT_SYSTEM_TOOL_NAMES).toContain("preview");
    expect(ONE_SHOT_SCHEDULED_SYSTEM_TOOL_NAMES).not.toContain("preview");
  });
});

describe("提示词口径", () => {
  it("共享规范 §9：dev server 仍不许 shell 自己起，但给了出口——用 preview 工具", () => {
    const shared = read("prompts/_shared.md");
    expect(shared).toContain("dev server");
    expect(shared).toContain("用 `preview` 工具起项目");
    expect(shared).toContain("不要用 shell 自己起");
  });

  it("super-prompt 有 preview 一节：不能传命令 / 被别的任务占着不顶掉 / 用浏览器工具看 url", () => {
    const sp = read("prompts/_super.md");
    const at = sp.indexOf("**`preview`（起 / 看 / 停本任务项目的 dev server）**");
    expect(at).toBeGreaterThan(0);
    const block = sp.slice(at, sp.indexOf("**外部动作", at));
    expect(block).toContain("你不能传命令");
    expect(block).toContain("不会");
    expect(block).toContain("顶掉");
    expect(block).toContain("browser_navigate");
    expect(block).toContain("browser_screenshot");
    expect(block).toContain("`wait`");
  });

  it("「什么时候自动清理」的说法与代码一致：终结 / 归档 / 删除才停预览，点「停止」不停（三处文案都不能再写「任务停止时自动清理」）", () => {
    // 代码事实：谁会停预览。停任务（stop-task）不在其中——停的是 agent 这一轮，dev server 继续占着端口
    const runner = read("src/lib/server/task-runner.ts");
    const finalizeAt = runner.indexOf("export const finalizeTask = async (");
    const archiveAt = runner.indexOf("export const archiveTaskWithCleanup = async (");
    // 函数名 / 形式变了这条会先挂：到时按新位置改断言，而不是放过
    expect(finalizeAt).toBeGreaterThan(0);
    expect(archiveAt).toBeGreaterThan(0);
    expect(runner.slice(finalizeAt, archiveAt)).toContain("stopPreviewsForTask(taskId)");
    expect(runner.slice(archiveAt)).toContain("stopPreviewsForTask(taskId)");
    expect(read("src/lib/server/task-fs.ts")).toContain("stopPreviewsForTask(id)");
    expect(read("src/lib/server/stop-task.ts")).not.toContain("stopPreviewsForTask");

    // 文案：三处口径一致
    const sp = read("prompts/_super.md");
    const superBlock = sp.slice(sp.indexOf("**`preview`（起 / 看 / 停本任务项目的 dev server）**"));
    for (const [name, text] of [
      ["super-prompt", superBlock.slice(0, superBlock.indexOf("**外部动作"))],
      ["共享规范 §9", read("prompts/_shared.md")],
      ["工具描述", def.description],
    ] as const) {
      expect(text, name).not.toMatch(/任务停止\s*\/\s*终结/);
      expect(text, name).toContain("终结 / 归档 / 删除");
      expect(text, name).toMatch(/点「停止」[^。；]*不会停它/);
    }
  });

  it("定时到点的一次性 agent 边界里说明没有 preview；用户在场的一次性 agent 边界里点名可以用", () => {
    expect(read("src/lib/schedule.ts")).toContain("这里也没有 `preview`");
    expect(read("src/lib/server/task-runner.ts")).toContain("项目预览（preview");
  });
});
