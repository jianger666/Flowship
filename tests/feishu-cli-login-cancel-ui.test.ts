/**
 * 设置页「飞书集成」的取消登录接线（R14 B6-6 · Q6-01）——只能是源码契约：
 * 组件是 client 组件、「登录中」状态来自轮询接口，服务端渲染一次拿不到，没法在这里点出来。
 * 所以这里钉的是接线本身（谁出现在什么条件下、请求体长什么样、不受 busy 锁），
 * 真实点击与浏览器里的样子需要人工验收（见改动说明里的验收步骤）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const raw = readFileSync(
  path.resolve(import.meta.dirname, "..", "src/components/settings/feishu-cli-card.tsx"),
  "utf8",
);

/** 去掉块注释（含 JSX 里的花括号注释）和行注释，免得注释里的字样干扰匹配 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const src = stripComments(raw);

/** 取 `const <name> = async` 到下一个 `const handle` 之间的函数体 */
const handlerBody = (name: string): string => {
  const start = src.indexOf(`const ${name} = async`);
  expect(start, `找不到 ${name}`).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("const handle", start + 10);
  return src.slice(start, next === -1 ? undefined : next);
};

describe("取消按钮", () => {
  /** `{login?.running && ( <Button …>取消</Button> )}` 这一块 */
  const cancelBlock = (() => {
    const blocks = src.match(/\{login\?\.running && \(\s*<Button[\s\S]*?<\/Button>\s*\)\}/g) ?? [];
    return blocks.find((b) => b.includes("取消")) ?? "";
  })();

  it("只在登录进行中（login?.running）出现，文案「取消」，点击走 handleCancelLogin", () => {
    expect(cancelBlock).not.toBe("");
    expect(cancelBlock).toContain("handleCancelLogin(");
    expect(cancelBlock).toMatch(/type="button"/);
  });

  it("不受 busy 禁用（取消是给「卡住了」的人用的，不能被别的操作的 busy 锁住）", () => {
    expect(cancelBlock).not.toBe(""); // 先确认块真的找到了，否则下面两条对空串恒绿
    expect(cancelBlock).not.toMatch(/disabled/);
    expect(cancelBlock).not.toContain("busy");
  });

  it("画在「未登录」分支里、登录按钮之后", () => {
    const loginBtn = src.indexOf("handleLogin(toolId");
    const cancelBtn = src.indexOf("handleCancelLogin(toolId");
    expect(loginBtn).toBeGreaterThan(src.indexOf("未登录"));
    expect(cancelBtn).toBeGreaterThan(loginBtn);
  });
});

describe("handleCancelLogin", () => {
  // 函数体在各用例里现取（不放在 describe 顶层）：改前基线没有这个函数时是逐条红，而不是整个文件加载失败
  it("发 POST { action: 'cancel-login', tool }", () => {
    const body = handlerBody("handleCancelLogin");
    expect(body).toContain('const r = await requestFeishuCli("POST", { action: "cancel-login", tool })');
  });

  it("不进 busy：取消请求既不置位也不依赖 busy", () => {
    const body = handlerBody("handleCancelLogin");
    expect(body).not.toContain("setBusy");
    expect(body).not.toContain("busy");
  });

  it("失败弹错误；成功才弹「已取消登录」，cancelled === false（取消到达时已自己结束）不弹；最后刷新状态", () => {
    const body = handlerBody("handleCancelLogin");
    expect(body).toContain("toast.error(`取消失败：${r.message}`)");
    expect(body).toMatch(/if \(!r\.ok\) \{\s*toast\.error\(`取消失败：\$\{r\.message\}`\);\s*return;\s*\}/); // 条件是 !r.ok（不能恒真 / 恒假 / 取反）；失败后不再往下弹「已取消」
    expect(body).toContain("r.data.cancelled !== false");
    expect(body).toContain('toast.info("已取消登录")');
    expect(body).toContain("void refresh()");
  });
});

describe("登录报错只在未登录时显示", () => {
  it("条件是 !tool.loggedIn && login?.error，旧的无条件写法已不在", () => {
    expect(src).toMatch(/\{!tool\.loggedIn && login\?\.error && \(/);
    expect(src).not.toMatch(/\{login\?\.error && \(/);
  });
});

describe("既有接线没被带走（回归）", () => {
  it("登录按钮仍在 busy 或登录中时禁用；登录请求体不变", () => {
    expect(src).toContain("disabled={busy || !!login?.running}");
    expect(src).toContain('requestFeishuCli("POST", { action: "login", tool })');
  });
});
