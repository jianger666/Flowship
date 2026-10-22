/**
 * 第三轮 D1-03：任务绑定的自定义提供方被删除后，不能静默改走 Cursor。
 * 纯函数 + prepareRunArgs 行为 + 服务端起会话的拦截（真读 settings 桩）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DANGLING_TASK_PROVIDER_MESSAGE,
  countTasksBoundToProvider,
  isTaskProviderDangling,
  resolveTaskProvider,
  resolveTaskProviderForPicker,
} from "@/lib/agent-provider";
import { CURSOR_PROVIDER_ID } from "@/lib/types";

const cp = (id: string, baseUrl = "https://gw.example.com/v1") => ({
  id,
  name: id,
  baseUrl,
  apiKey: "k",
  format: "openai" as const,
});

describe("isTaskProviderDangling", () => {
  it("绑定的条目已删除 → 悬空；还在 / 地址被清空 / cursor / 没绑 → 不算", () => {
    const settings = { customProviders: [cp("cp_a"), cp("cp_draft", "")] };
    expect(isTaskProviderDangling({ provider: "cp_gone" }, settings)).toBe(true);
    expect(isTaskProviderDangling({ provider: "cp_a" }, settings)).toBe(false);
    // 地址被清空：条目还在，走凭据校验的明确报错，不算悬空
    expect(isTaskProviderDangling({ provider: "cp_draft" }, settings)).toBe(false);
    expect(isTaskProviderDangling({ provider: CURSOR_PROVIDER_ID }, settings)).toBe(false);
    expect(isTaskProviderDangling({}, settings)).toBe(false);
    expect(isTaskProviderDangling({ provider: "" }, settings)).toBe(false);
  });

  it("「删了重加」（新 id）→ 旧 id 悬空", () => {
    expect(isTaskProviderDangling({ provider: "cp_old" }, { customProviders: [cp("cp_new")] })).toBe(
      true,
    );
  });

  it("老值 custom：有可用自定义条目就不算悬空", () => {
    expect(isTaskProviderDangling({ provider: "custom" }, { customProviders: [cp("cp_a")] })).toBe(
      false,
    );
    expect(isTaskProviderDangling({ provider: "custom" }, { customProviders: [] })).toBe(true);
  });
});

describe("resolveTaskProviderForPicker", () => {
  it("悬空时给出悬空 id（下拉里选任意一家都是「换了值」），否则同 resolveTaskProvider", () => {
    const settings = { customProviders: [cp("cp_a")] };
    expect(resolveTaskProviderForPicker({ provider: "cp_gone" }, settings)).toBe("cp_gone");
    // 对照：resolveTaskProvider 落回 cursor——用户再选 cursor 等于没变，永远摆脱不掉悬空绑定
    expect(resolveTaskProvider({ provider: "cp_gone" }, settings)).toBe(CURSOR_PROVIDER_ID);
    expect(resolveTaskProviderForPicker({ provider: "cp_a" }, settings)).toBe("cp_a");
    expect(resolveTaskProviderForPicker({}, settings)).toBe(CURSOR_PROVIDER_ID);
  });
});

describe("countTasksBoundToProvider", () => {
  it("只数绑定该 id 的任务", () => {
    expect(
      countTasksBoundToProvider(
        [{ provider: "cp_a" }, { provider: "cp_a" }, { provider: "cp_b" }, {}],
        "cp_a",
      ),
    ).toBe(2);
    expect(countTasksBoundToProvider([], "cp_a")).toBe(0);
  });
});

describe("prepareRunArgs 拦悬空绑定", () => {
  const toastError = vi.fn();
  const state = {
    loaded: true,
    settings: {
      apiKey: "cursor-key",
      defaultModel: { id: "composer-2.5" },
      customProviders: [] as ReturnType<typeof cp>[],
    },
  };
  beforeEach(() => {
    toastError.mockClear();
    state.loaded = true;
    state.settings.customProviders = [];
    vi.resetModules();
    vi.doMock("sonner", () => ({ toast: { error: toastError } }));
    // settings-link 是 .tsx（jsx: preserve 下 vitest 解析不了），run-args 只用到 settingsUrl
    vi.doMock("@/lib/settings-link", () => ({ settingsUrl: () => "/settings" }));
    vi.doMock("@/lib/local-store", () => ({
      getSettings: () => state.settings,
      isSettingsLoaded: () => state.loaded,
    }));
  });

  const task = (provider?: string) =>
    ({ id: "t1", provider, model: { id: "gpt-4o" } }) as never;

  it("绑定的条目已删除 → 返回 null 并 toast，不拿 Cursor key 悄悄跑", async () => {
    const { prepareRunArgs } = await import("@/lib/run-args");
    expect(prepareRunArgs(task("cp_gone"))).toBeNull();
    expect(toastError).toHaveBeenCalledWith(DANGLING_TASK_PROVIDER_MESSAGE);
  });

  it("配置没加载成功时不判「已删除」（空列表只是默认值）", async () => {
    state.loaded = false;
    const { prepareRunArgs } = await import("@/lib/run-args");
    prepareRunArgs(task("cp_gone"));
    expect(toastError).not.toHaveBeenCalledWith(DANGLING_TASK_PROVIDER_MESSAGE);
  });

  it("条目还在 → 正常放行", async () => {
    state.settings.customProviders = [cp("cp_a")];
    const { prepareRunArgs } = await import("@/lib/run-args");
    const args = prepareRunArgs(task("cp_a"));
    expect(args).not.toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("服务端起会话拦悬空绑定", () => {
  it("resolveProviderIdForCreate：悬空 → 抛明确错误；正常 → 返回 id；配置读不出来 → 不误判", async () => {
    vi.resetModules();
    const read = vi.fn();
    vi.doMock("@/lib/server/settings-fs", () => ({ readSettingsFile: read }));
    const { resolveProviderIdForCreate } = await import("@/lib/server/agent-backend");

    read.mockResolvedValue({
      status: "ok",
      settings: { customProviders: [cp("cp_a")] },
    });
    await expect(resolveProviderIdForCreate({ provider: "cp_gone" })).rejects.toThrow(
      DANGLING_TASK_PROVIDER_MESSAGE,
    );
    await expect(resolveProviderIdForCreate({ provider: "cp_a" })).resolves.toBe("cp_a");
    await expect(resolveProviderIdForCreate({})).resolves.toBe(CURSOR_PROVIDER_ID);

    read.mockResolvedValue({ status: "unreadable" });
    await expect(resolveProviderIdForCreate({ provider: "cp_gone" })).resolves.toBe(
      CURSOR_PROVIDER_ID,
    );
  });

  it("chat-runner / task-runner 起新会话前都调了拦截", () => {
    const chat = readFileSync(
      path.join(process.cwd(), "src/lib/server/chat-runner.ts"),
      "utf8",
    );
    expect(chat).toMatch(
      /settingsResult\.status === "ok" &&\s*isTaskProviderDangling\(task, providerSettings\)\s*\)\s*\{\s*throw new Error\(DANGLING_TASK_PROVIDER_MESSAGE\)/,
    );
    const taskRunner = readFileSync(
      path.join(process.cwd(), "src/lib/server/task-runner.ts"),
      "utf8",
    );
    expect(taskRunner).toMatch(/await resolveProviderIdForCreate\(task\)/);
  });
});

describe("D1-09：眼睛键有可访问名", () => {
  const read = (rel: string) =>
    readFileSync(path.join(process.cwd(), rel), "utf8");
  it("Git token / provider key 的显示开关有 aria-label + aria-pressed", () => {
    for (const f of [
      "src/components/settings/git-card.tsx",
      "src/components/settings/custom-provider-card.tsx",
    ]) {
      const src = read(f);
      expect(src).toMatch(/aria-label=\{show(Token|Key) \? "隐藏/);
      expect(src).toMatch(/aria-pressed=\{show(Token|Key)\}/);
    }
  });
});
