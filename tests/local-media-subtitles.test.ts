/**
 * 字幕 sidecar 测试：`findSidecarSubtitles` / `srtToVtt` / `decodeSubtitleBytes` / `readSubtitleAsVtt`，
 * 以及两个字幕路由（`/api/local-media/subtitles` 列表、`/api/local-media/subtitle` 取 vtt）。
 *
 * 全部用 `os.tmpdir()` 下的 `fvt-media-` 临时目录里造的假文件；afterAll 精确删除这一个目录。
 */
import { execFileSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as listGET, dynamic as listDynamic, runtime as listRuntime } from "@/app/api/local-media/subtitles/route";
import { GET as vttGET, dynamic as vttDynamic, runtime as vttRuntime } from "@/app/api/local-media/subtitle/route";
import {
  MAX_SUBTITLE_BYTES,
  decodeSubtitleBytes,
  findSidecarSubtitles,
  readSubtitleAsVtt,
  srtToVtt,
} from "@/lib/server/local-media-subtitles";
import { UNC_REJECT_MESSAGE } from "@/lib/unc-path";

let root = "";
const p = (...segs: string[]): string => path.join(root, ...segs);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fvt-media-"));
});

afterAll(async () => {
  // 只删自己创建的这一个目录（精确路径）
  if (root) await fs.rm(root, { recursive: true, force: true });
});

/** 在 root 下新建一个子目录，并按名字造一批空文件；返回目录路径 */
const makeDir = async (dirName: string, files: string[]): Promise<string> => {
  const dir = p(dirName);
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(path.join(dir, f), "x");
  return dir;
};

const namesOf = (items: Array<{ path: string }>): string[] => items.map((i) => path.basename(i.path));

// GB18030 / GBK 字节（Node 没有 gb18030 编码器，直接写死）
const GB_NIHAO = [0xc4, 0xe3, 0xba, 0xc3]; // 你好
const GB_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]; // 中文
const GB_SENTENCE = [0xd7, 0xd6, 0xc4, 0xbb, 0xb2, 0xe2, 0xca, 0xd4, 0xa3, 0xac, 0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xa1]; // 字幕测试，你好！
const GB_SUPPLEMENTARY = [0x95, 0x32, 0x82, 0x36]; // U+20000（四字节形态）

