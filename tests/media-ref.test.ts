/**
 * 媒体引用（media-ref）：`路径#t=起,止` 的解析 / 从 markdown 提取
 *
 * 引用是 AI 回复里的一种写法：`` `/abs/a.mp4#t=12.4,15` ``，Flowship 把它认成可点的文件。
 * 解析口径一漂移，点击就会跳错位置或整条引用丢失；也不能把命令行误认成文件。
 */
import { describe, expect, it } from "vitest";

import { AUDIO_EXTS, VIDEO_EXTS } from "@/lib/media/media-kind";
import {
  MAX_MEDIA_REFS_PER_MESSAGE,
  extractMediaRefsFromMarkdown,
  formatMediaRefRange,
  parseMediaFragment,
  parseMediaRefToken,
  resolveMediaRef,
} from "@/lib/media/media-ref";

describe("parseMediaFragment", () => {
  it("t=12.4 → 只有起点", () => {
    expect(parseMediaFragment("t=12.4")).toEqual({ start: 12.4 });
    expect(parseMediaFragment("t=0")).toEqual({ start: 0 });
    expect(parseMediaFragment("t=90")).toEqual({ start: 90 });
  });

  it("t=12.4,15 → 区间", () => {
    expect(parseMediaFragment("t=12.4,15")).toEqual({ start: 12.4, end: 15 });
    expect(parseMediaFragment("t=0,0.5")).toEqual({ start: 0, end: 0.5 });
  });

  it("t=,15 → 起点省略按 0", () => {
    expect(parseMediaFragment("t=,15")).toEqual({ start: 0, end: 15 });
  });

  it("t=12, → 终点省略等同只有起点", () => {
    expect(parseMediaFragment("t=12,")).toEqual({ start: 12 });
  });

  it("npt: 前缀与冒号写法（大小写不敏感）", () => {
    expect(parseMediaFragment("t=npt:1:02,1:10")).toEqual({ start: 62, end: 70 });
    expect(parseMediaFragment("T=NPT:5")).toEqual({ start: 5 });
    expect(parseMediaFragment("t=1:02.5")).toEqual({ start: 62.5 });
    expect(parseMediaFragment("t=1m30s,2m")).toEqual({ start: 90, end: 120 });
  });

  it("前后空白会被忽略", () => {
    expect(parseMediaFragment("  t=12.4,15  ")).toEqual({ start: 12.4, end: 15 });
  });

  it("起点 > 终点非法", () => {
    expect(parseMediaFragment("t=15,12")).toBeNull();
    expect(parseMediaFragment("t=1:10,1:02")).toBeNull();
    expect(parseMediaFragment("t=12.5,12.4")).toBeNull();
  });

  it("空 / 缺参数 / 非 t= 片段 → null", () => {
    expect(parseMediaFragment("")).toBeNull();
    expect(parseMediaFragment("   ")).toBeNull();
    expect(parseMediaFragment("t=")).toBeNull();
    expect(parseMediaFragment("t=,")).toBeNull();
    expect(parseMediaFragment("t=npt:")).toBeNull();
    expect(parseMediaFragment("12.4")).toBeNull();
    expect(parseMediaFragment("x=12")).toBeNull();
    expect(parseMediaFragment("page=3")).toBeNull();
  });

  it("含非法数字 → null（起点或终点任一写坏都算）", () => {
    expect(parseMediaFragment("t=abc")).toBeNull();
    expect(parseMediaFragment("t=12,abc")).toBeNull();
    expect(parseMediaFragment("t=abc,15")).toBeNull();
    expect(parseMediaFragment("t=-1")).toBeNull();
    expect(parseMediaFragment("t=1:75")).toBeNull();
    expect(parseMediaFragment("t=12,1:75")).toBeNull();
    // 多余的逗号：终点部分是 "15,20"，不是合法时间
    expect(parseMediaFragment("t=12,15,20")).toBeNull();
  });
});

