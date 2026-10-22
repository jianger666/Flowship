/**
 * 启动表单「目标仓库」区在设置读取失败时的口径（第二轮 review V11-04）
 *
 * 旧行为：task-launch-form 在 `await initSettings()` 之后无条件 `getSettings()` 预填——init 失败时拿到的是
 * 默认值（repos = []），于是对用户说反话「还没配置仓库——去设置页添加」，而且永不重试。
 * 现在：读取失败显示「设置读取失败 + 重试」，「还没配置仓库」只在**确认读到真实配置且仓库为空**时才出现。
 *
 * 分两层（项目没有 jsdom，组件渲染跑不起来，所以：纯函数 + 源码接线契约；未在浏览器里看过实际渲染）：
 *   A. 纯函数 launchSettingsPhase / resolveLaunchReposView / describeLaunchSettingsFailure
 *   B. task-launch-form 接线契约
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  describeLaunchSettingsFailure,
  launchSettingsPhase,
  resolveLaunchReposView,
} from "@/lib/launch-repos-state";

const read = (rel: string): string =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("A. 纯函数", () => {
  it("launchSettingsPhase：init 读到真实配置才算 ready，否则 failed", () => {
    expect(launchSettingsPhase(true)).toBe("ready");
    expect(launchSettingsPhase(false)).toBe("failed");
  });

  it("resolveLaunchReposView：init 在途 → loading（不能先闪一下「还没配置仓库」）", () => {
    expect(resolveLaunchReposView({ phase: "loading", repoCount: 0 })).toBe("loading");
    // 在途时哪怕缓存里已有仓库也等 init 结束再画（缓存可能是上一次的）
    expect(resolveLaunchReposView({ phase: "loading", repoCount: 3 })).toBe("loading");
  });

  it("resolveLaunchReposView：读取失败 → failed，哪怕仓库数是 0（默认值里的 0 不是用户的配置）", () => {
    expect(resolveLaunchReposView({ phase: "failed", repoCount: 0 })).toBe("failed");
    expect(resolveLaunchReposView({ phase: "failed", repoCount: 2 })).toBe("failed");
  });

  it("resolveLaunchReposView：读到真实配置 → 有仓库画选择器，没有才是「还没配置仓库」", () => {
    expect(resolveLaunchReposView({ phase: "ready", repoCount: 2 })).toBe("picker");
    expect(resolveLaunchReposView({ phase: "ready", repoCount: 0 })).toBe("empty");
  });

  it("describeLaunchSettingsFailure：说清读取失败 + 怎么办，且不说「还没配置仓库」", () => {
    for (const unreadable of [false, true]) {
      const t = describeLaunchSettingsFailure(unreadable);
      expect(t.message).toContain("重试");
      expect(t.message).not.toContain("还没配置");
      expect(t.message).not.toContain("去设置页添加");
    }
  });

  it("describeLaunchSettingsFailure：config.json 不可读才给「去设置页查看」入口（重试不一定能好、要去看修复指引）", () => {
    expect(describeLaunchSettingsFailure(true).showSettingsLink).toBe(true);
    expect(describeLaunchSettingsFailure(true).message).toContain("config.json");
    expect(describeLaunchSettingsFailure(false).showSettingsLink).toBe(false);
  });
});

describe("B. 接线契约：task-launch-form（没有 DOM 环境，未在浏览器里看过实际渲染）", () => {
  const form = read("src/components/tasks/task-launch-form.tsx");

  it("init 之后先问 isSettingsLoaded()，没读到真实配置就不用 getSettings() 预填", () => {
    const apply = form.slice(
      form.indexOf("const applyLoadedSettings"),
      form.indexOf("// initialTitle 异步到位"),
    );
    expect(apply.length).toBeGreaterThan(0);
    const iLoaded = apply.indexOf("isSettingsLoaded()");
    const iGet = apply.indexOf("getSettings()");
    expect(iLoaded).toBeGreaterThan(-1);
    expect(iGet).toBeGreaterThan(iLoaded);
    expect(apply).toMatch(/if \(!loaded\) return;/);
    // mount 与重试共用同一个落地函数，不各写一份
    expect(form).toContain("applyLoadedSettings(() => alive)");
    expect(form).toContain("applyLoadedSettings(() => mountedRef.current)");
  });

  it("「重试」重新 initSettings（失败会清空单飞 promise、会真的重发请求），在途时防连点", () => {
    const retry = form.slice(
      form.indexOf("const handleRetrySettings"),
      form.indexOf("// initialTitle 异步到位"),
    );
    expect(retry).toContain("await initSettings()");
    expect(retry).toContain("if (retryingSettings) return;");
    expect(retry).toContain("setRetryingSettings(true)");
    expect(form).toMatch(/disabled=\{retryingSettings\}/);
  });

  it("目标仓库区走 resolveLaunchReposView 四态；「还没配置仓库」只出现在 empty 分支", () => {
    expect(form).toContain("resolveLaunchReposView(");
    expect(form).toContain('reposView === "failed"');
    expect(form).toContain('reposView === "loading"');
    expect(form).toContain('reposView === "picker"');
    // 面向用户的 JSX 文案（带破折号那一句）恰好出现一次，且在 picker 之后的最后一个分支里
    // （注释里的「还没配置仓库」引用不带破折号、不算）
    const hits = form.split("还没配置仓库——").length - 1;
    expect(hits).toBe(1);
    expect(form.indexOf("还没配置仓库——")).toBeGreaterThan(form.indexOf('reposView === "picker"'));
    // 旧的「repos.length > 0 ? 选择器 : 空态」二元判断已删
    expect(form).not.toMatch(/\{repos\.length > 0 \? \(\s*<MultiSelect/);
  });

  it("读取失败时点「启动」直接拦下并指路，不拿默认值去校验 / 建任务", () => {
    const at = form.indexOf("const handleLaunch");
    expect(at).toBeGreaterThan(-1);
    const head = form.slice(at, at + 900);
    expect(head).toContain('settingsPhase === "failed"');
    expect(head.indexOf('settingsPhase === "failed"')).toBeLessThan(
      head.indexOf("collectLaunchErrors()"),
    );
  });
});