describe("findSidecarSubtitles", () => {
  it("同名 .srt / .vtt（无语言段）→ label「字幕」，路径是同目录绝对路径", async () => {
    const dir = await makeDir("f-basic", ["movie.mp4", "movie.srt", "movie.vtt"]);
    const items = await findSidecarSubtitles(p("f-basic", "movie.mp4"));
    expect(items).toEqual([
      { path: path.join(dir, "movie.vtt"), label: "字幕" },
      { path: path.join(dir, "movie.srt"), label: "字幕" },
    ]);
    for (const it_ of items) expect(path.isAbsolute(it_.path)).toBe(true);
  });

  it.each([
    ["zh", "中文"],
    ["zh-CN", "简体中文"],
    ["zh-Hans", "简体中文"],
    ["chs", "简体中文"],
    ["zh-TW", "繁体中文"],
    ["zh-Hant", "繁体中文"],
    ["cht", "繁体中文"],
    ["en", "English"],
    ["eng", "English"],
    ["ja", "日本語"],
    ["jp", "日本語"],
    ["ko", "한국어"],
    ["ZH", "中文"], // 查表不区分大小写
    ["fr", "fr"], // 表里没有：原样当 label
    ["FR", "FR"],
    ["pt_BR", "pt_BR"],
  ])("带语言段 movie.%s.srt → label %s", async (tag, label) => {
    // 目录名用 hex：macOS 默认文件系统不区分大小写，`zh` / `ZH` 直接拼会撞成同一个目录
    const dirName = `f-lang-${Buffer.from(tag).toString("hex")}`;
    const dir = await makeDir(dirName, ["movie.mp4", `movie.${tag}.srt`]);
    const items = await findSidecarSubtitles(path.join(dir, "movie.mp4"));
    expect(items).toEqual([{ path: path.join(dir, `movie.${tag}.srt`), label }]);
  });

  it("带语言段的 .vtt（x.zh-CN.vtt）", async () => {
    const dir = await makeDir("f-lang-vtt", ["movie.mp4", "movie.zh-CN.vtt"]);
    const items = await findSidecarSubtitles(path.join(dir, "movie.mp4"));
    expect(items).toEqual([{ path: path.join(dir, "movie.zh-CN.vtt"), label: "简体中文" }]);
  });

  it("x.mp4.srt：媒体扩展名不算语言，label「字幕」", async () => {
    const dir = await makeDir("f-mediaext", ["movie.mp4", "movie.mp4.srt", "movie.MP4.vtt"]);
    const items = await findSidecarSubtitles(path.join(dir, "movie.mp4"));
    expect(items.map((i) => i.label)).toEqual(["字幕", "字幕"]);
    expect(namesOf(items).sort()).toEqual(["movie.MP4.vtt", "movie.mp4.srt"].sort());
  });

  it("别的名字一律不匹配", async () => {
    const dir = await makeDir("f-nomatch", [
      "movie.mp4",
      "movie2.srt",
      "movie-zh.srt",
      "moviesrt",
      "movie.srtx",
      "movie.txt",
      "movie.zh.ass",
      "movie.zh.sub",
      "movie.zh.srt.bak",
      "movie.a.b.srt", // 两段语言
      "movie.zh cn.srt", // 空格
      "movie.zh.cn.srt",
      "other.srt",
      "xmovie.srt",
      "my movie.srt",
      "mov.srt",
      "movie",
      ".srt",
      "movie.17-chars-tag-xxxxx.srt", // 超过 16 个字符
    ]);
    expect(await findSidecarSubtitles(path.join(dir, "movie.mp4"))).toEqual([]);
  });

  it("语言段长度上限 16：16 个字符可以、17 个不行", async () => {
    const ok = "a".repeat(16);
    const bad = "a".repeat(17);
    const dir = await makeDir("f-taglen", ["movie.mp4", `movie.${ok}.srt`, `movie.${bad}.srt`]);
    const items = await findSidecarSubtitles(path.join(dir, "movie.mp4"));
    expect(namesOf(items)).toEqual([`movie.${ok}.srt`]);
  });

  it("文件名前缀不区分大小写（Show.MP4 ↔ show.srt / SHOW.ZH.VTT）", async () => {
    const dir = await makeDir("f-case", ["Show.MP4", "show.srt", "SHOW.ZH.VTT"]);
    const items = await findSidecarSubtitles(path.join(dir, "Show.MP4"));
    expect(items).toEqual([
      { path: path.join(dir, "show.srt"), label: "字幕" },
      { path: path.join(dir, "SHOW.ZH.VTT"), label: "中文" },
    ]);
  });

  it("中文文件名 / 带括号加号的文件名", async () => {
    const dir = await makeDir("f-names", [
      "电影.mp4",
      "电影.srt",
      "电影.zh.vtt",
      "a+b (1) [x].mp4",
      "a+b (1) [x].srt",
    ]);
    expect(namesOf(await findSidecarSubtitles(path.join(dir, "电影.mp4")))).toEqual(["电影.srt", "电影.zh.vtt"]);
    expect(namesOf(await findSidecarSubtitles(path.join(dir, "a+b (1) [x].mp4")))).toEqual(["a+b (1) [x].srt"]);
  });

  it("没有字幕 → []；目录不存在 → []", async () => {
    const dir = await makeDir("f-none", ["movie.mp4", "readme.txt"]);
    expect(await findSidecarSubtitles(path.join(dir, "movie.mp4"))).toEqual([]);
    expect(await findSidecarSubtitles(p("f-missing-dir", "movie.mp4"))).toEqual([]);
  });

  describe("排序", () => {
    it("无语言段的在前（即使它是 srt、对面是带语言段的 vtt）", async () => {
      const dir = await makeDir("f-sort-lang", ["movie.mp4", "movie.zh.vtt", "movie.srt"]);
      expect(namesOf(await findSidecarSubtitles(path.join(dir, "movie.mp4")))).toEqual(["movie.srt", "movie.zh.vtt"]);
    });

    it("同组内 vtt 在 srt 前", async () => {
      const a = await makeDir("f-sort-ext-a", ["movie.mp4", "movie.srt", "movie.vtt"]);
      expect(namesOf(await findSidecarSubtitles(path.join(a, "movie.mp4")))).toEqual(["movie.vtt", "movie.srt"]);
      const b = await makeDir("f-sort-ext-b", ["movie.mp4", "movie.en.srt", "movie.zh.vtt"]);
      expect(namesOf(await findSidecarSubtitles(path.join(b, "movie.mp4")))).toEqual(["movie.zh.vtt", "movie.en.srt"]);
    });

    it("同组同类型按文件名排", async () => {
      const dir = await makeDir("f-sort-name", ["movie.mp4", "movie.zh.srt", "movie.en.srt", "movie.ja.srt"]);
      expect(namesOf(await findSidecarSubtitles(path.join(dir, "movie.mp4")))).toEqual([
        "movie.en.srt",
        "movie.ja.srt",
        "movie.zh.srt",
      ]);
    });

    it("综合：无语言(vtt→srt) → 有语言(vtt→srt)；结果与创建顺序无关", async () => {
      const expected = [
        "movie.vtt",
        "movie.mp4.srt",
        "movie.srt",
        "movie.zh-CN.vtt",
        "movie.en.srt",
        "movie.zh.srt",
      ];
      const forward = ["movie.mp4", ...expected];
      const dirA = await makeDir("f-sort-all-a", forward);
      const dirB = await makeDir("f-sort-all-b", [...forward].reverse());
      expect(namesOf(await findSidecarSubtitles(path.join(dirA, "movie.mp4")))).toEqual(expected);
      expect(namesOf(await findSidecarSubtitles(path.join(dirB, "movie.mp4")))).toEqual(expected);
    });
  });

  describe("最多 6 个", () => {
    it("恰好 6 个全返回", async () => {
      const dir = await makeDir("f-cap-6", [
        "movie.mp4",
        "movie.vtt",
        "movie.srt",
        "movie.aa.vtt",
        "movie.bb.vtt",
        "movie.aa.srt",
        "movie.bb.srt",
      ]);
      expect(await findSidecarSubtitles(path.join(dir, "movie.mp4"))).toHaveLength(6);
    });

    it("超过 6 个：只留排序后的前 6", async () => {
      const dir = await makeDir("f-cap-9", [
        "movie.mp4",
        "movie.vtt",
        "movie.srt",
        "movie.aa.vtt",
        "movie.bb.vtt",
        "movie.cc.vtt",
        "movie.aa.srt",
        "movie.bb.srt",
        "movie.cc.srt",
        "movie.dd.srt",
      ]);
      const items = await findSidecarSubtitles(path.join(dir, "movie.mp4"));
      expect(namesOf(items)).toEqual([
        "movie.vtt",
        "movie.srt",
        "movie.aa.vtt",
        "movie.bb.vtt",
        "movie.cc.vtt",
        "movie.aa.srt",
      ]);
    });
  });

  describe("只列真正能读的普通文件", () => {
    it("目录冒充字幕（叫 movie.srt 的目录）不列出", async () => {
      const dir = await makeDir("f-dir-fake", ["movie.mp4", "movie.vtt"]);
      await fs.mkdir(path.join(dir, "movie.srt"));
      await fs.mkdir(path.join(dir, "movie.zh.vtt"));
      expect(namesOf(await findSidecarSubtitles(path.join(dir, "movie.mp4")))).toEqual(["movie.vtt"]);
    });

    it("软链指向真字幕文件 → 列出；悬空软链 → 不列出", async () => {
      const dir = await makeDir("f-symlink", ["movie.mp4", "real-sub.srt"]);
      await fs.symlink(path.join(dir, "real-sub.srt"), path.join(dir, "movie.en.srt"));
      await fs.symlink(path.join(dir, "nowhere.srt"), path.join(dir, "movie.fr.srt"));
      expect(namesOf(await findSidecarSubtitles(path.join(dir, "movie.mp4")))).toEqual(["movie.en.srt"]);
    });
  });
});