describe("parseMediaRefToken", () => {
  it("绝对媒体路径（无片段）", () => {
    expect(parseMediaRefToken("/out/a.mp4")).toEqual({ path: "/out/a.mp4" });
    expect(parseMediaRefToken("/out/a.mp4")).not.toHaveProperty("start");
  });

  it("带片段：起点 / 区间", () => {
    expect(parseMediaRefToken("/out/a.mp4#t=12.4")).toEqual({ path: "/out/a.mp4", start: 12.4 });
    expect(parseMediaRefToken("/out/a.mp4#t=12.4,15")).toEqual({
      path: "/out/a.mp4",
      start: 12.4,
      end: 15,
    });
    expect(parseMediaRefToken("/out/a.mp3#t=npt:1:02,1:10")).toEqual({
      path: "/out/a.mp3",
      start: 62,
      end: 70,
    });
  });

  it("需要路径分隔符：裸文件名不认（避免把示例文字当文件）", () => {
    expect(parseMediaRefToken("a.mp4")).toBeNull();
    expect(parseMediaRefToken("a.mp4#t=5")).toBeNull();
    expect(parseMediaRefToken("mp4")).toBeNull();
  });

  it("Windows 反斜杠 / 盘符路径", () => {
    expect(parseMediaRefToken("C:\\Videos\\a.mp4#t=3")).toEqual({ path: "C:\\Videos\\a.mp4", start: 3 });
    expect(parseMediaRefToken("out\\a.mp4")).toEqual({ path: "out\\a.mp4" });
  });

  it("非媒体扩展名 / 没有扩展名 / 空 → null", () => {
    expect(parseMediaRefToken("/out/a.txt")).toBeNull();
    expect(parseMediaRefToken("/src/index.ts")).toBeNull();
    expect(parseMediaRefToken("/out/a.mkv")).toBeNull();
    expect(parseMediaRefToken("/out/video")).toBeNull();
    expect(parseMediaRefToken("/out/a.txt#t=5")).toBeNull();
    expect(parseMediaRefToken("")).toBeNull();
    expect(parseMediaRefToken("   ")).toBeNull();
    expect(parseMediaRefToken("#t=5")).toBeNull();
  });

  it("目录名带媒体扩展、文件本身不是媒体 → null", () => {
    expect(parseMediaRefToken("/out/a.mp4/readme.md")).toBeNull();
  });

  it("片段写坏：退化为从头播，路径不丢", () => {
    expect(parseMediaRefToken("/out/a.mp4#t=abc")).toEqual({ path: "/out/a.mp4" });
    expect(parseMediaRefToken("/out/a.mp4#t=15,12")).toEqual({ path: "/out/a.mp4" });
    expect(parseMediaRefToken("/out/a.mp4#t=1:75")).toEqual({ path: "/out/a.mp4" });
    expect(parseMediaRefToken("/out/a.mp4#")).toEqual({ path: "/out/a.mp4" });
    expect(parseMediaRefToken("/out/a.mp4#section")).toEqual({ path: "/out/a.mp4" });
    const bad = parseMediaRefToken("/out/a.mp4#t=abc");
    expect(bad).not.toHaveProperty("start");
    expect(bad).not.toHaveProperty("end");
  });

  it("相对路径带空格 → 拒；绝对路径带空格 → 放行", () => {
    expect(parseMediaRefToken("my dir/a.mp4")).toBeNull();
    expect(parseMediaRefToken("out/my video.mp4")).toBeNull();
    expect(parseMediaRefToken("/Users/me/My Videos/a b.mp4")).toEqual({
      path: "/Users/me/My Videos/a b.mp4",
    });
    expect(parseMediaRefToken("C:\\My Videos\\a.mp4#t=2")).toEqual({
      path: "C:\\My Videos\\a.mp4",
      start: 2,
    });
    expect(parseMediaRefToken("\\\\nas\\my share\\a.wav")).toEqual({
      path: "\\\\nas\\my share\\a.wav",
    });
  });

  it("绝对路径开头的整条命令 / 一次列多个文件：不是单个路径 → 拒", () => {
    expect(parseMediaRefToken("/opt/homebrew/bin/ffmpeg -i /a/in.mp4 -c copy /a/out.mp4")).toBeNull();
    expect(parseMediaRefToken("/usr/bin/afplay /Users/me/bpm 160.mp3")).toBeNull();
    expect(parseMediaRefToken("/Users/me/a.mp4 /Users/me/b.mp4")).toBeNull();
    expect(parseMediaRefToken("/Users/me/a.mp4 ~/b.mp4")).toBeNull();
    expect(parseMediaRefToken("/usr/bin/mpv --start=5 /a.mp4")).toBeNull();
    expect(parseMediaRefToken("C:\\Videos\\a.mp4 D:\\b.mp4")).toBeNull();
    expect(parseMediaRefToken("C:\\Tools\\ffmpeg.exe -i C:\\a.mp4")).toBeNull();
    // 相对开头的命令本来就拒（含空白 + 非绝对）
    expect(parseMediaRefToken("ffmpeg -i /a/in.mp4 out.mp4")).toBeNull();
  });

  it("正常的带空格绝对路径照旧放行（空格后是普通字符、` - ` 分隔的文件名）", () => {
    expect(parseMediaRefToken("/Users/me/Library/Application Support/x/a.mp3")).toEqual({
      path: "/Users/me/Library/Application Support/x/a.mp3",
    });
    expect(parseMediaRefToken("/Users/me/Music/Track - Remix.mp3#t=5")).toEqual({
      path: "/Users/me/Music/Track - Remix.mp3",
      start: 5,
    });
    expect(parseMediaRefToken("/Users/me/bpm 160.mp3")).toEqual({ path: "/Users/me/bpm 160.mp3" });
  });

  it("`~/` 开头：波浪号没人展开，不认成媒体引用（交还给普通路径处理）", () => {
    expect(parseMediaRefToken("~/Movies/a.mp4")).toBeNull();
    expect(parseMediaRefToken("~/Movies/a.mp4#t=5")).toBeNull();
    expect(parseMediaRefToken("~/a b/c.mp3")).toBeNull();
  });

  it("引号 / 反引号 / 内部换行 → 拒（那是表达式或跨行文本，不是路径）", () => {
    expect(parseMediaRefToken('"/out/a.mp4"')).toBeNull();
    expect(parseMediaRefToken("'/out/a.mp4'")).toBeNull();
    expect(parseMediaRefToken("`/out/a.mp4`")).toBeNull();
    expect(parseMediaRefToken("/out/a`b.mp4")).toBeNull();
    expect(parseMediaRefToken("/out/it's.mp4")).toBeNull();
    expect(parseMediaRefToken("/out/a\n/b.mp4")).toBeNull();
    expect(parseMediaRefToken("/out/a\r/b.mp4")).toBeNull();
    // 片段里的引号同样拒
    expect(parseMediaRefToken('/out/a.mp4#t="5"')).toBeNull();
  });

  it("首尾空白会被 trim（外层换行不算内部换行）", () => {
    expect(parseMediaRefToken("  /out/a.mp4#t=3 \n")).toEqual({ path: "/out/a.mp4", start: 3 });
  });

  it("超长拒：恰好 600 字符放行，601 拒", () => {
    const ok = `/${"a".repeat(600 - 1 - ".mp4".length)}.mp4`;
    expect(ok.length).toBe(600);
    expect(parseMediaRefToken(ok)).toEqual({ path: ok });
    const tooLong = `/${"a".repeat(601 - 1 - ".mp4".length)}.mp4`;
    expect(tooLong.length).toBe(601);
    expect(parseMediaRefToken(tooLong)).toBeNull();
  });

  it("大小写不敏感的扩展名", () => {
    expect(parseMediaRefToken("/out/A.MP4#t=1")).toEqual({ path: "/out/A.MP4", start: 1 });
  });
});

