/**
 * 内置浏览器工具（browser_*）在事件流工具块里的一行摘要。
 *
 * 钉住两件事：① 折叠行是人话（点击 e12 / 打开 host/path）而不是通用的 JSON；
 * ② 输入内容（可能是账号 / 口令）和 URL 的 query（可能带 token）不摊在事件流折叠行里。
 */
import { describe, expect, it } from "vitest";

import { browserToolSummary, isBrowserToolName } from "@/lib/browser-tool-display";
import { toolBlockSummary, type ToolBlock } from "@/lib/tool-display";

const block = (name: string, args: string | undefined) =>
  ({
    kind: "__tool_block__",
    id: "b1",
    callId: "c1",
    name,
    status: "completed",
    text: `调用 ${name}`,
    args,
  }) as unknown as ToolBlock;

describe("isBrowserToolName", () => {
  it("只认 browser_ 前缀（大小写不敏感）", () => {
    expect(isBrowserToolName("browser_click")).toBe(true);
    expect(isBrowserToolName("Browser_Snapshot")).toBe(true);
    expect(isBrowserToolName("browser")).toBe(false);
    expect(isBrowserToolName("shell")).toBe(false);
  });
});

describe("browserToolSummary", () => {
  it("navigate：URL 只留 host+path，去掉 query / hash（可能带 token）", () => {
    expect(
      browserToolSummary("browser_navigate", '{"url":"https://example.com/login?token=SECRET#x"}'),
    ).toBe("打开 example.com/login");
    expect(browserToolSummary("browser_navigate", '{"url":"https://example.com/"}')).toBe("打开 example.com");
    expect(browserToolSummary("browser_navigate", '{"action":"back"}')).toBe("后退");
    expect(browserToolSummary("browser_navigate", '{"action":"reload"}')).toBe("刷新");
  });

  it("click / hover：带 ref；双击与右键有各自的说法", () => {
    expect(browserToolSummary("browser_click", '{"ref":"e12"}')).toBe("点击 e12");
    // 工具入参是 snake_case（tools.ts schema：double_click）；camelCase 是老事件的回退写法
    expect(browserToolSummary("browser_click", '{"ref":"e12","double_click":true}')).toBe("双击 e12");
    expect(browserToolSummary("browser_click", '{"ref":"e12","doubleClick":true}')).toBe("双击 e12");
    expect(browserToolSummary("browser_click", '{"ref":"e12","button":"right"}')).toBe("右键点击 e12");
    expect(browserToolSummary("browser_hover", '{"ref":"e3"}')).toBe("悬停 e3");
  });

  it("type：只给字符数、绝不摊出原文（可能是账号 / 口令）", () => {
    const s = browserToolSummary("browser_type", '{"ref":"e5","text":"hunter2-secret","submit":true}');
    expect(s).toBe("在 e5 输入 14 个字符 并回车");
    expect(s).not.toContain("hunter2");
    expect(browserToolSummary("browser_type", '{"ref":"e5","text":""}')).toBe("在 e5 输入 清空");
    // 中文按字符数而不是 UTF-16 码元数
    expect(browserToolSummary("browser_type", '{"ref":"e5","text":"你好"}')).toBe("在 e5 输入 2 个字符");
  });

  it("scroll / select / drag / press_key / wait_for / tabs", () => {
    expect(browserToolSummary("browser_scroll", '{"direction":"down"}')).toBe("向下滚动");
    expect(browserToolSummary("browser_scroll", '{"direction":"top"}')).toBe("滚动到顶部");
    expect(browserToolSummary("browser_scroll", "{}")).toBe("滚动页面");
    expect(browserToolSummary("browser_scroll", '{"ref":"e9","direction":"down"}')).toBe("在 e9 内向下滚动");
    // E2·S4：滚动到元素（布尔或 {ref} 对象）/ 滚到内容稳定 / 标注截图
    expect(browserToolSummary("browser_scroll", '{"ref":"e9","scroll_into_view":true}')).toBe("滚动到 e9");
    expect(browserToolSummary("browser_scroll", '{"ref":"e9","scroll_into_view":{"ref":"e9"}}')).toBe("滚动到 e9");
    expect(browserToolSummary("browser_scroll", '{"until_stable":true}')).toBe("滚动到内容不再增加");
    expect(browserToolSummary("browser_scroll", '{"until_stable":{"max_steps":5}}')).toBe("滚动到内容不再增加");
    expect(browserToolSummary("browser_scroll", '{"until_stable":false,"direction":"down"}')).toBe("向下滚动");
    expect(browserToolSummary("browser_screenshot", '{"annotate":true}')).toBe("标注截图（ref 编号）");
    expect(browserToolSummary("browser_screenshot", '{"annotate":false,"full_page":true}')).toBe("整页截图");
    expect(browserToolSummary("browser_select", '{"ref":"e4","values":["a","b"]}')).toBe("在 e4 选择 2 项");
    // R1-20：真实入参是 snake_case（from_ref / to_ref）；旧测试用 camelCase，把错误固化了
    expect(browserToolSummary("browser_drag", '{"from_ref":"e1","to_ref":"e2"}')).toBe("拖拽 e1 → e2");
    expect(browserToolSummary("browser_drag", '{"fromRef":"e1","toRef":"e2"}')).toBe("拖拽 e1 → e2"); // camelCase 回退
    // 两种都给：snake_case 优先
    expect(browserToolSummary("browser_drag", '{"from_ref":"e1","to_ref":"e2","fromRef":"e8","toRef":"e9"}')).toBe("拖拽 e1 → e2");
    expect(browserToolSummary("browser_press_key", '{"key":"Control+a"}')).toBe("按键 Control+a");
    expect(browserToolSummary("browser_wait_for", '{"text":"登录成功"}')).toBe("等待出现「登录成功」");
    expect(browserToolSummary("browser_wait_for", '{"text_gone":"加载中"}')).toBe("等待消失「加载中」");
    expect(browserToolSummary("browser_wait_for", '{"textGone":"加载中"}')).toBe("等待消失「加载中」"); // camelCase 回退
    expect(browserToolSummary("browser_wait_for", '{"time_ms":2500}')).toBe("等待 2.5 秒");
    expect(browserToolSummary("browser_wait_for", '{"time_ms":"2500"}')).toBe("等待 2.5 秒"); // 模型常把数字写成字符串
    expect(browserToolSummary("browser_wait_for", '{"timeMs":2500}')).toBe("等待 2.5 秒"); // camelCase 回退
    expect(browserToolSummary("browser_wait_for", '{"url_contains":"/done"}')).toBe("等待 URL 含「/done」");
    expect(browserToolSummary("browser_wait_for", '{"network_idle":true}')).toBe("等待网络空闲");
    expect(browserToolSummary("browser_wait_for", '{"ref_visible":"e7"}')).toBe("等待 e7 可见");
    expect(browserToolSummary("browser_tabs", '{"action":"new","url":"https://a.com/x?y=1"}')).toBe(
      "新建标签页 a.com/x",
    );
  });

  it("无参也有意义的工具给固定文案；ask_user_to_act 带上要用户做的事", () => {
    expect(browserToolSummary("browser_snapshot", undefined)).toBe("读取页面结构");
    expect(browserToolSummary("browser_screenshot", "{}")).toBe("截图");
    // R1-20：真实入参是 full_page；此前读 fullPage，整页截图在真实事件里永远显示成「截图」
    expect(browserToolSummary("browser_screenshot", '{"full_page":true}')).toBe("整页截图");
    expect(browserToolSummary("browser_screenshot", '{"fullPage":true}')).toBe("整页截图"); // camelCase 回退
    expect(browserToolSummary("browser_screenshot", '{"ref":"e3"}')).toBe("元素截图 e3");
    expect(browserToolSummary("browser_console", undefined)).toBe("读取控制台");
    expect(browserToolSummary("browser_ask_user_to_act", '{"message":"请登录公司账号"}')).toBe(
      "请你操作 · 请登录公司账号",
    );
  });

  it("入参被截断 / 解析不了：缺关键字段的返回空串让调用方回落通用摘要，不抛", () => {
    expect(browserToolSummary("browser_click", '{"ref":"e1')).toBe("");
    expect(browserToolSummary("browser_navigate", undefined)).toBe("");
    expect(browserToolSummary("browser_navigate", "not json")).toBe("");
  });

  it("非浏览器工具 / 未知 browser_ 工具返回空串", () => {
    expect(browserToolSummary("shell", '{"command":"ls"}')).toBe("");
    expect(browserToolSummary("browser_unknown_future", "{}")).toBe("");
  });
});