describe("srtToVtt", () => {
  const SRT = [
    "1",
    "00:00:01,000 --> 00:00:02,500",
    "Hello",
    "",
    "2",
    "00:00:03,000 --> 00:00:04,250",
    "World",
    "",
  ];

  it("补 WEBVTT 头、时间戳逗号换成点", () => {
    expect(srtToVtt(SRT.join("\n"))).toBe(
      [
        "WEBVTT",
        "",
        "1",
        "00:00:01.000 --> 00:00:02.500",
        "Hello",
        "",
        "2",
        "00:00:03.000 --> 00:00:04.250",
        "World",
        "",
      ].join("\n"),
    );
  });

  it("去掉开头的 BOM", () => {
    const out = srtToVtt(`\uFEFF${SRT.join("\n")}`);
    expect(out.startsWith("WEBVTT\n\n1\n")).toBe(true);
    expect(out).not.toContain("\uFEFF");
  });

  it("CRLF → LF，单独的 CR → LF", () => {
    const crlf = srtToVtt(SRT.join("\r\n"));
    const cr = srtToVtt(SRT.join("\r"));
    const lf = srtToVtt(SRT.join("\n"));
    expect(crlf).toBe(lf);
    expect(cr).toBe(lf);
    expect(crlf).not.toContain("\r");
  });

  it("BOM + CRLF 一起来", () => {
    expect(srtToVtt(`\uFEFF${SRT.join("\r\n")}`)).toBe(srtToVtt(SRT.join("\n")));
  });

  it("毫秒位数不足时右侧补零（,5 → .500，,50 → .500）", () => {
    expect(srtToVtt("1\n00:00:01,5 --> 00:00:02,50\nx")).toContain("00:00:01.500 --> 00:00:02.500");
  });

  it("小时只有一位也转换", () => {
    expect(srtToVtt("1\n1:02:03,004 --> 1:02:04,005\nx")).toContain("1:02:03.004 --> 1:02:04.005");
  });

  it("时间行后面的 cue 设置原样保留", () => {
    expect(srtToVtt("1\n00:00:01,000 --> 00:00:02,000 line:90%\nx")).toContain(
      "00:00:01.000 --> 00:00:02.000 line:90%",
    );
  });

  it("多行台词 / 序号行保留，首尾空行去掉、末尾只有一个换行", () => {
    const out = srtToVtt("\n\n1\n00:00:01,000 --> 00:00:02,000\n第一行\n第二行\n\n\n\n");
    expect(out).toBe("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n第一行\n第二行\n");
  });

  it("已是 WEBVTT：内容原样（只统一换行、去 BOM），时间戳 / 逗号都不动", () => {
    const vtt = "WEBVTT\n\nNOTE 注释, 里面有 00:00:01,000\n\n00:00:01.000 --> 00:00:02.000\n12:30:45,678 不改\n";
    expect(srtToVtt(vtt)).toBe(vtt);
    expect(srtToVtt(vtt.replace(/\n/g, "\r\n"))).toBe(vtt);
    expect(srtToVtt(`\uFEFF${vtt}`)).toBe(vtt);
  });

  it("WEBVTT 头后面带说明文字（WEBVTT - title）也算 vtt", () => {
    const vtt = "WEBVTT - 标题\n\n00:00:01.000 --> 00:00:02.000\nhi\n";
    expect(srtToVtt(vtt)).toBe(vtt);
  });

  it("正文里的逗号数字（1,234）和普通逗号不被改", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\n共 1,234 人，Hello, world\n");
    expect(out).toContain("共 1,234 人，Hello, world");
  });

  it("台词里恰好长得像时间戳的文字不被改写（只改时间行）", () => {
    const out = srtToVtt("1\n00:00:01,000 --> 00:00:02,000\n会议 10:20:30,5 开始\n");
    expect(out).toContain("会议 10:20:30,5 开始");
    expect(out).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("幂等：转两次与转一次相同", () => {
    const once = srtToVtt(SRT.join("\r\n"));
    expect(srtToVtt(once)).toBe(once);
  });

  it("空输入也给出合法的 WEBVTT 头", () => {
    expect(srtToVtt("").startsWith("WEBVTT\n\n")).toBe(true);
  });
});

describe("decodeSubtitleBytes", () => {
  it("UTF-8 中文", () => {
    expect(decodeSubtitleBytes(Buffer.from("你好，世界 😀", "utf8"))).toBe("你好，世界 😀");
  });

  it("UTF-8 严格优先：合法的 UTF-8 不会被当成 GB18030 解成乱码", () => {
    const text = decodeSubtitleBytes(Buffer.from("中文字幕", "utf8"));
    expect(text).toBe("中文字幕");
  });

  it("带 UTF-8 BOM：BOM 被吃掉，不进文本", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("你好", "utf8")]);
    expect(decodeSubtitleBytes(buf)).toBe("你好");
  });

  it("GB18030 / GBK 中文", () => {
    expect(decodeSubtitleBytes(Uint8Array.from(GB_NIHAO))).toBe("你好");
    expect(decodeSubtitleBytes(Uint8Array.from(GB_SENTENCE))).toBe("字幕测试，你好！");
  });

  it("GB18030 四字节形态", () => {
    expect(decodeSubtitleBytes(Uint8Array.from(GB_SUPPLEMENTARY))).toBe("\u{20000}");
  });

  it("GB 中文夹 ASCII（真实 srt 形态）", () => {
    const buf = Buffer.concat([
      Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\n"),
      Buffer.from(GB_ZHONGWEN),
      Buffer.from(" subtitle\r\n"),
    ]);
    expect(decodeSubtitleBytes(buf)).toBe("1\r\n00:00:01,000 --> 00:00:02,000\r\n中文 subtitle\r\n");
  });

  it("纯 ASCII / 空输入", () => {
    expect(decodeSubtitleBytes(Buffer.from("hello"))).toBe("hello");
    expect(decodeSubtitleBytes(new Uint8Array(0))).toBe("");
  });

  it("两种编码都不合法 → 宽松 UTF-8（坏字节变 U+FFFD，不抛）", () => {
    expect(decodeSubtitleBytes(Uint8Array.from([0x61, 0xff, 0x62]))).toBe("a\uFFFDb");
  });
});

