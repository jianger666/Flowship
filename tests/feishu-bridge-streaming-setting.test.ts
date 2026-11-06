/**
 * 飞书「流式回复」全局开关（2026-11-06 加回；2026-08-27 v1.9.4 曾撤掉、恒开；同日起群答疑回复也跟它走）。
 *
 * 钉死的语义：
 * - 读取（isFeishuBridgeStreamingEnabled）：缺省 / 读不到 / 损坏 / 读盘抛错 → 开；显式 false → 关；脏值按开
 * - 设置页链路：DEFAULT_SETTINGS / normalizeSettings 默认开、isFieldEqual 按 boolTrue 比较、
 *   KNOWN_SETTINGS_KEYS 登记（looksLikeSettings 认得只带这一个键的对象）、PATCH 字段级保存落盘，随后现读即生效
 * - 设置页真渲染：桥接开着时出现「流式回复」一行，开关状态跟着 prop 走；桥接关着不渲染
 * - 页面 → FeishuCliSection → FeishuBridgeBlock 三层把 feishuBridgeStreaming 接通（源码契约）
 *
 * 出向「每轮读一次 / false 时整卡一次性发」的行为：私聊由 feishu-bridge-outbound.test.ts 覆盖，
 * 群答疑回复（含任务级覆盖）由 group-outbound-reply.test.ts 覆盖，这里不重复。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ROOT = path.join(os.tmpdir(), `fe-bridge-streaming-setting-${Date.now()}`);
process.env.FLOWSHIP_DATA_DIR = TMP_ROOT;

vi.mock("@/lib/server/git-token-env", () => ({ syncGitTokenEnv: vi.fn() }));
vi.mock("@/lib/server/gitlab-host", () => ({
  pinTrustedGitHostFromSettings: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/mr-inbox-scanner", () => ({
  invalidateMrInboxCache: vi.fn(),
}));
vi.mock("@/lib/server/agent-shell", () => ({
  applyAgentShellPreference: vi.fn(async () => undefined),
}));
vi.mock("@/lib/server/company-env-fs", () => ({
  syncCompanyEnvFileFromObject: vi.fn(async () => undefined),
}));

import { PATCH } from "@/app/api/settings/route";
import { FeishuBridgeBlock } from "@/components/settings/feishu-bridge-block";
import { isFieldEqual } from "@/hooks/use-settings";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/local-store";
import { isFeishuBridgeStreamingEnabled } from "@/lib/server/feishu-bridge/bridge-config";
import { looksLikeSettings, settingsFilePath } from "@/lib/server/settings-fs";

const BASE = { apiKey: "", defaultModel: { id: "" }, repos: [] };
const write = (extra: Record<string, unknown> = {}) =>
  fs.writeFile(settingsFilePath(), JSON.stringify({ ...BASE, ...extra }), "utf-8");
const readDisk = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(settingsFilePath(), "utf-8")) as Record<string, unknown>;

beforeEach(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
  await fs.mkdir(TMP_ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});

describe("读取：isFeishuBridgeStreamingEnabled", () => {
  it("没有设置文件 / 缺省字段 → 开（默认）", async () => {
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
    await write();
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
  });

  it("显式 true → 开；显式 false → 关；脏值（字符串 \"false\"、0）按开——只认显式 false 才关", async () => {
    await write({ feishuBridgeStreaming: true });
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
    await write({ feishuBridgeStreaming: false });
    expect(await isFeishuBridgeStreamingEnabled()).toBe(false);
    await write({ feishuBridgeStreaming: "false" });
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
    await write({ feishuBridgeStreaming: 0 });
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
  });

  it("设置文件损坏 → 开，不抛", async () => {
    await fs.writeFile(settingsFilePath(), "{ not json", "utf-8");
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
  });

  it("读设置**直接抛错**（不是 status 非 ok）→ 开，不往外抛（外抛会让 ensureCardStarted 整张卡建不起来）", async () => {
    vi.resetModules();
    vi.doMock("@/lib/server/settings-fs", () => ({
      readSettingsFile: async () => {
        throw new Error("EIO: simulated disk failure");
      },
    }));
    try {
      const fresh = await import("@/lib/server/feishu-bridge/bridge-config");
      expect(await fresh.isFeishuBridgeStreamingEnabled()).toBe(true);
    } finally {
      vi.doUnmock("@/lib/server/settings-fs");
      vi.resetModules();
    }
  });

  it("与其它桥接开关互不串线：关流式不影响桥接 / 防休眠的读取", async () => {
    await write({ feishuBridgeStreaming: false, feishuChatBridge: true });
    const cfg = await import("@/lib/server/feishu-bridge/bridge-config");
    expect(await cfg.isFeishuBridgeStreamingEnabled()).toBe(false);
    expect(await cfg.isFeishuChatBridgeEnabled()).toBe(true);
    expect(await cfg.isFeishuBridgeKeepAwakeEnabled()).toBe(true);
  });
});

describe("设置页链路", () => {
  it("normalizeSettings / DEFAULT_SETTINGS：默认开；只有显式 false 才关", () => {
    expect(DEFAULT_SETTINGS.feishuBridgeStreaming).toBe(true);
    expect(normalizeSettings({}).feishuBridgeStreaming).toBe(true);
    expect(normalizeSettings(null).feishuBridgeStreaming).toBe(true);
    expect(normalizeSettings({ feishuBridgeStreaming: false }).feishuBridgeStreaming).toBe(false);
    expect(
      normalizeSettings({ feishuBridgeStreaming: "false" as unknown as boolean })
        .feishuBridgeStreaming,
    ).toBe(true);
  });

  it("isFieldEqual（有未保存改动）：缺省 ≡ true（boolTrue），与 false 不等", () => {
    const base = { apiKey: "", defaultModel: { id: "" }, repos: [] } as never;
    const on = { ...(base as object), feishuBridgeStreaming: true } as never;
    const off = { ...(base as object), feishuBridgeStreaming: false } as never;
    expect(isFieldEqual("feishuBridgeStreaming", base, on)).toBe(true);
    expect(isFieldEqual("feishuBridgeStreaming", base, base)).toBe(true);
    expect(isFieldEqual("feishuBridgeStreaming", base, off)).toBe(false);
    expect(isFieldEqual("feishuBridgeStreaming", on, off)).toBe(false);
  });

  it("KNOWN_SETTINGS_KEYS 登记过：只带这一个键的对象也被认作设置（PATCH 路径靠已有字段兜底，靠不到这条，所以单独钉）", () => {
    expect(looksLikeSettings({ feishuBridgeStreaming: false })).toBe(true);
    expect(looksLikeSettings({ somethingElse: false })).toBe(false);
  });

  it("PATCH 字段级保存并落盘，随后现读即生效；再切回开", async () => {
    await write();
    const patch = (value: boolean) =>
      PATCH(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: { feishuBridgeStreaming: value } }),
        }),
      );
    expect((await patch(false)).status).toBe(200);
    expect((await readDisk()).feishuBridgeStreaming).toBe(false);
    expect(await isFeishuBridgeStreamingEnabled()).toBe(false);
    expect((await patch(true)).status).toBe(200);
    expect((await readDisk()).feishuBridgeStreaming).toBe(true);
    expect(await isFeishuBridgeStreamingEnabled()).toBe(true);
  });
});

describe("设置页真渲染：FeishuBridgeBlock", () => {
  const render = (props: { bridge: boolean; streaming: boolean }) =>
    renderToStaticMarkup(
      createElement(FeishuBridgeBlock, {
        feishuChatBridge: props.bridge,
        onFeishuChatBridgeChange: vi.fn(),
        feishuBridgeStreaming: props.streaming,
        onFeishuBridgeStreamingChange: vi.fn(),
        feishuGroupNonOwnerGuard: true,
        onFeishuGroupNonOwnerGuardChange: vi.fn(),
        feishuGroupBotsEqualRights: false,
        onFeishuGroupBotsEqualRightsChange: vi.fn(),
      }),
    );

  /** 取「流式回复」那一行（到下一个 SettingRow 标签为止）里 switch 的选中状态 */
  const streamingRow = (html: string): string => {
    const at = html.indexOf("流式回复");
    expect(at).toBeGreaterThan(-1);
    const end = html.indexOf("限制群里非宿主成员", at);
    expect(end).toBeGreaterThan(at);
    return html.slice(at, end);
  };

  it("桥接开着：出现「流式回复」一行，说明对飞书回复生效、并指出群里可按任务单独改，且排在群相关开关之前", () => {
    const html = render({ bridge: true, streaming: true });
    const row = streamingRow(html);
    expect(row).toContain("边写边出现");
    expect(row).toContain("「需求群」弹窗里单独改");
    // 旧文案（群里不受影响）已不成立：群答疑回复现在也流式
    expect(row).not.toContain("群里的回复不受影响");
  });

  it("开关状态跟着 prop 走：开 → checked，关 → unchecked", () => {
    const on = streamingRow(render({ bridge: true, streaming: true }));
    const off = streamingRow(render({ bridge: true, streaming: false }));
    expect(on).not.toBe(off);
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain('aria-checked="false"');
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('aria-checked="true"');
  });

  it("桥接关着：整块展开区（含流式回复）不渲染", () => {
    expect(render({ bridge: false, streaming: true })).not.toContain("流式回复");
  });
});

