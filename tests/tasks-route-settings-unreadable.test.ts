/**
 * 读 config.json 失败（只读仓标记无从确认）时，路由层给前端的是「503 + 可读文案」，而不是泛化的
 * 500 `create_failed` / 400 `bad_request`（R1-15 / R1-16）。
 *
 * 前端 createTask / setTaskRepoPaths / updateTaskFields 都经 task-store 的 `handleJson`：
 * 非 2xx 时把响应体的 `error` 字符串当 `Error.message`、`code` 当稳定错误码，调用方统一
 * `toast.error(\`启动失败：${err.message}\`)` —— 所以 `error` 必须是给人看的话（不能只放 `settings_unreadable` 这种内部码），
 * 稳定码另放 `code`。
 *
 * 真实 route handler + 真实 task-fs（私有临时数据目录；DATA_DIR 须在动态 import 前钉死）。
 * 只 mock 飞书桥接 bootstrap（POST route 模块加载时会起它）。
 */
import { mkdirSync, mkdtempSync, promises as fs, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/feishu-bridge/bootstrap", () => ({
  ensureFeishuBridgeBootstrapped: () => {},
}));

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "fe-tasks-route-settings-"));
const DATA = path.join(TMP_ROOT, "data");
process.env.FLOWSHIP_DATA_DIR = DATA;
mkdirSync(DATA, { recursive: true });
const CONFIG = path.join(DATA, "config.json");

// createTask 默认透传真实实现；个别用例临时改成抛「别的」错误，验证非 settings 错误仍是原来的 500 create_failed
const createTaskOverride = vi.hoisted(() => ({ fn: null as null | (() => Promise<never>) }));
vi.mock("@/lib/server/task-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/task-fs")>();
  return {
    ...actual,
    createTask: (...args: Parameters<typeof actual.createTask>) =>
      createTaskOverride.fn ? createTaskOverride.fn() : actual.createTask(...args),
  };
});

const { POST } = await import("@/app/api/tasks/route");
const { PATCH } = await import("@/app/api/tasks/[id]/route");
const { createTask, getTask } = await import("@/lib/server/task-fs");
const { DATA_DIR } = await import("@/lib/server/task-fs-core");

const REPO_A = path.join(TMP_ROOT, "work", "crm-web");
const REPO_B = path.join(TMP_ROOT, "work", "crm-api");
for (const r of [REPO_A, REPO_B]) mkdirSync(path.join(r, ".git"), { recursive: true });

const writeGoodConfig = (): void => {
  writeFileSync(CONFIG, JSON.stringify({ repos: [{ path: REPO_A, readonly: true }] }), "utf-8");
};
const writeBrokenConfig = (): void => {
  writeFileSync(CONFIG, '{"repos": [{"path": "', "utf-8");
};

const taskDirNames = (): string[] => {
  try {
    return readdirSync(DATA_DIR);
  } catch {
    return [];
  }
};

type ErrBody = { error?: string; code?: string; task?: { repoPaths?: string[] } };

const post = async (body: unknown) => {
  const res = await POST(
    new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as ErrBody };
};

const patch = async (id: string, body: unknown) => {
  const res = await PATCH(
    new Request(`http://localhost/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: (await res.json()) as ErrBody };
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  createTaskOverride.fn = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  // boot recovery 末尾会后台起一次「旧 tool-output 迁移 / tmp 清扫」，收尾时它可能还在往任务目录里写东西：
  // 目录刚被删一半又冒出新文件 → rmdir ENOTEMPTY（满载并行时偶发）。带重试，别让清理的竞态把整个文件判红
  await fs.rm(TMP_ROOT, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("POST /api/tasks：config 读不出来 → 503 + settings_unreadable（R1-16）", () => {
  it("task 模式：503、code=settings_unreadable、error 是给人看的中文（不是内部码），且没建出任务目录", async () => {
    writeBrokenConfig();
    const before = taskDirNames();
    const { status, body } = await post({ title: "t", mode: "task", workRole: "fe", repoPaths: [REPO_A] });
    expect(status).toBe(503);
    expect(body.code).toBe("settings_unreadable");
    expect(body.error).toMatch(/读取设置/);
    expect(body.error).toMatch(/config\.json/);
    expect(body.error).not.toBe("create_failed");
    expect(body.error).not.toBe("settings_unreadable");
    expect(taskDirNames()).toEqual(before);
  });

  it("读得到配置 → 正常 201（对照：不是路由把所有请求都打成 503）", async () => {
    writeGoodConfig();
    const { status, body } = await post({ title: "t", mode: "task", workRole: "fe", repoPaths: [REPO_A] });
    expect(status).toBe(201);
    expect(body.error).toBeUndefined();
  });

  it("别的 createTask 失败仍是原来的 500 create_failed（不被新分支吞掉）", async () => {
    createTaskOverride.fn = () => Promise.reject(new Error("磁盘满了"));
    const { status, body } = await post({ title: "t", mode: "task", workRole: "fe", repoPaths: [REPO_A] });
    expect(status).toBe(500);
    expect(body).toEqual({ error: "create_failed" });
  });
});

describe("PATCH /api/tasks/[id]：新增仓遇到 config 读不出来 → 503 + 可读文案（R1-15，路由现成的 TaskFieldUpdateError 映射）", () => {
  it("chat 任务选工作目录（setTaskRepoPaths）：503，repoPaths 不变", async () => {
    writeGoodConfig();
    const chat = await createTask({ title: "聊天", mode: "chat", repoPaths: [] });
    writeBrokenConfig();
    const { status, body } = await patch(chat.id, { repoPaths: [REPO_A] });
    expect(status).toBe(503);
    expect(body.error).toMatch(/读取设置/);
    expect(body.error).toMatch(/新增的仓库/);
    expect((await getTask(chat.id))?.repoPaths).toEqual([]);
  });

  it("task 模式整份替换（updateTaskFields）：503，repoPaths 不变", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "需求", mode: "task", workRole: "fe", repoPaths: [REPO_A] });
    writeBrokenConfig();
    const { status, body } = await patch(task.id, { repoPaths: [REPO_A, REPO_B] });
    expect(status).toBe(503);
    expect(body.error).toMatch(/读取设置/);
    expect((await getTask(task.id))?.repoPaths).toEqual([REPO_A]);
  });

  it("对照：config 读得到时同样的 PATCH 照常 200", async () => {
    writeGoodConfig();
    const task = await createTask({ title: "需求", mode: "task", workRole: "fe", repoPaths: [REPO_A] });
    const { status, body } = await patch(task.id, { repoPaths: [REPO_A, REPO_B] });
    expect(status).toBe(200);
    expect(body.task?.repoPaths).toEqual([REPO_A, REPO_B]);
  });
});