describe("readSubtitleAsVtt", () => {
  const writeSub = async (name: string, data: string | Uint8Array): Promise<string> => {
    const dir = p("r");
    await fs.mkdir(dir, { recursive: true });
    const f = path.join(dir, name);
    await fs.writeFile(f, data);
    return f;
  };

  it("UTF-8 srt → vtt", async () => {
    const f = await writeSub("a.srt", "\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n");
    expect(await readSubtitleAsVtt(f)).toEqual({
      ok: true,
      vtt: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n你好\n",
    });
  });

  it("GB18030 srt → 中文不乱码的 vtt", async () => {
    const f = await writeSub(
      "gbk.srt",
      Buffer.concat([
        Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\n"),
        Buffer.from(GB_NIHAO),
        Buffer.from("\r\n"),
      ]),
    );
    expect(await readSubtitleAsVtt(f)).toEqual({
      ok: true,
      vtt: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n你好\n",
    });
  });

  it(".vtt 原样通过（带 BOM / CRLF 时只规整）", async () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n";
    const f = await writeSub("a.vtt", vtt);
    expect(await readSubtitleAsVtt(f)).toEqual({ ok: true, vtt });
    const g = await writeSub("bom.vtt", `\uFEFF${vtt.replace(/\n/g, "\r\n")}`);
    expect(await readSubtitleAsVtt(g)).toEqual({ ok: true, vtt });
  });

  it("扩展名大小写不敏感（.SRT）", async () => {
    const f = await writeSub("UP.SRT", "1\n00:00:01,000 --> 00:00:02,000\nx\n");
    expect((await readSubtitleAsVtt(f)).ok).toBe(true);
  });

  it("首尾空白的路径也行", async () => {
    const f = await writeSub("trim.srt", "1\n00:00:01,000 --> 00:00:02,000\nx\n");
    expect((await readSubtitleAsVtt(`  ${f} `)).ok).toBe(true);
  });

  it("空文件：ok，仍是合法 WEBVTT 头", async () => {
    const f = await writeSub("empty.srt", "");
    const r = await readSubtitleAsVtt(f);
    expect(r.ok && r.vtt.startsWith("WEBVTT")).toBe(true);
  });

  it("path 为空 / 全空白 → 400", async () => {
    expect(await readSubtitleAsVtt("")).toMatchObject({ ok: false, status: 400 });
    expect(await readSubtitleAsVtt("   ")).toMatchObject({ ok: false, status: 400 });
  });

  it.each(["a.srt", "./a.srt", "../a.srt", "sub/a.srt", "file:///tmp/a.srt"])("相对路径 %j → 400", async (raw) => {
    expect(await readSubtitleAsVtt(raw)).toMatchObject({ ok: false, status: 400 });
  });

  it.each(["//host/share/a.srt", "\\\\host\\share\\a.srt", "\\\\?\\UNC\\host\\share\\a.vtt", "file:////host/share/a.srt"])(
    "UNC %j → 400",
    async (raw) => {
      const r = await readSubtitleAsVtt(raw);
      expect(r).toMatchObject({ ok: false, status: 400 });
      expect(!r.ok && r.error).toContain(UNC_REJECT_MESSAGE);
    },
  );

  it.each(["note.txt", "movie.mp4", "pic.svg", "code.ts", "noext", "sub.srt.txt", "sub.ass"])(
    "非字幕扩展名 %s（文件真实存在）→ 400，不读",
    async (name) => {
      const f = await writeSub(name, "SECRET");
      const r = await readSubtitleAsVtt(f);
      expect(r).toMatchObject({ ok: false, status: 400 });
      expect(JSON.stringify(r)).not.toContain("SECRET");
    },
  );

  it("不存在 → 404", async () => {
    expect(await readSubtitleAsVtt(p("r", "missing.srt"))).toMatchObject({ ok: false, status: 404 });
  });

  it("目录（叫 dir.srt）→ 404", async () => {
    await fs.mkdir(p("r", "dir.srt"), { recursive: true });
    expect(await readSubtitleAsVtt(p("r", "dir.srt"))).toMatchObject({ ok: false, status: 404 });
  });

  it("软链（叫 .srt）指到非字幕文件 → 404，不泄露内容", async () => {
    const secret = await writeSub("secret.txt", "SECRET");
    const link = p("r", "link-secret.srt");
    await fs.symlink(secret, link);
    const r = await readSubtitleAsVtt(link);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("软链指到真字幕 → 正常读", async () => {
    const real = await writeSub("real-for-link.srt", "1\n00:00:01,000 --> 00:00:02,000\nlinked\n");
    const link = p("r", "link-ok.vtt");
    // 软链名是 .vtt、目标是 .srt：两头都是字幕扩展名，放行；内容按 srt 转
    await fs.symlink(real, link);
    const r = await readSubtitleAsVtt(link);
    expect(r.ok && r.vtt).toContain("00:00:01.000 --> 00:00:02.000");
  });

  it("悬空软链 → 404", async () => {
    const link = p("r", "dangling.srt");
    await fs.symlink(p("r", "no-such.srt"), link);
    expect(await readSubtitleAsVtt(link)).toMatchObject({ ok: false, status: 404 });
  });

  // 目录会被 readFile 抛 EISDIR 兜成 404，看不出 isFile 守卫；命名管道才是它的真实价值（readFile 会一直等写端）
  it.skipIf(process.platform === "win32")("命名管道（叫 pipe.srt）→ 404「不是文件」，不会挂起去读", async () => {
    await fs.mkdir(p("r"), { recursive: true });
    const fifo = p("r", "pipe.srt");
    execFileSync("mkfifo", [fifo]);
    // 自己先以读写方式持有管道：万一被测代码去读它，只会阻塞在 read；测试结尾关掉我这一端，挂起的 read 会收到 EOF 而结束，不留泄漏
    const keeper = await fs.open(fifo, fsConstants.O_RDWR);
    try {
      const hung = Symbol("hung");
      const result = await Promise.race([
        readSubtitleAsVtt(fifo),
        new Promise<typeof hung>((r) => setTimeout(() => r(hung), 1500)),
      ]);
      expect(result).not.toBe(hung);
      expect(result).toMatchObject({ ok: false, status: 404, error: expect.stringContaining("不是文件") });
    } finally {
      await keeper.close();
    }
  });

  it("恰好 2MB → 放行；超过 2MB 一个字节 → 413", async () => {
    expect(MAX_SUBTITLE_BYTES).toBe(2 * 1024 * 1024);
    const atLimit = await writeSub("at-limit.srt", Buffer.alloc(MAX_SUBTITLE_BYTES, 0x61));
    expect((await readSubtitleAsVtt(atLimit)).ok).toBe(true);
    const over = await writeSub("over-limit.srt", Buffer.alloc(MAX_SUBTITLE_BYTES + 1, 0x61));
    const r = await readSubtitleAsVtt(over);
    expect(r).toMatchObject({ ok: false, status: 413 });
    expect(!r.ok && r.error).toContain("2MB");
  });

  it("超大文件（稀疏 64MB）→ 413，不会真去读", async () => {
    const f = p("r", "huge.vtt");
    const fh = await fs.open(f, "w");
    try {
      await fh.truncate(64 * 1024 * 1024);
    } finally {
      await fh.close();
    }
    const t0 = performance.now();
    expect(await readSubtitleAsVtt(f)).toMatchObject({ ok: false, status: 413 });
    expect(performance.now() - t0).toBeLessThan(1000);
    await fs.rm(f, { force: true });
  });
});

describe("字幕路由", () => {
  const LIST = "http://127.0.0.1:3000/api/local-media/subtitles";
  const VTT = "http://127.0.0.1:3000/api/local-media/subtitle";
  const list = (raw: string): Promise<Response> => listGET(new Request(`${LIST}?path=${encodeURIComponent(raw)}`));
  const vtt = (raw: string): Promise<Response> => vttGET(new Request(`${VTT}?path=${encodeURIComponent(raw)}`));

  let mediaDir = "";
  let mediaReal = "";

  beforeAll(async () => {
    mediaDir = await makeDir("rt-media", [
      "movie.mp4",
      "movie.srt",
      "movie.zh.vtt",
      "movie.en.srt",
      "bare.mp4",
      "note.txt",
    ]);
    mediaReal = await fs.realpath(mediaDir);
    await fs.mkdir(path.join(mediaDir, "dir.mp4"));
    await fs.writeFile(path.join(mediaDir, "note.txt"), "SECRET");
    // 真字幕内容：UTF-8 srt / GBK srt / 原生 vtt
    await fs.writeFile(
      path.join(mediaDir, "movie.srt"),
      "1\r\n00:00:01,000 --> 00:00:02,000\r\n你好\r\n",
    );
    await fs.writeFile(
      path.join(mediaDir, "movie.en.srt"),
      Buffer.concat([
        Buffer.from("1\r\n00:00:01,000 --> 00:00:02,000\r\n"),
        Buffer.from(GB_NIHAO),
        Buffer.from("\r\n"),
      ]),
    );
    await fs.writeFile(
      path.join(mediaDir, "movie.zh.vtt"),
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n原生 vtt\n",
    );
    // 媒体软链（链接名下没有字幕，字幕在真实文件旁边）
    await fs.symlink(path.join(mediaDir, "movie.mp4"), path.join(mediaDir, "alias.mp4"));
    await fs.symlink(path.join(mediaDir, "note.txt"), path.join(mediaDir, "link-secret.mp4"));
  });

  describe("路由壳", () => {
    it("runtime nodejs、force-dynamic", () => {
      expect(listRuntime).toBe("nodejs");
      expect(listDynamic).toBe("force-dynamic");
      expect(vttRuntime).toBe("nodejs");
      expect(vttDynamic).toBe("force-dynamic");
    });
  });

  describe("GET /subtitles（列表 JSON）", () => {
    it("200：{ items: [{ path, label }] }，真实路径、排序正确、no-store", async () => {
      const res = await list(path.join(mediaDir, "movie.mp4"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({
        items: [
          { path: path.join(mediaReal, "movie.srt"), label: "字幕" },
          { path: path.join(mediaReal, "movie.zh.vtt"), label: "中文" },
          { path: path.join(mediaReal, "movie.en.srt"), label: "English" },
        ],
      });
    });

    it("每个 item 恰好只有 path / label 两个字段", async () => {
      const body = (await (await list(path.join(mediaDir, "movie.mp4"))).json()) as {
        items: Array<Record<string, unknown>>;
      };
      for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["label", "path"]);
    });

    it("没有字幕不是错误：200 + items: []", async () => {
      const res = await list(path.join(mediaDir, "bare.mp4"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it("媒体是软链：字幕按真实文件所在目录 / 文件名找", async () => {
      const res = await list(path.join(mediaDir, "alias.mp4"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ path: string }> };
      expect(namesOf(body.items)).toEqual(["movie.srt", "movie.zh.vtt", "movie.en.srt"]);
    });

    it("最多 6 个", async () => {
      const dir = await makeDir("rt-cap", [
        "m.mp4",
        ...Array.from({ length: 10 }, (_, i) => `m.l${i}.srt`),
      ]);
      const body = (await (await list(path.join(dir, "m.mp4"))).json()) as { items: unknown[] };
      expect(body.items).toHaveLength(6);
    });

    it("字幕列表 → 逐个去 /subtitle 取 vtt：全部 200 且是 WEBVTT", async () => {
      const body = (await (await list(path.join(mediaDir, "movie.mp4"))).json()) as {
        items: Array<{ path: string }>;
      };
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        const r = await vtt(item.path);
        expect(r.status, item.path).toBe(200);
        expect((await r.text()).startsWith("WEBVTT\n\n")).toBe(true);
      }
    });

    it("path 缺失 / 为空 → 400", async () => {
      expect((await listGET(new Request(LIST))).status).toBe(400);
      expect((await list("")).status).toBe(400);
    });

    it.each(["movie.mp4", "./movie.mp4", "file:///tmp/movie.mp4"])("相对路径 %j → 400", async (raw) => {
      expect((await list(raw)).status).toBe(400);
    });

    it.each(["//host/share/a.mp4", "\\\\host\\share\\a.mp4"])("UNC %j → 400 + JSON error", async (raw) => {
      const res = await list(raw);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(UNC_REJECT_MESSAGE);
    });

    it("媒体扩展名不在白名单（.txt）→ 400，返回 { error }", async () => {
      const res = await list(path.join(mediaDir, "note.txt"));
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    });

    it("媒体不存在 → 404", async () => {
      expect((await list(path.join(mediaDir, "nope.mp4"))).status).toBe(404);
    });

    it("媒体路径是目录 → 404", async () => {
      expect((await list(path.join(mediaDir, "dir.mp4"))).status).toBe(404);
    });

    it("媒体软链指到非媒体文件 → 404", async () => {
      expect((await list(path.join(mediaDir, "link-secret.mp4"))).status).toBe(404);
    });
  });

  describe("GET /subtitle（取 vtt）", () => {
    it("srt → 200，Content-Type: text/vtt; charset=utf-8，no-cache，nosniff", async () => {
      const res = await vtt(path.join(mediaDir, "movie.srt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await res.text()).toBe("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n你好\n");
    });

    it("GBK 编码的 srt → 中文正确", async () => {
      const res = await vtt(path.join(mediaDir, "movie.en.srt"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n你好\n");
    });

    it("原生 vtt → 200，内容原样、同样的 Content-Type", async () => {
      const res = await vtt(path.join(mediaDir, "movie.zh.vtt"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
      expect(await res.text()).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n原生 vtt\n");
    });

    it("body 以 UTF-8 编码发出（按字节解回来就是中文）", async () => {
      const res = await vtt(path.join(mediaDir, "movie.srt"));
      expect(new TextDecoder("utf-8", { fatal: true }).decode(await res.arrayBuffer())).toContain("你好");
    });

    it("path 缺失 / 为空 → 400", async () => {
      expect((await vttGET(new Request(VTT))).status).toBe(400);
      expect((await vtt("")).status).toBe(400);
    });

    it("相对路径 → 400；UNC → 400", async () => {
      expect((await vtt("movie.srt")).status).toBe(400);
      expect((await vtt("//host/share/a.srt")).status).toBe(400);
      expect((await vtt("\\\\host\\share\\a.srt")).status).toBe(400);
    });

    it("错误响应是 JSON { error }（不是 text/vtt）", async () => {
      const res = await vtt(path.join(mediaDir, "note.txt"));
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    });

    it("非字幕扩展名（.mp4 / .txt）→ 400", async () => {
      expect((await vtt(path.join(mediaDir, "movie.mp4"))).status).toBe(400);
      expect((await vtt(path.join(mediaDir, "note.txt"))).status).toBe(400);
    });

    it("不存在 → 404", async () => {
      expect((await vtt(path.join(mediaDir, "nope.srt"))).status).toBe(404);
    });

    it("超过 2MB → 413", async () => {
      const f = path.join(mediaDir, "big.srt");
      await fs.writeFile(f, Buffer.alloc(MAX_SUBTITLE_BYTES + 1, 0x61));
      const res = await vtt(f);
      expect(res.status).toBe(413);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    });

    it("软链（叫 .srt）指到非字幕文件 → 404，不泄露内容", async () => {
      const link = path.join(mediaDir, "leak.srt");
      await fs.symlink(path.join(mediaDir, "note.txt"), link);
      const res = await vtt(link);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    });
  });
});
