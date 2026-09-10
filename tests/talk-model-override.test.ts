/**
 * 说话条粘住覆盖：切提供方必须清掉旧覆盖（review 拦截项）。
 *
 * 回归场景：用户在任务里手动选了 Cursor 模型（覆盖粘住）→ 切提供方到另一家 →
 * 不清的话说话条还显示旧覆盖，forceModel 拿上一家的模型 id 往新提供方发，
 * 正好踩中“模型不许串家”红线。两个切换入口与说话条签名 effect 共用同一份 clear。
 */
import { describe, expect, it, beforeEach } from "vitest";

// 最小浏览器环境（node runner 无 window，跟 settings-save.test.ts 同款 stub）
const localStorageStub = {
  store: new Map<string, string>(),
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  },
  removeItem(key: string): void {
    this.store.delete(key);
  },
};
(globalThis as unknown as { window: unknown }).window = {
  localStorage: localStorageStub,
};

import {
  clearTalkOverride,
  loadTalkOverride,
  saveTalkOverride,
  talkOverrideKey,
} from "@/lib/talk-model-override";

beforeEach(() => {
  localStorageStub.store.clear();
});

describe("talk-model-override", () => {
  it("key 按任务隔离且格式稳定", () => {
    expect(talkOverrideKey("t_1")).toBe("flowship:talk-model-override:t_1");
    expect(talkOverrideKey("t_2")).toBe("flowship:talk-model-override:t_2");
  });

  it("存了能读出来（含 params）", () => {
    saveTalkOverride("t_1", {
      id: "gemini-3.8-flash",
      params: [{ id: "effort", value: "high" }],
    });
    expect(loadTalkOverride("t_1")).toEqual({
      id: "gemini-3.8-flash",
      params: [{ id: "effort", value: "high" }],
    });
    // 按任务隔离
    expect(loadTalkOverride("t_2")).toBeNull();
  });

  it("切提供方清覆盖：清完读回 null，下条用新会话模型", () => {
    saveTalkOverride("t_1", { id: "composer-2.5" });
    expect(loadTalkOverride("t_1")).not.toBeNull();
    clearTalkOverride("t_1");
    expect(loadTalkOverride("t_1")).toBeNull();
  });

  it("脏数据不炸：坏 JSON / 空 id 都按无覆盖处理", () => {
    localStorageStub.store.set(talkOverrideKey("t_1"), "not-json{{{");
    expect(loadTalkOverride("t_1")).toBeNull();
    saveTalkOverride("t_1", { id: "   " });
    expect(loadTalkOverride("t_1")).toBeNull();
  });
});
