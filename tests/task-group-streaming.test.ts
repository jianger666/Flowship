/**
 * 任务级「群答疑回复是否流式」覆盖（`task.feishuGroupStreaming`，需求群弹窗里的三选一）。
 *
 * 钉死：
 * - 存储：true / false 落盘并从 getTask / listTasks 读回；null 清掉字段（跟随全局）；不存在的任务返回 null；
 *   只改这一个字段、**不刷 updatedAt**（偏好开关不是「刚操作了任务」，不能把任务顶到列表最前）；
 *   换绑 / 取消群关联不碰它（群换了，偏好仍是这个任务的偏好）；
 * - PUT 路由：只认布尔 / null，其余 400；404；成功回最新 task；
 * - UI 三态 ↔ 存储值的换算（group-streaming-choice）；
 * - 接线（源码契约）：任务头 → 弹窗 prop → task-store 客户端 → 路由，一路接通；弹窗只在已有关联的群时显示该行。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-group-streaming-"));
process.env.FLOWSHIP_DATA_DIR = path.join(TMP_ROOT, "data");

const taskFs = await import("@/lib/server/task-fs");
const { getTask, listTasks, setTaskGroupAssociation, setTaskGroupStreaming } = taskFs;
const { readMetaV06, writeMeta } = await import("@/lib/server/task-fs-core");
const route = await import("@/app/api/tasks/[id]/requirement-group/streaming/route");
const choice = await import("@/lib/group-streaming-choice");

type Meta = NonNullable<Awaited<ReturnType<typeof readMetaV06>>>;

let seq = 0;
const seed = async (over: Record<string, unknown> = {}): Promise<string> => {
  const id = `t_gs_${Date.now()}_${seq++}`;
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

const put = (id: string, body: unknown, raw?: string) =>
  route.PUT(
    new Request("http://x/api", {
      method: "PUT",
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("setTaskGroupStreaming：存储", () => {
  it("缺省：任务上没有这个字段（跟随全局）", async () => {
    const id = await seed();
    const t = await getTask(id);
    expect(t).not.toBeNull();
    expect("feishuGroupStreaming" in (t as object) && t!.feishuGroupStreaming !== undefined).toBe(false);
  });

  it.each([[true], [false]])("写 %s：落盘、getTask / listTasks 都读得回", async (v) => {
    const id = await seed();
    const t = await setTaskGroupStreaming(id, v);
    expect(t?.feishuGroupStreaming).toBe(v);
    expect((await readMetaV06(id))?.feishuGroupStreaming).toBe(v);
    expect((await getTask(id))?.feishuGroupStreaming).toBe(v);
    expect((await listTasks()).find((s) => s.id === id)?.feishuGroupStreaming).toBe(v);
  });

  it("写 null：清掉字段（盘上也没有，不是留个 null / undefined 占位）", async () => {
    const id = await seed({ feishuGroupStreaming: false });
    const t = await setTaskGroupStreaming(id, null);
    expect(t?.feishuGroupStreaming).toBeUndefined();
    const meta = (await readMetaV06(id)) as unknown as Record<string, unknown>;
    expect("feishuGroupStreaming" in meta).toBe(false);
  });

  it("任务不存在 → null；不凭空建任务", async () => {
    expect(await setTaskGroupStreaming("t_nope_xxx", true)).toBeNull();
    expect(await getTask("t_nope_xxx")).toBeNull();
  });

  it("只改这一个字段：不刷 updatedAt，其余字段（标题 / 群关联）原样", async () => {
    const id = await seed({ feishuGroupChatId: "oc_a", feishuGroupChatName: "需求群" });
    const t = await setTaskGroupStreaming(id, true);
    expect(t?.updatedAt).toBe(2_000);
    expect((await readMetaV06(id))?.updatedAt).toBe(2_000);
    expect(t?.title).toBe("登录优化");
    expect(t?.feishuGroupChatId).toBe("oc_a");
    expect(t?.feishuGroupChatName).toBe("需求群");
  });

  it("换绑 / 取消群关联不碰它：偏好是任务的，不随群走", async () => {
    const id = await seed({ feishuGroupChatId: "oc_a" });
    await setTaskGroupStreaming(id, false);
    const rebound = await setTaskGroupAssociation(id, { chatId: "oc_b", chatName: "新群" });
    expect(rebound?.feishuGroupStreaming).toBe(false);
    const cleared = await setTaskGroupAssociation(id, null);
    expect(cleared?.feishuGroupChatId).toBeUndefined();
    expect(cleared?.feishuGroupStreaming).toBe(false);
  });
});

describe("PUT /requirement-group/streaming", () => {
  it.each([[true], [false], [null]])("streaming=%s → 200 + 最新 task", async (v) => {
    const id = await seed({ feishuGroupStreaming: v === null ? true : !v });
    const res = await put(id, { streaming: v });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; task: { feishuGroupStreaming?: boolean } };
    expect(data.ok).toBe(true);
    if (v === null) expect(data.task.feishuGroupStreaming).toBeUndefined();
    else expect(data.task.feishuGroupStreaming).toBe(v);
    expect((await getTask(id))?.feishuGroupStreaming).toBe(v ?? undefined);
  });

  it.each([
    ["缺省", {}],
    ["字符串", { streaming: "true" }],
    ["数字", { streaming: 1 }],
    ["undefined 序列化后缺省", { streaming: undefined }],
    ["null 请求体", null],
  ])("body 不对（%s）→ 400、不写盘", async (_name, body) => {
    const id = await seed({ feishuGroupStreaming: true });
    const res = await put(id, body);
    expect(res.status).toBe(400);
    expect((await getTask(id))?.feishuGroupStreaming).toBe(true);
  });

  it("不是 JSON → 400", async () => {
    const id = await seed();
    expect((await put(id, null, "not json")).status).toBe(400);
  });

  it("任务不存在 → 404", async () => {
    expect((await put("t_nope_yyy", { streaming: true })).status).toBe(404);
  });
});

describe("三态 ↔ 存储值（group-streaming-choice）", () => {
  it("存储值 → 选项：缺省 / null / 脏值 = 跟随全局", () => {
    expect(choice.groupStreamingChoiceOf(true)).toBe("on");
    expect(choice.groupStreamingChoiceOf(false)).toBe("off");
    expect(choice.groupStreamingChoiceOf(undefined)).toBe("follow");
    expect(choice.groupStreamingChoiceOf(null)).toBe("follow");
    expect(choice.groupStreamingChoiceOf("true" as never)).toBe("follow");
  });

  it("选项 → 写给服务端的值：跟随全局 = null（清覆盖）", () => {
    expect(choice.groupStreamingValueOf("on")).toBe(true);
    expect(choice.groupStreamingValueOf("off")).toBe(false);
    expect(choice.groupStreamingValueOf("follow")).toBeNull();
  });

  it("往返一致", () => {
    for (const c of ["follow", "on", "off"] as const) {
      const v = choice.groupStreamingValueOf(c);
      expect(choice.groupStreamingChoiceOf(v)).toBe(c);
    }
  });

  it("三个选项齐全、文案不空、顺序 = 跟随全局 / 流式 / 整条发送", () => {
    expect(choice.GROUP_STREAMING_OPTIONS.map((o) => o.choice)).toEqual(["follow", "on", "off"]);
    expect(choice.GROUP_STREAMING_OPTIONS.map((o) => o.label)).toEqual(["跟随全局", "流式", "整条发送"]);
    for (const o of choice.GROUP_STREAMING_OPTIONS) expect(o.hint.length).toBeGreaterThan(0);
  });
});

describe("接线（源码契约）", () => {
  const read = (rel: string): string =>
    readFileSync(path.join(process.cwd(), rel), "utf8");

  it("任务头把 task.feishuGroupStreaming 传给弹窗", () => {
    expect(read("src/components/tasks/task-utility-actions.tsx")).toMatch(
      /groupStreaming=\{task\.feishuGroupStreaming\}/,
    );
  });

  it("弹窗：点选走 setRequirementGroupStreaming、值经 groupStreamingValueOf 换算、成功回刷任务；只在已有关联的群时显示", () => {
    const src = read("src/components/tasks/requirement-group-dialog.tsx");
    expect(src).toContain("setRequirementGroupStreaming(forTask, groupStreamingValueOf(next))");
    // 成功后紧跟着回刷任务（同一个 try 块里；文件里别处也有 onTaskUpdateRef，所以锚在这次调用之后）
    expect(src).toMatch(
      /setRequirementGroupStreaming\(forTask[^;]*;\s*onTaskUpdateRef\.current\(r\.task\)/,
    );
    // 显示条件：不在加载 / 没出错 / 有工作项 / 已绑定
    expect(src).toMatch(/!statusLoading && !statusError && !noStory && bound && \(/);
    // 失败回滚 + toast
    expect(src).toMatch(/setStreamChoice\(prev\)/);
    expect(src).toContain("保存失败");
  });

  it("客户端 → 路由路径一致（PUT /requirement-group/streaming）", () => {
    const src = read("src/lib/task-store.ts");
    expect(src).toMatch(/requirement-group\/streaming`/);
    expect(src).toMatch(/method: "PUT"/);
  });
});
