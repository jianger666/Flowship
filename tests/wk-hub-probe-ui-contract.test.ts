/**
 * 设置页「Delivery Hub」探测状态的接线契约
 *
 * 锁的是「状态点说的地址 = 输入框里的地址」。线上那条 bug 长在回滚路径上：
 * 地址格式非法时草稿被打回落盘真值，但 `savedHubUrl` 没变 → 自动探测的 effect 不重跑，
 * 于是刚才对着非法草稿点「测试」探出的 `invalid-url` 一直挂着——红点说「地址格式不对」、
 * 输入框里却已经是那个好好的落盘地址了。
 *
 * 两道保险都要在：① 结论连地址一起存、只显示跟当前草稿对得上的那条；② 回滚时补探一次。
 *
 * UI 组件在 node 环境跑不起来（见 vitest.config.ts），所以走源码契约。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const card = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "src",
    "components",
    "settings",
    "wk-harness-card.tsx",
  ),
  "utf-8",
);

describe("探测结论跟地址绑定", () => {
  it("结论连「探的是哪个地址」一起存", () => {
    expect(card).toContain("WkHubProbeResult & { url: string }");
    // 三个 setProbe 分支（成功 / HTTP 非 2xx / fetch 抛）都要带上地址
    expect(card.match(/url: baseUrl/g) ?? []).toHaveLength(3);
  });

  it("只渲染跟当前草稿对得上的那条结论", () => {
    expect(card).toContain("const shownProbe = probe?.url === draftHubUrl");
    // 渲染处认 shownProbe、不再直接吃 probe
    expect(card).toContain("PROBE_DOT[shownProbe.status]");
    expect(card).not.toContain("PROBE_DOT[probe.status]");
  });
});

describe("非法地址回滚", () => {
  it("打回落盘值后补探一次（savedHubUrl 没变、自动探那个 effect 不会重跑）", () => {
    const idx = card.indexOf("Delivery Hub 地址格式不对");
    expect(idx).toBeGreaterThan(0);
    const branch = card.slice(idx, idx + 500);
    expect(branch).toContain('update("hubBaseUrl", saved.hubBaseUrl)');
    expect(branch).toContain("runProbe(saved.hubBaseUrl)");
    // 落盘地址本来就是空的（没配过）→ 没什么可探的，直接收状态
    expect(branch).toContain("setProbe(null)");
  });
});

/**
 * 2026-07-28 用户拍板砍掉「运行前拉取最新产物 / 产物变更推回」两个开关
 * （「这是理应开启的」）——写盘那层固定 true，UI 上不能再冒出来。
 * 一起锁住两行的名字：这两个 label 在门禁提示里被引用（「设置页 → 团队 wk 流程」），
 * 改名要连提示一起改。
 */
describe("这一节只剩两行", () => {
  it("两个开关连同联动逻辑都没了", () => {
    expect(card).not.toContain("<Switch");
    expect(card).not.toContain("requireBaseline");
    expect(card).not.toContain("requireSync");
    expect(card).not.toContain("hubSwitchDisabled");
    expect(card).not.toContain("hubSwitchHint");
  });

  it("行名是 WK产出目录 + Delivery Hub", () => {
    expect(card).toContain('label="WK产出目录"');
    expect(card).toContain('label="Delivery Hub"');
  });

  it("Hub 输入框拿 DEFAULT_HUB_BASE_URL 当 placeholder（真值由服务端播种）", () => {
    expect(card).toContain("placeholder={DEFAULT_HUB_BASE_URL}");
  });
});
