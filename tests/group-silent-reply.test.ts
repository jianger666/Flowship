/**
 * 群答疑「不回」哨兵（group-silent-reply）：首个非空行就是 NO_REPLY → 静默；
 * 流式中途的三态判定（silent / speak / undecided）。
 *
 * 回复协议整套下线后只剩这一条约定（2026-11-06），所以这里把边界钉死：
 * 宽松在「包裹 / 大小写 / 标点」，严格在「必须是首行本身」。
 */
import { describe, expect, it } from "vitest";

import {
  isSilentGroupReply,
  judgeGroupReply,
} from "@/lib/server/feishu-bridge/group-silent-reply";

describe("isSilentGroupReply：整条回复收尾后的判定", () => {
  it.each([
    "NO_REPLY",
    "no_reply",
    "No Reply",
    "NO-REPLY",
    "  NO_REPLY  ",
    "\n\nNO_REPLY",
    "`NO_REPLY`",
    "**NO_REPLY**",
    "「NO_REPLY」",
    "NO_REPLY。",
    "ＮＯ＿ＲＥＰＬＹ", // 全角
    "NO_REPLY\n对方只是确认，没有问题", // 首行是哨兵、后面是自我解释
    "NO_REPLY\r\n对方只是确认",
  ])("%j → 静默", (text) => {
    expect(isSilentGroupReply(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "收到",
    "先说结论。\nNO_REPLY", // 哨兵不在首行
    "NO_REPLY：对方只是确认", // 和别的字同一行 → 宁可发出去也不吞真回复
    "NO_REPLY 但我还是想补充一句",
    "NO_REPLYX",
    "NOREPLY是个什么东西？",
    "NO",
    "REPLY",
  ])("%j → 照常发", (text) => {
    expect(isSilentGroupReply(text)).toBe(false);
  });
});

describe("judgeGroupReply：流式中途的三态", () => {
  it("还没有任何非空内容 → undecided（先别起卡）", () => {
    expect(judgeGroupReply("")).toBe("undecided");
    expect(judgeGroupReply("  \n ")).toBe("undecided");
  });

  it.each(["N", "NO", "NO_", "NO_R", "NO_REP", "no re", "`NO_RE", "**NO_REPLY"])(
    "首行还只是哨兵的前缀 %j（没换行、没写满）→ undecided",
    (text) => {
      expect(judgeGroupReply(text)).toBe("undecided");
    },
  );

  it("哨兵写满但行还没结束（后面可能紧跟别的字）→ undecided；换行后 → silent", () => {
    expect(judgeGroupReply("NO_REPLY")).toBe("undecided");
    expect(judgeGroupReply("`NO_REPLY`")).toBe("undecided");
    expect(judgeGroupReply("NO_REPLY\n")).toBe("silent");
    expect(judgeGroupReply("NO_REPLY\n对方只是确认")).toBe("silent");
  });

  it("哨兵词后面接了别的字（同一行）→ 说话", () => {
    expect(judgeGroupReply("NO_REPLY：对方只是确认")).toBe("speak");
    expect(judgeGroupReply("NO_REPLYX")).toBe("speak");
  });

  it.each(["收到", "Nginx 配置在 conf.d", "NOT FOUND", "Node 版本要 18+", "结论：周五联调。"])(
    "正常回复 %j → speak",
    (text) => {
      expect(judgeGroupReply(text)).toBe("speak");
    },
  );

  it("首行是别的字、后面某行是 NO_REPLY → speak（只看首个非空行）", () => {
    expect(judgeGroupReply("先说结论。\nNO_REPLY")).toBe("speak");
  });

  it("首行前缀判定有长度上限：很长的纯标点首行不会一直 undecided（不能让回复永远起不了卡）", () => {
    // 折叠后为空（纯标点 / emoji）的首行，是任何字符串的前缀——靠 24 字上限兜住
    expect(judgeGroupReply("…".repeat(10))).toBe("undecided");
    expect(judgeGroupReply("…".repeat(40))).toBe("speak");
  });

  it("首行换行（写完了）且不是哨兵 → 立刻 speak，哪怕它是哨兵前缀", () => {
    expect(judgeGroupReply("NO\n后面是别的")).toBe("speak");
  });

  it("与 isSilentGroupReply 一致：收尾后 silent ⟺ isSilent", () => {
    for (const t of ["NO_REPLY\n解释", "收到", "NO_REPLY：x", "`NO_REPLY`\n"]) {
      // 收尾后文本不会再变：把「行写完」当成已结束（补一个换行）再判
      const verdict = judgeGroupReply(`${t}\n`);
      expect(verdict === "silent").toBe(isSilentGroupReply(t));
    }
  });
});
