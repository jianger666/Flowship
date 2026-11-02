/**
 * 读 config.json 失败时，不能把任务的「只读仓 / 脚本仓」标记永久清掉（P1）。
 *
 * 旧行为：`snapshotRepoFlagPaths` 把读 config 失败（Windows 杀软占用 / 手改 JSON 没写完）转成空配置，
 * `readonlyRepoPaths` 被写成 undefined 落进 meta，且快照之后不再重算——submit-mr-guard / action-checks /
 * task-worktrees / task-changes 从此把只读仓当可写仓。
 * 现在：读取出错返回 null（区别于「读到了但没有只读仓」）；
 * - createTask：重试一次，仍失败就抛错（不建任务）；
 * - 两条「更新仓库」路径（updateTaskFields 整份替换 / setTaskRepoPaths）：
 *   · 没有「新加」的仓（只删 / 只换序）：保留 meta 里原值、不覆盖（只剔除已解绑的仓）——对照 company-env-fs 对 error 状态「保留现状、不覆盖」；
 *   · 有「新加」的仓：新仓的只读标记无从得知、默认可写会绕过只读保护 → 重试一次仍失败就抛 SettingsUnreadableError（503），
 *     updateTaskFields 在阶段 1（任何 git 动作 / 落盘之前）就拒绝（R1-15）。
 *
 * 全程临时数据目录；DATA_DIR 须在动态 import 前钉死。
 */
import { mkdirSync, mkdtempSync, promises as fs, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-repo-flags-read-"));
const DATA = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA;
mkdirSync(DATA, { recursive: true });
const CONFIG = path.join(DATA, "config.json");

const { createTask, setTaskRepoPaths, updateTaskFields, SettingsUnreadableError, TaskFieldUpdateError } =
  await import("@/lib/server/task-fs");
const { readMetaV06, DATA_DIR } = await import("@/lib/server/task-fs-core");

const REPO_A = path.join(TMP_ROOT, "work", "crm-web"); // 配置里标「只读 + 脚本仓」
const REPO_B = path.join(TMP_ROOT, "work", "crm-api");
const REPO_C = path.join(TMP_ROOT, "work", "crm-admin");
for (const r of [REPO_A, REPO_B, REPO_C]) mkdirSync(path.join(r, ".git"), { recursive: true });

const writeGoodConfig = (): void => {
  writeFileSync(
    CONFIG,
    JSON.stringify({ repos: [{ path: REPO_A, readonly: true, scriptRepo: true }, { path: REPO_B }] }),
    "utf-8",
  );
};
/** 手改漏了逗号 / 写了一半：JSON.parse 必失败 → readSettingsFile 返回 error */
const writeBrokenConfig = (): void => {
  writeFileSync(CONFIG, '{"repos": [{"path": "', "utf-8");
};
const removeConfig = (): void => rmSync(CONFIG, { force: true });

const taskDirNames = (): string[] => {
  try {
    return readdirSync(DATA_DIR);
  } catch {
    return [];
  }
};

/** config.json 的 readFile 调用次数（用来断言「重试一次」= 恰好读两次） */
const spyConfigReads = (opts: { failFirst?: number } = {}) => {
  const realReadFile = fs.readFile.bind(fs) as (...a: unknown[]) => Promise<unknown>;
  let failures = opts.failFirst ?? 0;
  let reads = 0;
  vi.spyOn(fs, "readFile").mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (String(p) === CONFIG) {
      reads += 1;
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(
          Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
        );
      }
    }
    return realReadFile(p, ...rest);
  }) as unknown as typeof fs.readFile);
  return { reads: () => reads };
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const newTaskInput = (repoPaths: string[]) => ({
  title: "只读仓标记",
  mode: "task" as const,
  workRole: "fe" as const,
  repoPaths,
});

