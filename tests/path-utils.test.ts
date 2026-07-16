/**
 * path-utils 单测——重点保 cursor:// 链接生成（链接坏 = 用户点了 Cursor 静默无反应、难排查）
 *
 * 起因（2026-06-10 实测踩坑）：agent 在 artifact 里写 `index.tsx:54,81-84,99` 逗号多段行号、
 * 旧正则只认 `:line` / `:line-line`、整个后缀被当成文件名、生成的链接指向不存在的文件。
 */
import { describe, expect, it } from "vitest";

import {
  buildIdeLink,
  getEffectiveCwd,
  hasValidRepoPrefix,
  isAbsolutePathLike,
  looksLikeArtifactRef,
  looksLikePath,
  parsePathSegments,
  pathBasename,
  shellQuotePath,
} from "@/lib/path-utils";

// 「复制路径」按钮回归：Application Support 带空格、裸粘到 cd 后面拆参（用户实测踩过）
describe("shellQuotePath（复制路径给终端 cd 用）", () => {
  it("普通路径原样返回、不加引号", () => {
    expect(shellQuotePath("/Users/me/work/repo")).toBe("/Users/me/work/repo");
    expect(shellQuotePath("~/my.repo-2/sub_dir")).toBe("~/my.repo-2/sub_dir");
  });

  it("带空格用单引号包住", () => {
    expect(
      shellQuotePath("/Users/me/Library/Application Support/fe-ai-flow"),
    ).toBe("'/Users/me/Library/Application Support/fe-ai-flow'");
  });

  it("内部单引号按 POSIX 惯例转义（' → '\\''）", () => {
    expect(shellQuotePath("/tmp/it's here")).toBe(`'/tmp/it'\\''s here'`);
  });

  it("$ / 反引号等特殊字符也走单引号字面化", () => {
    expect(shellQuotePath("/tmp/a$b`c")).toBe("'/tmp/a$b`c'");
  });

  it("无空格 Windows 反斜杠路径原样返回（cmd 不认单引号、别乱包）", () => {
    expect(shellQuotePath("D:\\IdeaProjects\\repo")).toBe("D:\\IdeaProjects\\repo");
  });

  it("无空格 Windows 正斜杠盘符路径原样返回", () => {
    expect(shellQuotePath("C:/Users/x/AppData/Roaming/fe")).toBe(
      "C:/Users/x/AppData/Roaming/fe",
    );
  });

  it("带空格 Windows 正斜杠盘符路径用双引号包（cmd / PowerShell 认）", () => {
    expect(shellQuotePath("C:/Program Files/fe ai/repo")).toBe(
      '"C:/Program Files/fe ai/repo"',
    );
  });

  it("带空格 Windows 反斜杠路径用双引号包", () => {
    expect(shellQuotePath("D:\\My Docs\\repo")).toBe('"D:\\My Docs\\repo"');
  });
});

// CR-11 回归：/api/repo-branches 与设置页手填校验共用的跨平台绝对路径判断——
// 旧实现只认 `/` 开头、Windows 盘符 / UNC 仓库全被 400 / 拦在手填校验
describe("isAbsolutePathLike（CR-11、跨平台绝对路径）", () => {
  it("POSIX 绝对路径", () => {
    expect(isAbsolutePathLike("/Users/me/repo")).toBe(true);
  });

  it("Windows 盘符：反斜杠 / 正斜杠都认", () => {
    expect(isAbsolutePathLike("C:\\work\\repo")).toBe(true);
    expect(isAbsolutePathLike("D:/repo")).toBe(true);
  });

  it("UNC 路径", () => {
    expect(isAbsolutePathLike("\\\\server\\share\\repo")).toBe(true);
    expect(isAbsolutePathLike("//server/share/repo")).toBe(true);
  });

  it("相对路径 / 裸盘符 / 空串拒绝", () => {
    expect(isAbsolutePathLike("relative/path")).toBe(false);
    expect(isAbsolutePathLike("C:")).toBe(false);
    expect(isAbsolutePathLike("C:repo")).toBe(false); // 盘相对路径不算绝对
    expect(isAbsolutePathLike("")).toBe(false);
  });
});

const BASE = "/Users/me/work";

// 默认 ide=cursor、跟改名前 buildCursorLink 行为完全一致
const buildCursorLink = (pathLike: string, baseDir?: string) =>
  buildIdeLink(pathLike, baseDir);