describe("formatMediaRefRange", () => {
  it("没有起点 → 空串", () => {
    expect(formatMediaRefRange()).toBe("");
    expect(formatMediaRefRange(undefined, 15)).toBe("");
  });

  it("单点：00:12.4（分钟补零、1 位小数）", () => {
    expect(formatMediaRefRange(12.4)).toBe("00:12.4");
    expect(formatMediaRefRange(0)).toBe("00:00.0");
    expect(formatMediaRefRange(3725.5)).toBe("1:02:05.5");
  });

  it("区间：用 en dash 连接", () => {
    expect(formatMediaRefRange(12.4, 15)).toBe("00:12.4–00:15.0");
    expect(formatMediaRefRange(59.96, 61)).toBe("00:59.9–01:01.0");
  });

  it("终点 <= 起点当单点", () => {
    expect(formatMediaRefRange(12.4, 12.4)).toBe("00:12.4");
    expect(formatMediaRefRange(12.4, 3)).toBe("00:12.4");
  });
});

describe("resolveMediaRef", () => {
  it("绝对路径：absolute 与原路径一致，起止原样保留", () => {
    expect(resolveMediaRef({ path: "/out/a.mp4", start: 3, end: 9 })).toEqual({
      path: "/out/a.mp4",
      start: 3,
      end: 9,
      absolute: "/out/a.mp4",
    });
  });

  it("相对路径需要 baseDir：缺省 / 空串 → null", () => {
    expect(resolveMediaRef({ path: "out/a.mp4" })).toBeNull();
    expect(resolveMediaRef({ path: "out/a.mp4" }, "")).toBeNull();
  });

  it("相对路径 + baseDir：拼出绝对路径（去掉 ./ 与重复斜杠）", () => {
    expect(resolveMediaRef({ path: "out/a.mp4" }, "/repo")?.absolute).toBe("/repo/out/a.mp4");
    expect(resolveMediaRef({ path: "./out/a.mp4" }, "/repo/")?.absolute).toBe("/repo/out/a.mp4");
    expect(resolveMediaRef({ path: "out/a.mp4" }, "/repo//")?.absolute).toBe("/repo/out/a.mp4");
    // 原始 path 不变
    expect(resolveMediaRef({ path: "./out/a.mp4" }, "/repo")?.path).toBe("./out/a.mp4");
  });

  it("绝对路径忽略 baseDir", () => {
    expect(resolveMediaRef({ path: "/out/a.mp4" }, "/repo")?.absolute).toBe("/out/a.mp4");
  });

  it("Windows：反斜杠归一成正斜杠；baseDir 也可以是 Windows 路径", () => {
    expect(resolveMediaRef({ path: "C:\\Videos\\a.mp4" })?.absolute).toBe("C:/Videos/a.mp4");
    expect(resolveMediaRef({ path: "out\\a.mp4" }, "D:\\work\\")?.absolute).toBe("D:/work/out/a.mp4");
  });

  it("拆掉 :行号 后缀后不再是音视频 → null", () => {
    expect(resolveMediaRef({ path: "/out/a.txt:12" })).toBeNull();
    // 拆完仍是媒体：absolute 不带行号
    expect(resolveMediaRef({ path: "/out/a.mp4:12" })?.absolute).toBe("/out/a.mp4");
  });

  it("URL / 空路径 / 非媒体 → null", () => {
    expect(resolveMediaRef({ path: "https://example.com/a.mp4" }, "/repo")).toBeNull();
    expect(resolveMediaRef({ path: "" }, "/repo")).toBeNull();
    expect(resolveMediaRef({ path: "/out/a.txt" })).toBeNull();
  });
});