describe("createTask：读 config 出错 → 重试一次，仍失败就报错", () => {
  it("基线：读得到配置 → 只读 / 脚本仓快照正确", async () => {
    writeGoodConfig();
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    const meta = (await readMetaV06(task.id))!;
    expect(meta.readonlyRepoPaths).toEqual([REPO_A]);
    expect(meta.scriptRepoPaths).toEqual([REPO_A]);
  });

  it("config 不存在（读到了、没配过仓）= 正常空快照，不是错误", async () => {
    removeConfig();
    const task = await createTask(newTaskInput([REPO_A]));
    const meta = (await readMetaV06(task.id))!;
    expect(meta.readonlyRepoPaths).toBeUndefined();
    expect(meta.scriptRepoPaths).toBeUndefined();
  });

  it("瞬时占用（第一次 EBUSY、重试成功）：任务照常建出，只读标记完好", async () => {
    writeGoodConfig();
    const spy = spyConfigReads({ failFirst: 1 });
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    expect(spy.reads()).toBe(2); // 失败一次 + 重试一次
    const meta = (await readMetaV06(task.id))!;
    expect(meta.readonlyRepoPaths).toEqual([REPO_A]);
    expect(meta.scriptRepoPaths).toEqual([REPO_A]);
  });

  it("持续读不出来（JSON 写坏）：重试一次后抛带原因的错误，且不留下任务目录", async () => {
    writeBrokenConfig();
    const before = taskDirNames();
    const spy = spyConfigReads();
    await expect(createTask(newTaskInput([REPO_A]))).rejects.toThrow(/config\.json/);
    await expect(createTask(newTaskInput([REPO_A]))).rejects.toThrow(/只读/);
    expect(spy.reads()).toBe(4); // 每次建任务：首读 + 重试 = 2 次
    expect(taskDirNames()).toEqual(before);
  });

  it("抛的是专用错误类（供路由映射 503 + settings_unreadable），不是裸 Error", async () => {
    writeBrokenConfig();
    const err = await createTask(newTaskInput([REPO_A])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsUnreadableError);
    expect((err as InstanceType<typeof SettingsUnreadableError>).code).toBe("settings_unreadable");
    expect((err as InstanceType<typeof SettingsUnreadableError>).httpStatus).toBe(503);
    // 文案给人看：说清是读设置失败、做了什么（取消创建）、怎么办
    expect((err as Error).message).toMatch(/读取设置/);
    expect((err as Error).message).toMatch(/取消创建任务/);
  });

  it("持续被占用（EBUSY）同样报错而不是建出空快照任务", async () => {
    writeGoodConfig();
    spyConfigReads({ failFirst: 99 });
    const before = taskDirNames();
    await expect(createTask(newTaskInput([REPO_A]))).rejects.toThrow(/config\.json/);
    expect(taskDirNames()).toEqual(before);
  });

  it("没有仓库（chat 不绑目录）：快照与 config 无关，config 坏了也能建", async () => {
    writeBrokenConfig();
    const task = await createTask({ title: "无仓聊天", mode: "chat", repoPaths: [] });
    const meta = (await readMetaV06(task.id))!;
    expect(meta.repoPaths).toEqual([]);
    expect(meta.readonlyRepoPaths).toBeUndefined();
  });
});

