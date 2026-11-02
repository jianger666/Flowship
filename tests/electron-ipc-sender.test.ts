/**
 * IPC 发送方校验（评审 P2：11 个 IPC 入口都不看 senderFrame，渲染端一旦被注入 / 嵌进别的 origin，
 * 就能直接调 open-external / native-pick / install-update 等壳能力）。
 *
 * - isTrustedIpcSender 切源码真实执行：只有 frame URL 是本应用精确 origin 才放行，拿不到 frame 一律不放行
 * - 接线契约：main.js 里**每一个** ipcMain 入口的第一件事都是过这道闸，且形参名与闸里引用的 `e` 对得上
 *   （脚手架早期踩过：形参还叫 `_e` 而闸里写 `e`，运行时 ReferenceError、node --check / 单测都发现不了）
 */
import { describe, expect, it } from "vitest";

import { isCanonicalAppOrigin } from "../electron-app/external-url.mjs";
import { instantiate, mainSrc } from "./helpers/main-slice";

const HOST = "127.0.0.1";
const PORT = 8876;

const build = () => {
  const logs: string[] = [];
  const fn = instantiate<(e: unknown, channel: string) => boolean>(
    "isTrustedIpcSender",
    {
      log: (m: string) => logs.push(m),
      isCanonicalAppUrl: (url: string) => isCanonicalAppOrigin(url, { host: HOST, port: PORT }),
    },
  );
  return { fn, logs };
};

describe("isTrustedIpcSender", () => {
  it("本应用精确 origin 的页面 → 放行（含路径 / query）", () => {
    const { fn, logs } = build();
    expect(fn({ senderFrame: { url: `http://${HOST}:${PORT}/` } }, "x")).toBe(true);
    expect(fn({ senderFrame: { url: `http://${HOST}:${PORT}/tasks/t_1?tab=chat` } }, "x")).toBe(true);
    expect(logs).toEqual([]);
  });

  it("别的 origin / 前缀欺骗 / 回环别名 / 非 http → 拒绝并记一行日志（URL 只留前 80 字符）", () => {
    const { fn, logs } = build();
    for (const url of [
      "https://evil.example/",
      `http://${HOST}:${PORT}@evil.example/`,
      `http://${HOST}:${PORT + 1}/`,
      `http://localhost:${PORT}/`,
      `file:///etc/passwd`,
      "chrome-error://chromewebdata/",
      "data:text/html,<script>1</script>",
    ]) {
      expect(fn({ senderFrame: { url } }, "open-external"), url).toBe(false);
    }
    expect(logs.length).toBe(7);
    expect(logs.every((l) => l.includes("channel=open-external"))).toBe(true);
    const long = `https://evil.example/${"a".repeat(500)}`;
    fn({ senderFrame: { url: long } }, "x");
    expect(logs.at(-1)!.length).toBeLessThan(200);
  });

  it("拿不到 senderFrame（frame 已销毁 / 已导航）或访问 url 抛错 → 不信任", () => {
    const { fn } = build();
    expect(fn({}, "x")).toBe(false);
    expect(fn({ senderFrame: null }, "x")).toBe(false);
    expect(fn(undefined, "x")).toBe(false);
    expect(
      fn(
        {
          get senderFrame() {
            throw new Error("Render frame was disposed");
          },
        },
        "x",
      ),
    ).toBe(false);
  });
});

describe("接线：每个 IPC 入口都先过 isTrustedIpcSender", () => {
  // 所有 `ipcMain.on|handle(` 注册 + close 确认回复的具名监听
  const entries = [
    ...mainSrc.matchAll(
      /ipcMain\.(on|handle)\("([^"]+)", (?:async )?\(([^)]*)\) => (\{\n)?([^\n]*)\n?([^\n]*)/g,
    ),
  ];

  it("入口清单覆盖已知的 13 个（新增 IPC 时这里会提醒补闸）", () => {
    const channels = entries.map((m) => m[2]).sort();
    expect(channels).toEqual(
      [
        "app-content-ready",
        "auto-launch-get",
        "auto-launch-set",
        "check-for-update",
        "get-update-state",
        "inbox:set-badge",
        "install-update",
        "menu-bar-icon-get",
        "menu-bar-icon-set",
        "native-pick",
        "open-external",
        "set-titlebar-overlay",
        "task-notify",
      ].sort(),
    );
  });

  for (const m of entries) {
    const [, kind, channel, params, , line1, line2] = m;
    it(`${kind} ${channel}：第一个形参叫 e、函数体第一条语句是闸`, () => {
      const first = params!.split(",")[0]!.trim();
      expect(first).toBe("e");
      expect(`${line1}\n${line2}`).toContain(`isTrustedIpcSender(e, "${channel}")`);
    });
  }

  it("close 确认回复不用 once（否则不可信调用会先消费掉监听、真正的页面回复丢失），可信回复才摘监听", () => {
    expect(mainSrc).not.toContain('ipcMain.once("app-close-confirm-result"');
    const start = mainSrc.indexOf("const onCloseConfirmResult = (e, confirmed) => {");
    expect(start).toBeGreaterThan(0);
    const body = mainSrc.slice(start, mainSrc.indexOf("ipcMain.on(\"app-close-confirm-result\", onCloseConfirmResult);", start));
    expect(body.indexOf('isTrustedIpcSender(e, "app-close-confirm-result")')).toBeLessThan(
      body.indexOf("removeListener"),
    );
  });
});