describe("extractMediaRefsFromMarkdown：基本提取", () => {
  it("行内代码里的媒体路径（带片段）", () => {
    const refs = extractMediaRefsFromMarkdown("成片在 `/out/demo.mp4#t=12.4,15`，看看。");
    expect(refs).toEqual([{ path: "/out/demo.mp4", start: 12.4, end: 15, absolute: "/out/demo.mp4" }]);
  });

  it("本地 markdown 链接（带片段）", () => {
    const refs = extractMediaRefsFromMarkdown("[开场](/out/demo.mp4#t=5,9)");
    expect(refs).toEqual([{ path: "/out/demo.mp4", start: 5, end: 9, absolute: "/out/demo.mp4" }]);
    expect(extractMediaRefsFromMarkdown("[配乐](/out/bgm.mp3)").map((r) => r.absolute)).toEqual([
      "/out/bgm.mp3",
    ]);
  });

  it("白名单里每个扩展名都能被提取（开头的快速预检正则不能漏掉任何一个）", () => {
    for (const ext of [...VIDEO_EXTS, ...AUDIO_EXTS]) {
      for (const text of [`\`/a/x.${ext}\``, `[x](/a/x.${ext})`, `\`/a/X.${ext.toUpperCase()}#t=1\``]) {
        const refs = extractMediaRefsFromMarkdown(`看：${text}`);
        expect(refs, text).toHaveLength(1);
        expect(refs[0]?.absolute.toLowerCase()).toBe(`/a/x.${ext}`);
      }
    }
  });

  it("图片语法嵌入的视频也算（目标同一个口径）", () => {
    expect(extractMediaRefsFromMarkdown("![演示](/out/demo.webm)").map((r) => r.absolute)).toEqual([
      "/out/demo.webm",
    ]);
  });

  it("没有媒体 / 空文本 → 空数组", () => {
    expect(extractMediaRefsFromMarkdown("")).toEqual([]);
    expect(extractMediaRefsFromMarkdown("没有任何媒体文件 `/src/index.ts`")).toEqual([]);
    expect(extractMediaRefsFromMarkdown("`ls /out`，然后 [文档](/docs/a.md)")).toEqual([]);
  });

  it("裸文件名 / 非媒体 / 远程 URL 都不算", () => {
    expect(extractMediaRefsFromMarkdown("`demo.mp4`")).toEqual([]);
    expect(extractMediaRefsFromMarkdown("`/src/video.ts`")).toEqual([]);
    expect(extractMediaRefsFromMarkdown("[远程](https://example.com/a.mp4)")).toEqual([]);
  });

  it("正文里没包反引号 / 链接的路径不算", () => {
    expect(extractMediaRefsFromMarkdown("成片在 /out/demo.mp4 里")).toEqual([]);
  });

  it("中文路径", () => {
    const refs = extractMediaRefsFromMarkdown("产出：`/产出/成片/演示视频.mp4#t=3.5`");
    expect(refs).toEqual([
      { path: "/产出/成片/演示视频.mp4", start: 3.5, absolute: "/产出/成片/演示视频.mp4" },
    ]);
  });

  it("行内代码里带空格的绝对路径", () => {
    const refs = extractMediaRefsFromMarkdown("`/Users/me/My Videos/成片 v2.mp4#t=1`");
    expect(refs.map((r) => r.absolute)).toEqual(["/Users/me/My Videos/成片 v2.mp4"]);
    expect(refs[0]?.start).toBe(1);
  });

  it("链接目标：`<...>` 包裹可带空格；不包裹的带空格目标不是链接目标", () => {
    const refs = extractMediaRefsFromMarkdown("[成片](</Users/me/My Videos/a b.mp4#t=2,4>)");
    expect(refs).toEqual([
      {
        path: "/Users/me/My Videos/a b.mp4",
        start: 2,
        end: 4,
        absolute: "/Users/me/My Videos/a b.mp4",
      },
    ]);
    expect(extractMediaRefsFromMarkdown("[成片](/Users/me/My Videos/a.mp4)")).toEqual([]);
  });

  it("file:// 链接目标：剥掉协议头", () => {
    expect(extractMediaRefsFromMarkdown("[x](file:///Users/me/a.mp4#t=7)")).toEqual([
      { path: "/Users/me/a.mp4", start: 7, absolute: "/Users/me/a.mp4" },
    ]);
    expect(
      extractMediaRefsFromMarkdown("[x](<file:///Users/me/My Videos/a.mp4>)").map((r) => r.absolute),
    ).toEqual(["/Users/me/My Videos/a.mp4"]);
  });

  it("Windows 的 file:///C:/... 目标要去掉盘符前多出来的 /", () => {
    const refs = extractMediaRefsFromMarkdown("[x](file:///C:/Videos/a.mp4#t=7)");
    expect(refs.map((r) => r.absolute)).toEqual(["C:/Videos/a.mp4"]);
    expect(refs[0]?.start).toBe(7);
  });

  it("Windows 盘符路径（行内代码 / 链接）", () => {
    expect(extractMediaRefsFromMarkdown("`C:\\Videos\\a.mp4#t=3`")).toEqual([
      { path: "C:\\Videos\\a.mp4", start: 3, absolute: "C:/Videos/a.mp4" },
    ]);
    expect(extractMediaRefsFromMarkdown("[x](C:\\Videos\\b.mp4)").map((r) => r.absolute)).toEqual([
      "C:/Videos/b.mp4",
    ]);
  });

  it("相对路径需要 baseDir，拼成绝对路径", () => {
    expect(extractMediaRefsFromMarkdown("`out/demo.mp4#t=2`")).toEqual([]);
    expect(extractMediaRefsFromMarkdown("`out/demo.mp4#t=2`", "/repo")).toEqual([
      { path: "out/demo.mp4", start: 2, absolute: "/repo/out/demo.mp4" },
    ]);
    expect(extractMediaRefsFromMarkdown("[x](./out/demo.mp4)", "/repo/").map((r) => r.absolute)).toEqual([
      "/repo/out/demo.mp4",
    ]);
  });

  it("片段写坏：引用仍在，从头播", () => {
    expect(extractMediaRefsFromMarkdown("`/out/a.mp4#t=abc`")).toEqual([
      { path: "/out/a.mp4", absolute: "/out/a.mp4" },
    ]);
  });

  it("CRLF 换行也能正常工作（含围栏）", () => {
    const text = "`/a/one.mp4`\r\n```\r\n`/a/hidden.mp4`\r\n```\r\n`/a/two.mp4`\r\n";
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/one.mp4", "/a/two.mp4"]);
  });
});