describe("更新仓库：读 config 出错 → 保留 meta 里原值、不覆盖", () => {
  it("updateTaskFields 整份替换（新增一个仓）：config 坏了 → 拒绝（503 级专用错误），meta 与非仓字段都不落盘", async () => {
    writeGoodConfig();
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);

    writeBrokenConfig();
    // 同一次提交里还带了改标题：整体原子失败，标题不能先落盘
    const err = await updateTaskFields(task.id, {
      title: "不该落盘的新标题",
      repoPaths: [REPO_A, REPO_B, REPO_C],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsUnreadableError);
    // 子类关系：PATCH /api/tasks/[id] 现成的 `instanceof TaskFieldUpdateError` 分支直接把它映射成 err.httpStatus + err.message
    expect(err).toBeInstanceOf(TaskFieldUpdateError);
    expect((err as InstanceType<typeof SettingsUnreadableError>).httpStatus).toBe(503);
    expect((err as Error).message).toMatch(/新增的仓库/);
    expect((err as Error).message).toMatch(/已取消修改仓库/);

    const meta = (await readMetaV06(task.id))!;
    expect(meta.repoPaths).toEqual([REPO_A, REPO_B]);
    expect(meta.title).toBe("只读仓标记");
    expect(meta.readonlyRepoPaths).toEqual([REPO_A]);
    expect(meta.scriptRepoPaths).toEqual([REPO_A]);
  });

  it("updateTaskFields 新增仓遇到瞬时占用（第一次 EBUSY、重试成功）：照常更新，新仓标记按配置算", async () => {
    // 配置里把 C 也标成只读：重试读到后新仓的只读标记要正确
    writeFileSync(
      CONFIG,
      JSON.stringify({ repos: [{ path: REPO_A, readonly: true }, { path: REPO_C, readonly: true }] }),
      "utf-8",
    );
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    const spy = spyConfigReads({ failFirst: 1 });
    const result = await updateTaskFields(task.id, { repoPaths: [REPO_A, REPO_B, REPO_C] });
    expect(result!.task.repoPaths).toEqual([REPO_A, REPO_B, REPO_C]);
    expect(spy.reads()).toBeGreaterThanOrEqual(2); // 失败一次 + 重试
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A, REPO_C]);
  });

  it("updateTaskFields：config 读失败时只解绑（无新仓）→ 不拦；只剔除已解绑的仓，其余原值保留", async () => {
    writeGoodConfig();
    const task = await createTask(newTaskInput([REPO_A, REPO_B, REPO_C]));

    writeBrokenConfig();
    // 解绑 C（非只读）：A 的标记仍在
    await updateTaskFields(task.id, { repoPaths: [REPO_A, REPO_B] });
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);
    // 再把 A 也解绑：A 已不在仓库列表里，它的标记没意义、一并剔除（不残留已解绑仓）
    await updateTaskFields(task.id, { repoPaths: [REPO_B] });
    const meta = (await readMetaV06(task.id))!;
    expect(meta.readonlyRepoPaths).toBeUndefined();
    expect(meta.scriptRepoPaths).toBeUndefined();
  });

  it("updateTaskFields：只换序（仓集合不变）config 坏了也不拦、标记原样", async () => {
    writeGoodConfig();
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    writeBrokenConfig();
    const result = await updateTaskFields(task.id, { repoPaths: [REPO_B, REPO_A] });
    expect(result!.task.repoPaths).toEqual([REPO_B, REPO_A]);
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);
  });

  it("对照：读得到配置时照常按配置覆盖（config 里去掉只读 → 标记被更新掉）", async () => {
    writeGoodConfig();
    const task = await createTask(newTaskInput([REPO_A, REPO_B]));
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);

    writeFileSync(CONFIG, JSON.stringify({ repos: [{ path: REPO_A }, { path: REPO_B }] }), "utf-8");
    await updateTaskFields(task.id, { repoPaths: [REPO_A, REPO_B, REPO_C] });
    const meta = (await readMetaV06(task.id))!;
    expect(meta.readonlyRepoPaths).toBeUndefined();
    expect(meta.scriptRepoPaths).toBeUndefined();
  });

  it("setTaskRepoPaths（chat 重选目录）：config 坏了、没有新加的仓 → 保留原只读标记；读得到时照常重算", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "聊天", mode: "chat", repoPaths: [REPO_A, REPO_B] });
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);

    writeBrokenConfig();
    // 只删（解绑 B）、换序都没有「新仓」：读不出来就保留原值
    const kept = await setTaskRepoPaths(task.id, [REPO_A]);
    expect(kept!.repoPaths).toEqual([REPO_A]);
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toEqual([REPO_A]);
    expect((await readMetaV06(task.id))!.scriptRepoPaths).toEqual([REPO_A]);

    // config 恢复且 A 不再只读 → 重算后清掉
    writeFileSync(CONFIG, JSON.stringify({ repos: [{ path: REPO_A }] }), "utf-8");
    await setTaskRepoPaths(task.id, [REPO_A, REPO_B]);
    expect((await readMetaV06(task.id))!.readonlyRepoPaths).toBeUndefined();
  });

  it("setTaskRepoPaths：config 坏了 + 新加仓 → 拒绝（专用错误），repoPaths 与标记原样不动", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "聊天", mode: "chat", repoPaths: [REPO_A] });
    writeBrokenConfig();
    const err = await setTaskRepoPaths(task.id, [REPO_A, REPO_B]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettingsUnreadableError);
    expect((err as InstanceType<typeof SettingsUnreadableError>).httpStatus).toBe(503);
    const meta = (await readMetaV06(task.id))!;
    expect(meta.repoPaths).toEqual([REPO_A]);
    expect(meta.readonlyRepoPaths).toEqual([REPO_A]);
    expect(meta.scriptRepoPaths).toEqual([REPO_A]);
  });

  it("setTaskRepoPaths：从「不绑目录」选第一个仓、config 坏了 → 同样拒绝（新仓不能默认可写）", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "聊天", mode: "chat", repoPaths: [] });
    writeBrokenConfig();
    await expect(setTaskRepoPaths(task.id, [REPO_A])).rejects.toBeInstanceOf(SettingsUnreadableError);
    expect((await readMetaV06(task.id))!.repoPaths).toEqual([]);
  });

  it("setTaskRepoPaths 清空仓库（不绑目录）：与 config 无关，标记随之清空", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "聊天", mode: "chat", repoPaths: [REPO_A] });
    writeBrokenConfig();
    await setTaskRepoPaths(task.id, []);
    const meta = (await readMetaV06(task.id))!;
    expect(meta.repoPaths).toEqual([]);
    expect(meta.readonlyRepoPaths).toBeUndefined();
    expect(meta.scriptRepoPaths).toBeUndefined();
  });
});
