/**
 * share_to_group 工具路径：任务没有已绑定群时的错误文案（R3-03）
 *
 * 工具路径不传 persistLocalGroup、产品语义是「工具不自建群」。agent 侧收到的必须是
 * 可行动的文案（去任务页创建/绑定需求群），不是「内部错误」，且一个群都不建。
 * 走真实 flowship-tools handler + 真实 feishu-group（只注入外部依赖）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { TaskMetaV06 } from "@/lib/server/task-fs-core";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-share-tool-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const { writeMeta } = await import("@/lib/server/task-fs-core");
const { setChatTaskActionHandler } = await import("@/lib/server/chat-pending");
const { flowShipTools } = await import("@/lib/server/flowship-tools");
const {
  __setFeishuGroupDepsForTest,
  NO_BOUND_GROUP_TOOL_MESSAGE,
} = await import("@/lib/server/feishu-group");

const def = flowShipTools.find((t) => t.name === "share_to_group")!;
if (!def) throw new Error("share_to_group tool missing");

const TASK = "t-share-tool-1";
const TOK = "tok-share-tool-1";

await writeMeta({
  id: TASK,
  title: "登录优化",
  mode: "task",
  repoStatus: "developing",
  runStatus: "idle",
  currentActionId: null,
  actions: [],
  mrs: [],
  repoPaths: [],
  feishuStoryUrl: "https://project.feishu.cn/space/story/detail/10001",
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as unknown as TaskMetaV06);
setChatTaskActionHandler(TASK, (async () => {}) as never, TOK);

afterAll(() => {
  setChatTaskActionHandler(TASK, null);
  __setFeishuGroupDepsForTest(null);
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("share_to_group 工具：没有已绑定群", () => {
  it("agent 收到可行动文案（no_group），不是内部错误；一个群都不建", async () => {
    const createChat = vi.fn().mockResolvedValue({ chat_id: "oc_orphan" });
    __setFeishuGroupDepsForTest({
      fetchRoleMemberEmails: async () => [],
      scheduleSelfRegister: () => {},
      fetchGroupType: async () => ({ value: "disabled" }),
      createChat,
      fetchWorkitemName: async () => "登录优化",
      getBotInfo: async () => ({ appId: "cli_self", ownerOpenId: "ou_me" }),
      decodeUrl: async () => ({ workItemId: "10001", simpleName: "space" }),
    });

    for (let i = 0; i < 2; i += 1) {
      const r = await def.handler({ task_id: TASK, content: "进展同步" }, TOK);
      const body = JSON.parse((r.content[0] as { text: string }).text) as {
        ok: boolean;
        error: string;
        code: string;
      };
      expect(body.ok).toBe(false);
      expect(body.code).toBe("no_group");
      expect(body.error).toBe(NO_BOUND_GROUP_TOOL_MESSAGE);
      expect(body.error).toContain("任务页的飞书协作入口");
      expect(body.error).not.toContain("内部错误");
    }
    expect(createChat).not.toHaveBeenCalled();
  });
});