describe("extractMediaRefsFromMarkdown：顺序与去重", () => {
  it("按出现顺序（跨行）", () => {
    const text = ["第一：`/a/one.mp4`", "第二：[b](/a/two.mp3)", "第三：`/a/three.webm`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual([
      "/a/one.mp4",
      "/a/two.mp3",
      "/a/three.webm",
    ]);
  });

  it("同一行里链接在前、行内代码在后 → 按列位置排序，而不是「先代码后链接」", () => {
    const text = "[b](/a/link.mp3) 然后 `/a/code.mp4`";
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/link.mp3", "/a/code.mp4"]);
    const text2 = "`/a/code.mp4` 然后 [b](/a/link.mp3)";
    expect(extractMediaRefsFromMarkdown(text2).map((r) => r.absolute)).toEqual(["/a/code.mp4", "/a/link.mp3"]);
  });

  it("同一个文件只保留第一次出现（片段以第一次为准）", () => {
    const text = "`/a/one.mp4#t=5` 再来 `/a/one.mp4#t=50,60` 和 [again](/a/one.mp4)";
    const refs = extractMediaRefsFromMarkdown(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ absolute: "/a/one.mp4", start: 5 });
    expect(refs[0]?.end).toBeUndefined();
  });

  it("去重按解析后的绝对路径：相对写法与绝对写法算同一个文件", () => {
    const text = "`out/a.mp4` 和 `/repo/out/a.mp4` 和 `./out/a.mp4`";
    expect(extractMediaRefsFromMarkdown(text, "/repo").map((r) => r.absolute)).toEqual(["/repo/out/a.mp4"]);
  });

  it("不同文件各占一个名额", () => {
    const text = "`/a/one.mp4` `/a/two.mp4` `/a/one.mp4`";
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/one.mp4", "/a/two.mp4"]);
  });
});