describe("buildIdeLink（cursor 协议、默认）", () => {
  it("绝对路径直接走、忽略 baseDir", () => {
    expect(buildCursorLink("/a/b/c.ts")).toBe("cursor://file/a/b/c.ts");
    expect(buildCursorLink("/a/b/c.ts", BASE)).toBe("cursor://file/a/b/c.ts");
  });

  it("相对路径 + baseDir 拼绝对路径；没 baseDir 拼不出来返 null", () => {
    expect(buildCursorLink("src/foo.ts", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts`,
    );
    expect(buildCursorLink("src/foo.ts")).toBeNull();
  });

  it("已经是 url 的不动（http / cursor 协议）", () => {
    expect(buildCursorLink("https://example.com/a.ts")).toBeNull();
    expect(buildCursorLink("cursor://file/a.ts")).toBeNull();
  });

  it("单行号 / 范围行号 → 取起始行拼 :line 后缀", () => {
    expect(buildCursorLink("src/foo.ts:271", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
    expect(buildCursorLink("src/foo.ts:271-279", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
    expect(buildCursorLink("src/foo.ts:271:5", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:271`,
    );
  });

  it("逗号 / 顿号分隔的多段行号 → 行号后缀不混进文件名、取起始行", () => {
    // 实测踩坑 case：旧正则不认逗号、`:54,81-84,99` 整段被 encode 进文件名
    expect(
      buildCursorLink(
        "crm-web/src/pages/order/components/AddTextbookButton/index.tsx:54,81-84,99",
        BASE,
      ),
    ).toBe(
      `cursor://file${BASE}/crm-web/src/pages/order/components/AddTextbookButton/index.tsx:54`,
    );
    expect(buildCursorLink("src/foo.ts:54、81-84", BASE)).toBe(
      `cursor://file${BASE}/src/foo.ts:54`,
    );
  });

  it("逗号后带空格的多段行号（agent 实测写法）→ 同样取起始行", () => {
    // 实测踩坑 case 2：`SendOrderDetail.vue:20-88, 189-210, 260-450, 830-878`
    expect(
      buildCursorLink(
        "tch-service-center/packages/tch-sc/src/components/SendOrderDetail.vue:20-88, 189-210, 260-450, 830-878",
        BASE,
      ),
    ).toBe(
      `cursor://file${BASE}/tch-service-center/packages/tch-sc/src/components/SendOrderDetail.vue:20`,
    );
    expect(buildCursorLink("src/TaskInfo.vue:147-154、 1350-1363", BASE)).toBe(
      `cursor://file${BASE}/src/TaskInfo.vue:147`,
    );
  });

  it("非数字冒号后缀不当行号、原样进路径", () => {
    const link = buildCursorLink("src/foo.ts:next", BASE);
    expect(link).toBe(`cursor://file${BASE}/src/foo.ts%3Anext`);
  });

  it("中文 / 空格段被 encode、`/` 和 :line 不被 encode", () => {
    expect(buildCursorLink("/a/中 文/b.ts:12")).toBe(
      `cursor://file/a/${encodeURIComponent("中 文")}/b.ts:12`,
    );
  });

  // ---- Windows 适配（2026-06-11、同事 Windows 上路径不可跳转）----

  it("Windows 盘符绝对路径 → 反斜杠转正斜杠、盘符 `:` 不 encode、忽略 baseDir", () => {
    // 实测踩坑 case：artifact 里 `D:\IdeaProjects\...\ScheduleRefuseApi.java` 完全不生成链接
    expect(
      buildCursorLink(
        "D:\\IdeaProjects\\cp-scheduling\\src\\main\\java\\ScheduleRefuseApi.java",
        BASE,
      ),
    ).toBe(
      "cursor://file/D:/IdeaProjects/cp-scheduling/src/main/java/ScheduleRefuseApi.java",
    );
    // 正斜杠盘符形态（agent 也可能这么写）同样命中
    expect(buildCursorLink("D:/IdeaProjects/foo/Bar.java")).toBe(
      "cursor://file/D:/IdeaProjects/foo/Bar.java",
    );
  });

  it("Windows 绝对路径 + 行号后缀 → 行号正常拆、拼 :line", () => {
    expect(buildCursorLink("D:\\IdeaProjects\\foo\\Bar.java:120")).toBe(
      "cursor://file/D:/IdeaProjects/foo/Bar.java:120",
    );
    expect(buildCursorLink("D:\\IdeaProjects\\foo\\Bar.java:120-140, 200-210")).toBe(
      "cursor://file/D:/IdeaProjects/foo/Bar.java:120",
    );
  });

  it("反斜杠相对路径 + Windows baseDir → 归一化后拼接", () => {
    expect(
      buildCursorLink("src\\main\\Api.java", "D:\\IdeaProjects\\cp-scheduling"),
    ).toBe("cursor://file/D:/IdeaProjects/cp-scheduling/src/main/Api.java");
  });
});

describe("buildIdeLink（idea 协议、2026-06-12 加）", () => {
  it("idea://open?file=...&line=... 形态、行号拆解跟 cursor 同款", () => {
    expect(buildIdeLink("src/foo.ts:271-279", BASE, "idea")).toBe(
      `idea://open?file=${BASE}/src/foo.ts&line=271`,
    );
    expect(buildIdeLink("/a/b/c.ts", undefined, "idea")).toBe(
      "idea://open?file=/a/b/c.ts",
    );
  });

  it("Windows 盘符路径：盘符 `:` 不 encode、手动补前导 /", () => {
    expect(
      buildIdeLink("D:\\IdeaProjects\\foo\\Bar.java:120", undefined, "idea"),
    ).toBe("idea://open?file=/D:/IdeaProjects/foo/Bar.java&line=120");
  });
});

describe("hasValidRepoPrefix（多仓漏仓名前缀检测、2026-06-12 加）", () => {
  const repos = ["crm-web", "tch-service-center", "cp-admin"];

  it("首段是仓名 → 合法", () => {
    expect(hasValidRepoPrefix("crm-web/src/a.ts", repos)).toBe(true);
    expect(
      hasValidRepoPrefix("tch-service-center/apps/foo/b.vue:12-30", repos),
    ).toBe(true);
  });

  it("漏仓名前缀（实测 36-ship 踩坑 case）→ 不合法", () => {
    expect(
      hasValidRepoPrefix(
        "apps/cp-class-advisor-center/src/views/schedule/classList.vue",
        repos,
      ),
    ).toBe(false);
  });

  it("绝对路径 / 单仓（不传清单）→ 不校验、一律放行", () => {
    expect(hasValidRepoPrefix("/abs/path/a.ts", repos)).toBe(true);
    expect(hasValidRepoPrefix("D:\\IdeaProjects\\foo\\Bar.java", repos)).toBe(true);
    expect(hasValidRepoPrefix("apps/foo/b.vue", undefined)).toBe(true);
    expect(hasValidRepoPrefix("apps/foo/b.vue", [])).toBe(true);
  });

  it("多层短名（repoPath 嵌套在子目录）也按前缀匹配", () => {
    expect(hasValidRepoPrefix("group/projA/src/a.ts", ["group/projA"])).toBe(true);
  });
});

describe("parsePathSegments", () => {
  it("多段行号全部拆出来：每段带起始行 + 原文 + 前置分隔符", () => {
    // 实测踩坑 case：`studentSituation.vue:147-175、341-370、485-508` 只能跳首段
    expect(
      parsePathSegments("src/views/studentSituation.vue:147-175、341-370、485-508"),
    ).toEqual({
      path: "src/views/studentSituation.vue",
      segments: [
        { text: "147-175", line: 147, sep: "" },
        { text: "341-370", line: 341, sep: "、" },
        { text: "485-508", line: 485, sep: "、" },
      ],
    });
  });

  it("逗号 + 空格分隔：sep 原样保留（渲染层逐字拼回原文）", () => {
    expect(parsePathSegments("a/b.vue:20-88, 189-210")).toEqual({
      path: "a/b.vue",
      segments: [
        { text: "20-88", line: 20, sep: "" },
        { text: "189-210", line: 189, sep: ", " },
      ],
    });
  });

  it("单段 / 列号也能解析（调用方按 segments.length 决定走单链接还是多链接）", () => {
    expect(parsePathSegments("a/b.vue:271")).toEqual({
      path: "a/b.vue",
      segments: [{ text: "271", line: 271, sep: "" }],
    });
    expect(parsePathSegments("a/b.vue:271:5")).toEqual({
      path: "a/b.vue",
      segments: [{ text: "271:5", line: 271, sep: "" }],
    });
  });

  it("无行号后缀 / 非数字后缀 → null", () => {
    expect(parsePathSegments("a/b.vue")).toBeNull();
    expect(parsePathSegments("a/b.vue:next")).toBeNull();
  });
});

describe("looksLikePath", () => {
  it("常规相对 / 绝对路径命中", () => {
    expect(looksLikePath("src/foo.ts")).toBe(true);
    expect(looksLikePath("/a/b/c.vue")).toBe(true);
  });

  it("带行号后缀（含逗号多段）剥掉后仍命中", () => {
    expect(looksLikePath("src/foo.ts:271-279")).toBe(true);
    expect(looksLikePath("src/foo.ts:54,81-84,99")).toBe(true);
    // 行号后缀里的空格不影响识别（路径部分无空格即可）
    expect(
      looksLikePath("src/components/SendOrderDetail.vue:20-88, 189-210, 830-878"),
    ).toBe(true);
  });

  it("不像路径的不命中：无 /、路径含空格、最后一段无扩展名", () => {
    expect(looksLikePath("foo.ts")).toBe(false);
    expect(looksLikePath("a b/c.ts")).toBe(false);
    expect(looksLikePath("src/foo")).toBe(false);
    // 空格在路径部分（不是行号后缀）→ 仍然拒绝
    expect(looksLikePath("const x = foo/bar.map()")).toBe(false);
  });

  it("Windows 路径命中：盘符绝对 / 反斜杠相对 / 带行号", () => {
    expect(
      looksLikePath("D:\\IdeaProjects\\cp-scheduling\\src\\Api.java"),
    ).toBe(true);
    expect(looksLikePath("src\\main\\Api.java")).toBe(true);
    expect(looksLikePath("D:\\IdeaProjects\\foo\\Bar.java:120-140")).toBe(true);
    // 最后一段无扩展名仍拒绝
    expect(looksLikePath("D:\\IdeaProjects\\foo")).toBe(false);
  });
});

describe("pathBasename", () => {
  it("POSIX / Windows 路径都取末段、目录尾 slash 剥掉", () => {
    expect(pathBasename("/a/b/c.ts")).toBe("c.ts");
    expect(pathBasename("/a/b/")).toBe("b");
    expect(pathBasename("abc.txt")).toBe("abc.txt");
    expect(pathBasename("D:\\IdeaProjects\\foo\\Bar.java")).toBe("Bar.java");
  });
});

describe("getEffectiveCwd（Windows 多仓）", () => {
  it("Windows 多仓 → 公共父目录、输出统一正斜杠", () => {
    // 实测场景：同事 Windows 上 cp-scheduling + tch-studio + wk-flowable 三仓
    expect(
      getEffectiveCwd([
        "D:\\IdeaProjects\\cp-scheduling",
        "D:\\IdeaProjects\\tch-studio",
        "D:\\IdeaProjects\\wk-flowable",
      ]),
    ).toBe("D:/IdeaProjects");
  });

  it("Windows 单仓 → 仓库自身、反斜杠归一化", () => {
    expect(getEffectiveCwd(["D:\\IdeaProjects\\cp-scheduling\\"])).toBe(
      "D:/IdeaProjects/cp-scheduling",
    );
  });

  it("跨盘符 → 空串（无公共目录、调用方 fallback）", () => {
    expect(getEffectiveCwd(["C:\\work\\a", "D:\\work\\b"])).toBe("");
  });

  it("POSIX 多仓行为不变", () => {
    expect(getEffectiveCwd(["/a/b/c", "/a/b/d"])).toBe("/a/b");
  });
});

describe("looksLikeArtifactRef", () => {
  it("artifact 文件名形态（带 / 不带 actions/ 前缀）", () => {
    expect(looksLikeArtifactRef("5-plan.md")).toEqual({ n: 5, type: "plan" });
    expect(looksLikeArtifactRef("actions/18-build.md")).toEqual({
      n: 18,
      type: "build",
    });
  });

  it("`<type> #<n>` 口语引用形态（V0.6.29、增量 build「沿用」清单可点击跳转）", () => {
    expect(looksLikeArtifactRef("build #18")).toEqual({ n: 18, type: "build" });
    expect(looksLikeArtifactRef("build#18")).toEqual({ n: 18, type: "build" });
    expect(looksLikeArtifactRef("review #3")).toEqual({ n: 3, type: "review" });
  });

  it("不命中：未知 type / 无 n / 业务文件路径", () => {
    expect(looksLikeArtifactRef("foobar #18")).toBeNull();
    expect(looksLikeArtifactRef("build #")).toBeNull();
    expect(looksLikeArtifactRef("build")).toBeNull();
    expect(looksLikeArtifactRef("apps/foo/bar.vue")).toBeNull();
    expect(looksLikeArtifactRef("99-unknown.md")).toBeNull();
  });
});
