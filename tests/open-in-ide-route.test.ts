/**
 * POST /api/system/open-in-ide：绝对路径 + 拒绝 `-` 开头（P1：曾只有 UNC 检查）。
 *
 * path 会原样进 IDE CLI 的 argv：同源 POST `path:"--install-extension=/tmp/x.vsix"` 会被 VS Code 系 CLI
 * 当选项解析。与同族的 open-path / reveal-in-folder 一样，必须是绝对路径；这里再单拒 `-` 开头给更清楚的报错。
 * 下游 openInIde 被 mock 掉，断言**从未被调用**（拒绝发生在 spawn 之前）。
 *
 * 与宿主平台无关（复审 P3）：路由里的 `nonLocalPathReason(p)` 默认读 `process.platform`——Windows 上走「只放行盘符绝对路径」
 * 的白名单，posix 绝对路径、相对路径、`-` 开头都会先被它以另一句话拒掉；原先的用例没控制这个变量，
 * 在 Windows 宿主上会整片失败（把 platform 钉成 win32 实测 13 个里 12 个红）。
 * 现在每个用例显式钉平台：「posix 语义」套件钉 linux、「Windows 语义」套件钉 win32，两种宿主跑出来的结果一致。
 * （`path.isAbsolute` 是 node 启动时按宿主选好的实现，钉 platform 管不到它；所以 posix 套件里只放
 * 「posix / win32 两种 isAbsolute 结论一致」的用例，并有一条用例表自检守住这一点。）
 */
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NON_LOCAL_PATH_MESSAGE, UNC_REJECT_MESSAGE } from "@/lib/unc-path";

const openInIde = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/server/ide-tools", () => ({ openInIde }));