describe("extractMediaRefsFromMarkdown：上限", () => {
  const many = (n: number, prefix = "f") =>
    Array.from({ length: n }, (_, i) => `- \`/a/${prefix}${i}.mp4\``).join("\n");

  it("最多 12 个，保留靠前的", () => {
    expect(MAX_MEDIA_REFS_PER_MESSAGE).toBe(12);
    const refs = extractMediaRefsFromMarkdown(many(30));
    expect(refs).toHaveLength(12);
    expect(refs.map((r) => r.absolute)).toEqual(Array.from({ length: 12 }, (_, i) => `/a/f${i}.mp4`));
  });

  it("恰好 12 个全留，11 个不被截", () => {
    expect(extractMediaRefsFromMarkdown(many(12))).toHaveLength(12);
    expect(extractMediaRefsFromMarkdown(many(11))).toHaveLength(11);
  });

  it("同一行里塞了很多个也只收 12 个（行内上限）", () => {
    const line = Array.from({ length: 20 }, (_, i) => `\`/a/x${i}.mp3\``).join(" ");
    const refs = extractMediaRefsFromMarkdown(line);
    expect(refs).toHaveLength(12);
    expect(refs[11]?.absolute).toBe("/a/x11.mp3");
  });

  it("重复的不占名额：先重复 20 次，再 11 个不同文件，一共 12 个", () => {
    const dup = Array.from({ length: 20 }, () => "`/a/dup.mp4`").join("\n");
    const refs = extractMediaRefsFromMarkdown(`${dup}\n${many(20, "g")}`);
    expect(refs).toHaveLength(12);
    expect(refs[0]?.absolute).toBe("/a/dup.mp4");
    expect(refs[11]?.absolute).toBe("/a/g10.mp4");
  });

  it("非媒体的行内代码不占名额", () => {
    const noise = Array.from({ length: 30 }, (_, i) => `\`/src/f${i}.ts\``).join("\n");
    expect(extractMediaRefsFromMarkdown(`${noise}\n${many(5)}`)).toHaveLength(5);
  });
});