describe("三层接线（源码契约）", () => {
  const read = (rel: string) => fs.readFile(path.join(process.cwd(), rel), "utf-8");

  it("settings 页：prop 读 !== false（缺省开），变更走 saveFieldValue 立即落盘", async () => {
    const src = await read("src/app/settings/page.tsx");
    expect(src).toContain("feishuBridgeStreaming={settings.feishuBridgeStreaming !== false}");
    expect(src).toMatch(
      /onFeishuBridgeStreamingChange=\{\(v\) =>\s*saveFieldValue\("feishuBridgeStreaming", v\)/,
    );
  });

  it("FeishuCliSection 把两个 prop 原样转给 FeishuBridgeBlock", async () => {
    const src = await read("src/components/settings/feishu-cli-card.tsx");
    expect(src).toContain("feishuBridgeStreaming={feishuBridgeStreaming}");
    expect(src).toContain("onFeishuBridgeStreamingChange={onFeishuBridgeStreamingChange}");
  });

  it("outbound 仍是「每轮首次建卡读一次」——读取源是 bridge-config 里的这个函数", async () => {
    const src = await read("src/lib/server/feishu-bridge/outbound.ts");
    expect(src).toMatch(/turn\.streaming = await isFeishuBridgeStreamingEnabled\(\)/);
  });
});
