/**
 * 群答疑（受限只读问答）「按群开关」已删除（第 11 轮：用户决定答疑默认开、不要开关）后的存储层契约——真 fs（tmp 数据目录）。
 *
 * 旧版这个文件测的是 `feishuGroupRestrictedQa` 的存储 + PATCH 路由（缺省关闭 / 换绑清除 / 开启要求有群……），整套行为都没了。
 * 现在要钉的是「老数据兼容」：
 * - 盘上老 meta 里残留的 `feishuGroupRestrictedQa`（true / false 都可能有）读盘时被**忽略**：hydrate 出来的 Task 上没有这个字段，
 *   `listTasks` 的摘要上也没有；不需要迁移、不会报错，其余字段（群 id / 群名）原样；
 * - 绑群 / 换绑 / 取消关联照常工作，且不再碰这个字段（没有「换绑清开关」这回事）；
 * - 设置开关的写接口已删：`task-fs` 不再导出 `setTaskGroupRestrictedQa`，需求群路由不再导出 `PATCH`。
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-group-qa-store-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const taskFs = await import("@/lib/server/task-fs");
const { getTask, listTasks, setTaskGroupAssociation } = taskFs;
const { readMetaV06, writeMeta } = await import("@/lib/server/task-fs-core");
const routeModule = await import("@/app/api/tasks/[id]/requirement-group/route");

type Meta = NonNullable<Awaited<ReturnType<typeof readMetaV06>>>;

let seq = 0;
const seed = async (over: Record<string, unknown> = {}): Promise<string> => {
  const id = `t_qa_${Date.now()}_${seq++}`;
  await writeMeta({
    id,
    title: "登录优化",
    mode: "task",
    repoStatus: "developing",
    runStatus: "idle",
    currentActionId: null,
    actions: [],
    mrs: [],
    repoPaths: [],
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  } as unknown as Meta);
  return id;
};

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("老 meta 里残留的 feishuGroupRestrictedQa：读盘忽略", () => {
  it.each([[true], [false]])("残留 %s：getTask 出来的 Task 上没有这个字段，群 id / 群名原样", async (legacy) => {
    const id = await seed({
      feishuGroupChatId: "oc_a",
      feishuGroupChatName: "需求群",
      feishuGroupRestrictedQa: legacy,
    });
    // 前提：字段确实还在盘上（老数据现场），否则下面的断言没有意义
    expect((await readMetaV06(id) as unknown as Record<string, unknown>)?.feishuGroupRestrictedQa).toBe(legacy);

    const task = await getTask(id);
    expect(task).not.toBeNull();
    expect(task!.feishuGroupChatId).toBe("oc_a");
    expect(task!.feishuGroupChatName).toBe("需求群");
    expect("feishuGroupRestrictedQa" in (task as object)).toBe(false);
  });

  it("listTasks 的摘要上同样没有这个字段（残留 true 的任务也不会带出去）", async () => {
    const id = await seed({ feishuGroupChatId: "oc_list", feishuGroupRestrictedQa: true });
    const summary = (await listTasks()).find((t) => t.id === id);
    expect(summary).toBeDefined();
    expect("feishuGroupRestrictedQa" in (summary as object)).toBe(false);
  });

  it("没有残留字段的任务（新数据）同样读得出来，群 id 原样", async () => {
    const id = await seed({ feishuGroupChatId: "oc_new" });
    const task = await getTask(id);
    expect(task?.feishuGroupChatId).toBe("oc_new");
    expect("feishuGroupRestrictedQa" in (task as object)).toBe(false);
  });
});

describe("setTaskGroupAssociation：照常绑 / 换绑 / 取消，不再牵扯开关", () => {
  it("同群刷新群名：群 id 不变、群名更新、hydrate 结果没有开关字段", async () => {
    const id = await seed({ feishuGroupChatId: "oc_a", feishuGroupRestrictedQa: true });
    const t = await setTaskGroupAssociation(id, { chatId: "oc_a", chatName: "新群名" });
    expect(t?.feishuGroupChatId).toBe("oc_a");
    expect(t?.feishuGroupChatName).toBe("新群名");
    expect("feishuGroupRestrictedQa" in (t as object)).toBe(false);
  });

  it("换绑到另一个群：群 id 换成新的；残留字段不会让新群的 Task 带上开关", async () => {
    const id = await seed({ feishuGroupChatId: "oc_a", feishuGroupRestrictedQa: false });
    const t = await setTaskGroupAssociation(id, { chatId: "oc_b", chatName: "别的群" });
    expect(t?.feishuGroupChatId).toBe("oc_b");
    expect("feishuGroupRestrictedQa" in (t as object)).toBe(false);
    expect("feishuGroupRestrictedQa" in ((await getTask(id)) as object)).toBe(false);
  });

  it("取消关联（null）：群 id / 群名清掉", async () => {
    const id = await seed({
      feishuGroupChatId: "oc_a",
      feishuGroupChatName: "旧群",
      feishuGroupRestrictedQa: true,
    });
    const t = await setTaskGroupAssociation(id, null);
    expect(t?.feishuGroupChatId).toBeUndefined();
    expect(t?.feishuGroupChatName).toBeUndefined();
    const meta = await readMetaV06(id);
    expect(meta?.feishuGroupChatId).toBeUndefined();
    expect(meta?.feishuGroupChatName).toBeUndefined();
  });

  it("首次关联（原来没有群）：群 id 写入，任务照常 hydrate", async () => {
    const id = await seed();
    const t = await setTaskGroupAssociation(id, { chatId: "oc_new" });
    expect(t?.feishuGroupChatId).toBe("oc_new");
    expect("feishuGroupRestrictedQa" in (t as object)).toBe(false);
  });

  it("任务不存在 → null", async () => {
    expect(await setTaskGroupAssociation("t_nope_xxx", { chatId: "oc_x" })).toBeNull();
  });
});

describe("开关的写接口已删除", () => {
  it("task-fs 不再导出 setTaskGroupRestrictedQa", () => {
    expect("setTaskGroupRestrictedQa" in taskFs).toBe(false);
  });

  it("需求群路由只剩 GET / POST（没有 PATCH 开关）", () => {
    expect(typeof routeModule.GET).toBe("function");
    expect(typeof routeModule.POST).toBe("function");
    expect("PATCH" in routeModule).toBe(false);
  });
});