describe("extractMediaRefsFromMarkdown：围栏代码块里的不算", () => {
  it("``` 围栏内的行内代码和链接都忽略，围栏外照常", () => {
    const text = [
      "`/a/before.mp4`",
      "```bash",
      "ffmpeg -i `/a/inside.mp4` out.mp3",
      "[x](/a/inside2.mp4)",
      "```",
      "`/a/after.mp4`",
    ].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/before.mp4", "/a/after.mp4"]);
  });

  it("~~~ 围栏", () => {
    const text = ["~~~", "`/a/inside.mp4`", "~~~", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("更长的围栏：内部较短的围栏行不会提前关闭", () => {
    const text = [
      "````markdown",
      "```",
      "`/a/inside1.mp4`",
      "```",
      "`/a/inside2.mp4`",
      "````",
      "`/a/after.mp4`",
    ].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("关闭围栏可以比开启的更长，但不能更短", () => {
    const longer = ["```", "`/a/inside.mp4`", "`````", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(longer).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
    const shorter = ["````", "`/a/inside.mp4`", "```", "`/a/still-inside.mp4`", "````", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(shorter).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("``` 与 ~~~ 互不关闭", () => {
    const text = ["```", "~~~", "`/a/inside1.mp4`", "~~~", "```", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
    const text2 = ["~~~", "```", "`/a/inside.mp4`", "```", "~~~", "`/a/after2.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text2).map((r) => r.absolute)).toEqual(["/a/after2.mp4"]);
  });

  it("围栏最多缩进 3 个空格", () => {
    const text = ["   ```", "`/a/inside.mp4`", "   ```", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("未闭合的围栏：其后到文末都算围栏内", () => {
    const text = ["`/a/before.mp4`", "```", "`/a/inside.mp4`", "`/a/inside2.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/before.mp4"]);
  });

  it("多个围栏块之间的内容照常提取", () => {
    const text = [
      "```",
      "`/a/in1.mp4`",
      "```",
      "`/a/mid.mp4`",
      "~~~",
      "`/a/in2.mp4`",
      "~~~",
      "`/a/end.mp4`",
    ].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/mid.mp4", "/a/end.mp4"]);
  });

  it("围栏内的路径不占去重 / 名额：外面同一个文件仍能提取", () => {
    const text = ["```", "`/a/same.mp4#t=1`", "```", "`/a/same.mp4#t=9`"].join("\n");
    const refs = extractMediaRefsFromMarkdown(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.start).toBe(9);
  });

  it("关闭围栏的那一行不能带说明文字（```js 是新的开头，不是结尾）", () => {
    // CommonMark：关闭围栏后只能有空白。围栏里出现 ```js 说明是嵌套示例，不能当结尾
    const text = ["```markdown", "```js", "`/a/inside.mp4`", "```", "`/a/after.mp4`"].join("\n");
    // 外层 ```markdown 一直开到那行裸 ```，所以 inside 在围栏里；after 在围栏外
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("以三个反引号开头的行内代码不是围栏（info 里不能有反引号）：后面的内容不会被吞掉", () => {
    const text = ["```/a/inline.mp4``` 是行内写法", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/inline.mp4", "/a/after.mp4"]);
  });

  it("~~~ 围栏的说明文字允许带反引号（仍是围栏）", () => {
    const text = ["~~~ a`b", "`/a/inside.mp4`", "~~~", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });

  it("关闭围栏后允许有尾随空白（含 CRLF 的 \\r）", () => {
    const text = ["```bash", "`/a/inside.mp4`", "```   ", "`/a/after.mp4`"].join("\n");
    expect(extractMediaRefsFromMarkdown(text).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
    const crlf = ["```bash", "`/a/inside.mp4`", "```", "`/a/after.mp4`"].join("\r\n");
    expect(extractMediaRefsFromMarkdown(crlf).map((r) => r.absolute)).toEqual(["/a/after.mp4"]);
  });
});