const post = (body: unknown) =>
  new Request("http://127.0.0.1/api/system/open-in-ide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { ...realPlatform, value });

/** 在指定「平台」下调一次路由：先 import（模块加载期不受影响），只在 POST 期间钉 platform */
const callRoute = async (body: unknown, platform: NodeJS.Platform) => {
  const { POST } = await import("@/app/api/system/open-in-ide/route");
  setPlatform(platform);
  try {
    const res = await POST(post(body));
    return { status: res.status, json: (await res.json()) as { error?: string; ok?: boolean } };
  } finally {
    Object.defineProperty(process, "platform", realPlatform);
  }
};

beforeEach(() => {
  openInIde.mockClear();
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

const DRIVE_RE = /^[a-zA-Z]:[\\/]/;

/** 两种 path 实现都判「相对」、也不是盘符绝对：在任何宿主上结论一致 */
const RELATIVE_CASES = ["foo/bar.ts", "./a.ts", "../a.ts", "a.ts", "~/proj/a.ts", "C:relative"];
/** 两种实现下都算绝对（posix / win32 的 isAbsolute 为真，或盘符绝对）：任何宿主上都放行 */
const ABSOLUTE_CASES = [
  { ide: "idea", p: "/Users/me/proj/A.java", line: 7 as number | undefined },
  { ide: "webstorm", p: "C:\\Users\\me\\proj\\a.ts", line: undefined },
  { ide: "idea", p: "D:/proj/a.ts", line: undefined },
];

describe("用例表自检：posix 语义套件里的用例与宿主 path 实现无关", () => {
  it("RELATIVE_CASES：posix / win32 的 isAbsolute 都为 false、且不匹配盘符正则", () => {
    for (const p of RELATIVE_CASES) {
      expect(path.posix.isAbsolute(p), `posix ${p}`).toBe(false);
      expect(path.win32.isAbsolute(p), `win32 ${p}`).toBe(false);
      expect(DRIVE_RE.test(p), `drive ${p}`).toBe(false);
    }
  });

  it("ABSOLUTE_CASES：posix / win32 的 isAbsolute（或盘符正则）都判绝对", () => {
    for (const { p } of ABSOLUTE_CASES) {
      expect(path.posix.isAbsolute(p) || DRIVE_RE.test(p), `posix ${p}`).toBe(true);
      expect(path.win32.isAbsolute(p) || DRIVE_RE.test(p), `win32 ${p}`).toBe(true);
    }
  });
});

describe("open-in-ide 路由：路径形态校验（posix 语义，platform 钉 linux）", () => {
  it.each([
    "--install-extension=/tmp/x.vsix",
    "--extensions-dir=/tmp/evil",
    "-n",
    "-g",
    "-/Users/me/a.ts", // 以 - 开头即使后面像绝对路径也拒
  ])("以 - 开头 %s → 400 且从未调用 openInIde", async (p) => {
    for (const ide of ["cursor", "vscode", "idea"]) {
      const { status, json } = await callRoute({ ide, path: p }, "linux");
      expect(status, `${ide} ${p}`).toBe(400);
      expect(json.error).toBe("path 不能以 - 开头");
    }
    expect(openInIde).not.toHaveBeenCalled();
  });

  it.each(RELATIVE_CASES)("相对路径 %s → 400「必须是绝对路径」且从未调用 openInIde", async (p) => {
    const { status, json } = await callRoute({ ide: "cursor", path: p, line: 3 }, "linux");
    expect(status).toBe(400);
    expect(json.error).toBe("path 必须是绝对路径");
    expect(openInIde).not.toHaveBeenCalled();
  });

  it("绝对路径（posix / Windows 盘符）正常放行，参数原样交给 openInIde", async () => {
    for (const { ide, p, line } of ABSOLUTE_CASES) {
      const res = await callRoute({ ide, path: p, ...(line ? { line } : {}) }, "linux");
      expect(res, p).toEqual({ status: 200, json: { ok: true } });
      expect(openInIde).toHaveBeenLastCalledWith(ide, p, line);
    }
    expect(openInIde).toHaveBeenCalledTimes(ABSOLUTE_CASES.length);
  });

  it("原有校验口径不变：非法 ide / 缺 path 仍是 400", async () => {
    expect((await callRoute({ ide: "nope", path: "/a" }, "linux")).status).toBe(400);
    expect((await callRoute({ ide: "idea", path: "   " }, "linux")).json.error).toBe("path 必填");
    expect(openInIde).not.toHaveBeenCalled();
  });
});

describe("open-in-ide 路由：路径形态校验（Windows 语义，platform 钉 win32）", () => {
  // nonLocalPathReason 在 Windows 上是「只放行盘符绝对路径」的白名单：
  // 其余形态（相对 / posix 绝对 / `-` 开头 / 盘相对 / 根相对）一律先被它拒掉，且在 spawn 之前
  it.each([
    "--install-extension=C:/x.vsix",
    "-n",
    "-/Users/me/a.ts",
    ...RELATIVE_CASES,
    "/Users/me/proj/A.java", // posix 绝对路径在 Windows 上不是本机盘符路径
    "\\foo\\bar", // 根相对（当前盘符根），不带盘符
    "\\??\\C:\\x", // NT 对象命名空间前缀
  ])("%j → 400（只支持带盘符的绝对路径）、从未调用 openInIde", async (p) => {
    const { status, json } = await callRoute({ ide: "cursor", path: p }, "win32");
    expect(status).toBe(400);
    expect(json.error).toBe(NON_LOCAL_PATH_MESSAGE);
    expect(openInIde).not.toHaveBeenCalled();
  });

  it("盘符绝对路径放行，参数原样交给 openInIde", async () => {
    const a = await callRoute({ ide: "webstorm", path: "C:\\Users\\me\\proj\\a.ts", line: 5 }, "win32");
    expect(a).toEqual({ status: 200, json: { ok: true } });
    expect(openInIde).toHaveBeenLastCalledWith("webstorm", "C:\\Users\\me\\proj\\a.ts", 5);
    const b = await callRoute({ ide: "idea", path: "D:/proj/a.ts" }, "win32");
    expect(b.status).toBe(200);
    expect(openInIde).toHaveBeenCalledTimes(2);
  });

  it("盘符后的目录名以 - 开头（C:\\-weird\\a.ts）不被「- 开头」规则误伤", async () => {
    const r = await callRoute({ ide: "cursor", path: "C:\\-weird\\a.ts" }, "win32");
    expect(r.status).toBe(200);
  });
});

describe("open-in-ide 路由：UNC 形态在任何平台都先被拒（不依赖宿主）", () => {
  it.each(["\\\\host\\share\\a.ts", "//host/share/a.ts", "\\\\?\\UNC\\host\\share\\a.ts"])(
    "%j → 400 UNC 提示、从未调用 openInIde",
    async (p) => {
      for (const platform of ["linux", "win32"] as const) {
        const { status, json } = await callRoute({ ide: "idea", path: p }, platform);
        expect(status, `${platform} ${p}`).toBe(400);
        expect(json.error, `${platform} ${p}`).toBe(UNC_REJECT_MESSAGE);
      }
      expect(openInIde).not.toHaveBeenCalled();
    },
  );
});