describe("接入 toolBlockSummary", () => {
  it("事件流折叠行走浏览器摘要；解析不了入参时回落通用逻辑（不空白）", () => {
    expect(toolBlockSummary(block("browser_click", '{"ref":"e12"}'))).toBe("点击 e12");
    expect(toolBlockSummary(block("browser_navigate", '{"url":"https://example.com/a"}'))).toBe(
      "打开 example.com/a",
    );
    expect(toolBlockSummary(block("browser_navigate", undefined)).length).toBeGreaterThan(0);
  });

  it("不影响既有工具", () => {
    expect(toolBlockSummary(block("shell", '{"command":"ls -la"}'))).toBe("$ ls -la");
  });
});

describe("R1-02：落盘脱敏后的占位符在摘要里还原成真实字符数", () => {
  it("type：text 是 [已隐藏 N 字符] 时显示 N 个字符，不把占位符本身的长度当输入长度，也不摊出占位符", () => {
    const s = browserToolSummary("browser_type", '{"ref":"e5","text":"[已隐藏 14 字符]","submit":true}');
    expect(s).toBe("在 e5 输入 14 个字符 并回车");
    expect(s).not.toContain("已隐藏");
    // 空串（清空输入框）不会被隐藏，仍显示「清空」
    expect(browserToolSummary("browser_type", '{"ref":"e5","text":""}')).toBe("在 e5 输入 清空");
    // 真实的明文仍按码点数
    expect(browserToolSummary("browser_type", '{"ref":"e5","text":"你好😀"}')).toBe("在 e5 输入 3 个字符");
  });

  it("fill_form：fields 是数组或 JSON 字符串都能数出项数；upload：paths 是数组 / 单个字符串 / JSON 字符串都能显示文件名", () => {
    expect(browserToolSummary("browser_fill_form", '{"fields":[{"ref":"e1","value":"[已隐藏 3 字符]"},{"ref":"e2","checked":true}]}')).toBe("填写表单 2 项");
    expect(browserToolSummary("browser_fill_form", JSON.stringify({ fields: JSON.stringify([{ ref: "e1", value: "x" }]) }))).toBe("填写表单 1 项");
    expect(browserToolSummary("browser_fill_form", '{"fields":"[已隐藏 99 字符]"}')).toBe("填写表单");
    expect(browserToolSummary("browser_upload", '{"ref":"e4","paths":["/tmp/a/b.txt","/tmp/c.png"]}')).toBe("上传 2 个文件到 e4（b.txt、c.png）");
    expect(browserToolSummary("browser_upload", '{"ref":"e4","paths":"/tmp/a/b.txt"}')).toBe("上传 1 个文件到 e4（b.txt）");
    expect(browserToolSummary("browser_upload", '{"ref":"e4","paths":"[\\"/tmp/x.txt\\"]"}')).toBe("上传 1 个文件到 e4（x.txt）");
  });
});

describe("R1-20：摘要读取的参数名与 tools.ts 的 schema 逐个对齐（守卫）", () => {
  // 这个守卫把「展示文件读的参数名」与「真实工具 schema 的参数名」钉在一起：
  // 以后谁在 browser-tool-display.ts 里读了一个 schema 里不存在的名字（比如 camelCase 的 fullPage），这里就红。
  it("所有 snake_case 读取都在某个浏览器工具的 schema 里；没有只读 camelCase 的参数", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { installFakeBrowser } = await import("./helpers/browser-bridge-fake");
    const { getBrowserTools } = await import("@/lib/server/browser/tools");
    const { __resetBrowserSettingsForTest } = await import("@/lib/server/browser/settings");
    __resetBrowserSettingsForTest({ evaluateEnabled: true });
    const fake = installFakeBrowser({});
    try {
      const schemaNames = new Set<string>();
      const perTool = new Map<string, Set<string>>();
      for (const t of getBrowserTools({ taskId: "t-align" })) {
        const props = Object.keys(((t.parameters as { properties?: Record<string, unknown> }).properties) ?? {});
        perTool.set(t.name, new Set(props));
        for (const p of props) schemaNames.add(p);
      }
      const src = fs.readFileSync(path.join(process.cwd(), "src/lib/browser-tool-display.ts"), "utf8");
      // 去掉注释（注释里会出现各种旧名字）
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/.*$/gm, "");
      const read = new Set<string>();
      // str(o, "x") / pickStr(o, "snake", "camel") / pickNum / pickBool / pick：第一个字面量是主名
      for (const m of code.matchAll(/\b(?:str|pickStr|pickNum|pickBool|pick)\(o,\s*"([^"]+)"(?:,\s*"([^"]+)")?/g)) {
        read.add(m[1]!);
        if (m[2] && m[2] !== m[1]) {
          // 第二个是 camelCase 回退：必须是第一个的驼峰形式，且不是 schema 名（schema 里只有 snake_case）
          const camel = m[1]!.replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase());
          expect(m[2], `回退名应是 ${m[1]} 的驼峰形式`).toBe(camel);
        }
      }
      for (const m of code.matchAll(/\bo\.([A-Za-z_]+)/g)) read.add(m[1]!);
      const missing = [...read].filter((n) => !schemaNames.has(n));
      expect(missing, `展示读了 schema 里不存在的参数名：${missing.join(", ")}`).toEqual([]);
      // 反向：这些「有两种写法」的关键参数，schema 里确实是 snake_case
      for (const [tool, name] of [
        ["browser_screenshot", "full_page"],
        ["browser_drag", "from_ref"],
        ["browser_drag", "to_ref"],
        ["browser_wait_for", "text_gone"],
        ["browser_wait_for", "time_ms"],
        ["browser_wait_for", "url_contains"],
        ["browser_wait_for", "network_idle"],
        ["browser_wait_for", "ref_visible"],
        ["browser_click", "double_click"],
      ] as const) {
        expect(perTool.get(tool)?.has(name), `${tool} 的 schema 应有 ${name}`).toBe(true);
      }
    } finally {
      fake.cleanup();
      __resetBrowserSettingsForTest();
    }
  });
});
