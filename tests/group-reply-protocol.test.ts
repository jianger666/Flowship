import { describe, expect, it } from "vitest";
import {
  GROUP_NO_REPLY_TOKEN,
  type GroupMember,
} from "@/lib/server/feishu-bridge/group-contract";
import {
  buildGroupReplyRules,
  parseGroupReply,
  type ParseGroupReplyCtx,
} from "@/lib/server/feishu-bridge/group-reply-protocol";

const tag = (id: string, name: string) => `<at user_id="${id}">${name}</at>`;

const members: GroupMember[] = [
  { openId: "ou_owner", name: "曾进有", kind: "user" },
  { openId: "ou_zhang", name: "张三", kind: "user" },
  { openId: "ou_an", name: "李安", kind: "user" },
  { openId: "ou_anan", name: "李安安", kind: "user" },
  { openId: "ou_proj", name: "项目助手（曾进有）", kind: "bot" },
  { openId: "ou_anruo", name: "安若流年", kind: "bot" },
  { openId: "ou_self", name: "Flowship机器人", kind: "bot" },
  { openId: "ou_d1", name: "王五", kind: "user" },
  { openId: "ou_d2", name: "王五", kind: "user" },
  { openId: "ou_bob", name: "Bob", kind: "user" },
  { openId: "ou_sp", name: "A B", kind: "user" },
];

const human = { openId: "ou_zhang", name: "张三", isBot: false };
const bot = { openId: "ou_anruo", name: "安若流年", isBot: true };

const mk = (over: Partial<ParseGroupReplyCtx> = {}): ParseGroupReplyCtx => ({
  members,
  owner: { openId: "ou_owner", name: "曾进有" },
  requester: human,
  selfOpenId: "ou_self",
  ...over,
});

describe("parseGroupReply · NO_REPLY", () => {
  const silentCases: Record<string, string> = {
    裸: "NO_REPLY",
    首尾空白: "  \n NO_REPLY \n ",
    句号: "NO_REPLY。",
    英文句号: "NO_REPLY.",
    感叹号: "NO_REPLY!",
    全角感叹号: "NO_REPLY！",
    反引号: "`NO_REPLY`",
    双引号: '"NO_REPLY"',
    弯引号: "“NO_REPLY”",
    引号加标点: "「NO_REPLY。」",
    围栏: "```\nNO_REPLY\n```",
    带语言围栏: "```text\nNO_REPLY\n```",
    反引号加句号: "`NO_REPLY`。",
    小写: "no_reply",
    混合大小写: "No_Reply",
    空串: "",
    全空白: " \n\t  ",
  };
  for (const [name, raw] of Object.entries(silentCases)) {
    it(`silent：${name}`, () => {
      for (const requester of [human, bot]) {
        const r = parseGroupReply(raw, mk({ requester }));
        expect(r).toEqual({
          kind: "silent",
          text: "",
          mentions: [],
          unresolvedAts: [],
        });
      }
    });
  }

  it("单独成行夹在正文里：只剔掉那一行，其余照发", () => {
    const r = parseGroupReply("第一段\nNO_REPLY\n第二段", mk());
    expect(r.kind).toBe("send");
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} 第一段\n第二段`);
  });

  it("夹在行里（同一行还有别的字）不算哨兵，原样保留", () => {
    const r = parseGroupReply("好的 NO_REPLY 吧", mk());
    expect(r.kind).toBe("send");
    expect(r.text).toContain("好的 NO_REPLY 吧");
  });

  it("多行哨兵剔光后为空 → silent", () => {
    expect(parseGroupReply("NO_REPLY\n\n`NO_REPLY`", mk()).kind).toBe("silent");
  });

  it("非字符串输入不抛错", () => {
    expect(parseGroupReply(undefined as unknown as string, mk()).kind).toBe(
      "silent",
    );
    expect(parseGroupReply(null as unknown as string, mk()).kind).toBe(
      "silent",
    );
  });
});

describe("parseGroupReply · @ 解析", () => {
  it("名字 → 真 @", () => {
    const r = parseGroupReply("@安若流年 接口是 /a/b", mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe(`${tag("ou_anruo", "安若流年")} 接口是 /a/b`);
    expect(r.mentions).toEqual([{ openId: "ou_anruo", name: "安若流年" }]);
    expect(r.unresolvedAts).toEqual([]);
  });

  it("最长匹配：@李安安 不被 李安 截断", () => {
    const r = parseGroupReply("@李安安 你好，@李安 也看下", mk());
    expect(r.text).toBe(
      `${tag("ou_anan", "李安安")} 你好，${tag("ou_an", "李安")} 也看下`,
    );
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_anan", "ou_an"]);
  });

  it("全角 ＠ 也认", () => {
    const r = parseGroupReply("＠张三 看下", mk({ requester: bot }));
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} 看下`);
  });

  it("名字含全角括号 / 空格", () => {
    const r = parseGroupReply(
      "@项目助手（曾进有） 请同步；@A B 也看下",
      mk({ requester: bot }),
    );
    expect(r.text).toBe(
      `${tag("ou_proj", "项目助手（曾进有）")} 请同步；${tag("ou_sp", "A B")} 也看下`,
    );
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_proj", "ou_sp"]);
  });

  it("名字里的正则元字符不炸（直接 startsWith）", () => {
    const weird: GroupMember = {
      openId: "ou_w",
      name: "a.b(c)[d]+",
      kind: "user",
    };
    const r = parseGroupReply(
      "@a.b(c)[d]+ 在吗",
      mk({ members: [weird], requester: bot }),
    );
    expect(r.text).toBe(`${tag("ou_w", "a.b(c)[d]+")} 在吗`);
  });

  it("重名歧义：不 @、进 unresolvedAts、文本原样", () => {
    const r = parseGroupReply("@王五 看下", mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe("@王五 看下");
    expect(r.mentions).toEqual([]);
    expect(r.unresolvedAts).toEqual(["王五"]);
  });

  it("同一人在 members 里重复登记不算歧义", () => {
    const dup = [...members, { openId: "ou_zhang", name: "张三", kind: "user" as const }];
    const r = parseGroupReply("@张三 好", mk({ members: dup, requester: bot }));
    expect(r.mentions).toEqual([{ openId: "ou_zhang", name: "张三" }]);
  });

  it("ASCII 名字有词边界：@Bobby 不被 Bob 吃掉", () => {
    const r = parseGroupReply("@Bobby 在吗 @Bob 你呢", mk({ requester: bot }));
    expect(r.text).toBe(`@Bobby 在吗 ${tag("ou_bob", "Bob")} 你呢`);
    expect(r.unresolvedAts).toEqual(["Bobby"]);
  });

  it("@宿主 / @属主 → 属主真 @", () => {
    const r = parseGroupReply("这个得问 @宿主，@属主 也在", mk({ requester: bot }));
    expect(r.text).toBe(
      `这个得问 ${tag("ou_owner", "曾进有")}，${tag("ou_owner", "曾进有")} 也在`,
    );
    expect(r.mentions).toEqual([{ openId: "ou_owner", name: "曾进有" }]);
  });

  it("没有 owner 时 @宿主 保持原样并进 unresolvedAts", () => {
    const r = parseGroupReply(
      "请 @宿主 看",
      mk({ owner: undefined, requester: bot }),
    );
    expect(r.text).toBe("请 @宿主 看");
    expect(r.unresolvedAts).toEqual(["宿主"]);
    expect(r.mentions).toEqual([]);
  });

  it("不许 @ 自己：只留文本", () => {
    const r = parseGroupReply(
      "@Flowship机器人 我来答：ok",
      mk({ requester: bot }),
    );
    expect(r.text).toBe("Flowship机器人 我来答：ok");
    expect(r.mentions).toEqual([]);
    // 没有真 @ + 提问人是机器人 → 不补
    expect(r.text).not.toContain("<at");
  });

  it("自己 @ 自己（真人提问）：剔掉后仍按规则补 @ 提问人", () => {
    const r = parseGroupReply("@Flowship机器人 在的", mk());
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} Flowship机器人 在的`);
  });

  it("手写 at 标签：id 可信 → 保留并计入 mentions", () => {
    const r = parseGroupReply(
      `看这里 ${tag("ou_an", "随便写的名字")}`,
      mk({ requester: bot }),
    );
    expect(r.text).toBe(`看这里 ${tag("ou_an", "李安")}`);
    expect(r.mentions).toEqual([{ openId: "ou_an", name: "李安" }]);
  });

  it("手写 at 标签：属主 id / 本机 id（self 剔掉）", () => {
    const r = parseGroupReply(
      `${tag("ou_owner", "宿主")} 好；${tag("ou_self", "我")}`,
      mk({ requester: bot }),
    );
    expect(r.text).toBe(`${tag("ou_owner", "曾进有")} 好；我`);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
  });

  it("手写 at 标签：未知 id（伪造 / 幻觉）→ 退化成纯文本 @名字", () => {
    const r = parseGroupReply(
      `${tag("ou_fake", "某人")} 请看`,
      mk({ requester: bot }),
    );
    expect(r.text).toBe("@某人 请看");
    expect(r.mentions).toEqual([]);
    expect(r.text).not.toContain("<at");
    expect(r.unresolvedAts).toEqual(["某人"]);
  });

  it("手写 at 标签 all 也退化", () => {
    const r = parseGroupReply(
      `<at user_id="all">所有人</at> 注意`,
      mk({ requester: bot }),
    );
    expect(r.text).toBe("@所有人 注意");
    expect(r.mentions).toEqual([]);
  });

  it("未知名字：原样保留，xxx 取到空白 / 标点，去重", () => {
    const r = parseGroupReply(
      "@路人甲，你好 @路人甲 再见 @路人乙：好",
      mk({ requester: bot }),
    );
    expect(r.text).toBe("@路人甲，你好 @路人甲 再见 @路人乙：好");
    expect(r.unresolvedAts).toEqual(["路人甲", "路人乙"]);
  });

  it("邮箱里的 @ 不记为未识别 @；孤立的 @ 也不记", () => {
    const r = parseGroupReply("发到 a@example.com 或者 @ 一下", mk({ requester: bot }));
    expect(r.unresolvedAts).toEqual([]);
    expect(r.text).toBe("发到 a@example.com 或者 @ 一下");
  });
});

describe("parseGroupReply · 自动补 @", () => {
  it("真人提问、正文没 @ → 开头补 @ 提问人", () => {
    const r = parseGroupReply("结论：可以", mk());
    expect(r.kind).toBe("send");
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} 结论：可以`);
    expect(r.mentions).toEqual([{ openId: "ou_zhang", name: "张三" }]);
  });

  it("机器人提问、正文没 @ → 不补，但仍然发出", () => {
    const r = parseGroupReply("结论：可以", mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe("结论：可以");
    expect(r.mentions).toEqual([]);
  });

  it("真人提问、正文已有 @ 别人 → 不再补提问人", () => {
    const r = parseGroupReply("这个问 @李安 吧", mk());
    expect(r.text).toBe(`这个问 ${tag("ou_an", "李安")} 吧`);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_an"]);
  });

  it("真人提问、正文 @ 了自己（提问人）→ 不重复补", () => {
    const r = parseGroupReply("@张三 可以", mk());
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} 可以`);
    expect(r.mentions).toHaveLength(1);
  });

  it("只有未识别的 @ 时仍算没有真 @ → 真人提问人照补", () => {
    const r = parseGroupReply("@路人 好", mk());
    expect(r.text).toBe(`${tag("ou_zhang", "张三")} @路人 好`);
    expect(r.unresolvedAts).toEqual(["路人"]);
  });
});

describe("parseGroupReply · 需属主确认", () => {
  const mark = (s: string) => `[[需属主确认：${s}]]`;

  it("剥标记、补属主 @；needsOwner 填说明", () => {
    const r = parseGroupReply(
      `这个要宿主确认，已转告\n${mark("接口是否改成分页")}`,
      mk({ requester: bot }),
    );
    expect(r.kind).toBe("send");
    expect(r.needsOwner).toBe("接口是否改成分页");
    expect(r.text).toBe(
      `这个要宿主确认，已转告\n${tag("ou_owner", "曾进有")} 需要你确认：接口是否改成分页`,
    );
    // 输出里不再含标记：把输出再喂一遍解析器，不会再识别出标记（第七轮 K4-11：原来用已删除的契约正则 GROUP_NEEDS_OWNER_RE 断言）
    expect(parseGroupReply(r.text, mk({ requester: bot })).needsOwner).toBeUndefined();
    expect(r.text).not.toContain("[[");
    expect(r.mentions).toEqual([{ openId: "ou_owner", name: "曾进有" }]);
  });

  // G1-05：prompt 对真人提问人承诺「正文里不用写 @，系统会自动 @ 他」；文档第 4 条的条件是
  // 「**正文**没有任何真 @」——系统自己补的属主确认行不算正文，否则等着答案的人反而收不到通知
  it("真人提问、正文没有 @：属主确认行补的 @ 不算正文，提问人照补（G1-05）", () => {
    const r = parseGroupReply(`先这样\n${mark("要不要上线")}`, mk());
    expect(r.text).toBe(
      `${tag("ou_zhang", "张三")} 先这样\n${tag("ou_owner", "曾进有")} 需要你确认：要不要上线`,
    );
    // mentions 顺序与 text 里的出现顺序一致
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_zhang", "ou_owner"]);
  });

  it("真人提问、正文自己已 @ 了别人：不补提问人（契约第 4 条原样）", () => {
    const r = parseGroupReply(`问下 @李安\n${mark("要不要上线")}`, mk());
    expect(r.text.startsWith(tag("ou_zhang", "张三"))).toBe(false);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_an", "ou_owner"]);
  });

  it("机器人提问 + 标记：仍不补提问人（有意防环）", () => {
    const r = parseGroupReply(`先这样\n${mark("要不要上线")}`, mk({ requester: bot }));
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
    expect(r.text).not.toContain("ou_anruo");
  });

  it("提问人本身就是属主：确认行已 @ 他，不再给他补第二个", () => {
    const r = parseGroupReply(
      `先这样\n${mark("要不要上线")}`,
      mk({ requester: { openId: "ou_owner", name: "曾进有", isBot: false } }),
    );
    expect(r.text.split('<at user_id="ou_owner"').length - 1).toBe(1);
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
  });

  it("正文已 @ 过属主：不重复 @，说明行用纯文本前缀", () => {
    const r = parseGroupReply(
      `@宿主 麻烦看下\n${mark("口径")}`,
      mk({ requester: bot }),
    );
    expect(r.text).toBe(`${tag("ou_owner", "曾进有")} 麻烦看下\n需要你确认：口径`);
    expect(r.text.split(`<at user_id="ou_owner"`).length - 1).toBe(1);
    expect(r.mentions).toEqual([{ openId: "ou_owner", name: "曾进有" }]);
  });

  it("无 owner：降级成纯文本「需要属主确认：…」", () => {
    const r = parseGroupReply(
      `暂时不确定\n${mark("范围")}`,
      mk({ owner: undefined, requester: bot }),
    );
    expect(r.text).toBe("暂时不确定\n需要属主确认：范围");
    expect(r.needsOwner).toBe("范围");
    expect(r.mentions).toEqual([]);
  });

  it("无 owner + 真人提问：仍补 @ 提问人", () => {
    const r = parseGroupReply(
      `暂时不确定\n${mark("范围")}`,
      mk({ owner: undefined }),
    );
    expect(r.text).toBe(
      `${tag("ou_zhang", "张三")} 暂时不确定\n需要属主确认：范围`,
    );
  });

  it("多个标记：取第一条说明，全部剥掉、只补一行", () => {
    const r = parseGroupReply(
      `${mark("第一条")}\n正文\n${mark("第二条")}`,
      mk({ requester: bot }),
    );
    expect(r.needsOwner).toBe("第一条");
    expect(r.text).toBe(
      `正文\n${tag("ou_owner", "曾进有")} 需要你确认：第一条`,
    );
    expect(r.text).not.toContain("第二条");
  });

  it("说明压空白、截断到 200 字", () => {
    const long = "字".repeat(300);
    // 说明里换行用单个 \n：闭合符在同一段（空行分隔）内找；说明里夹空行也能闭合，但有条件（闭合符在行尾、离起头 600 字内……，
    // 见 tests/group-reply-protocol-r7.test.ts 的 K4-05③），这条用例考的是截断，不借这个条件
    const r = parseGroupReply(
      `ok\n${mark(`  前面\n  有  空白 ${long}`)}`,
      mk({ requester: bot }),
    );
    expect(r.needsOwner?.startsWith("前面 有 空白 ")).toBe(true);
    expect(Array.from(r.needsOwner ?? "").length).toBeLessThanOrEqual(200);
    expect(r.needsOwner?.endsWith("…")).toBe(true);
  });

  it("说明里手写的 at 标签被压成纯文本，不能夹带真 @", () => {
    const r = parseGroupReply(
      `ok\n${mark(`请 ${tag("ou_an", "李安")} 一起`)}`,
      mk({ requester: bot }),
    );
    expect(r.needsOwner).toBe("请 @李安 一起");
    expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
  });

  it("全角冒号 / 半角冒号都认", () => {
    const r = parseGroupReply("ok\n[[需属主确认:口径]]", mk({ requester: bot }));
    expect(r.needsOwner).toBe("口径");
  });

  it("只有一个无说明的标记 → silent", () => {
    const r = parseGroupReply(mark("  "), mk());
    expect(r).toEqual({
      kind: "silent",
      text: "",
      mentions: [],
      unresolvedAts: [],
    });
  });

  it("无说明标记 + 正文：标记被剥掉，不补确认行", () => {
    const r = parseGroupReply(`正文\n${mark("")}`, mk({ requester: bot }));
    expect(r.text).toBe("正文");
    expect(r.needsOwner).toBeUndefined();
  });

  it("只有标记但有说明：发出 @ 属主的确认行", () => {
    const r = parseGroupReply(mark("上线时间"), mk({ requester: bot }));
    expect(r.kind).toBe("send");
    expect(r.text).toBe(`${tag("ou_owner", "曾进有")} 需要你确认：上线时间`);
  });
});

describe("parseGroupReply · 返回值", () => {
  it("mentions 按 openId 去重、保持首次出现顺序", () => {
    const r = parseGroupReply(
      `@李安 @张三 @李安 ${tag("ou_zhang", "x")} @宿主 @属主`,
      mk({ requester: bot }),
    );
    expect(r.mentions.map((m) => m.openId)).toEqual([
      "ou_an",
      "ou_zhang",
      "ou_owner",
    ]);
  });

  it("text 首尾 trim", () => {
    const r = parseGroupReply("\n\n  hello  \n\n", mk({ requester: bot }));
    expect(r.text).toBe("hello");
  });

  it("成员展示名为空 / 无 openId 不炸", () => {
    const r = parseGroupReply(
      "@ 你好 @张三",
      mk({
        members: [
          { openId: "", name: "无人", kind: "user" },
          { openId: "ou_x", name: "", kind: "user" },
          { openId: "ou_zhang", name: "张三", kind: "user" },
        ],
        requester: bot,
      }),
    );
    expect(r.kind).toBe("send");
    expect(r.mentions).toEqual([{ openId: "ou_zhang", name: "张三" }]);
  });

  it("没有 selfOpenId 也能工作", () => {
    const r = parseGroupReply("@张三 好", mk({ selfOpenId: undefined }));
    expect(r.mentions).toEqual([{ openId: "ou_zhang", name: "张三" }]);
  });

  it("owner 没有 openId 视为无 owner", () => {
    const r = parseGroupReply(
      "ok\n[[需属主确认：x]]",
      mk({ owner: { openId: "", name: "曾进有" }, requester: bot }),
    );
    expect(r.text).toBe("ok\n需要属主确认：x");
  });
});

describe("buildGroupReplyRules", () => {
  for (const requesterIsBot of [true, false]) {
    describe(`requesterIsBot=${requesterIsBot}`, () => {
      const lines = buildGroupReplyRules({ requesterIsBot });
      const all = lines.join("\n");

      it("非空且每行是字符串", () => {
        expect(lines.length).toBeGreaterThan(5);
        expect(lines.every((l) => typeof l === "string")).toBe(true);
      });

      it("含关键句", () => {
        expect(all).toContain(GROUP_NO_REPLY_TOKEN);
        expect(all).toContain("需属主确认");
        expect(all).toContain("@宿主");
        expect(all).toContain("Flowship");
      });

      // 第七轮 K4-11：原来用契约正则 `GROUP_NEEDS_OWNER_RE` 判示例行，现已删除、改走真实的解析入口。
      // 并且示例行**不能被包在反引号里**——解析器（K4-05②）把行内代码 / 围栏里的标记当示例、不触发，
      // 模型照抄带反引号的示例行就会让标记原样发群、属主没被 @。
      it("示例标记行原样喂给真实解析器能被识别（不是被包在代码里的示例）", () => {
        const markLine = lines.find((l) => l.includes("[[需属主确认"));
        expect(markLine).toBeTruthy();
        const r = parseGroupReply(markLine ?? "", mk({ requester: bot }));
        expect(r.needsOwner).toContain("一句话说明");
        expect(r.mentions.map((m) => m.openId)).toEqual(["ou_owner"]);
        expect(r.text).not.toContain("[[");
      });
    });
  }

  it("两种提问方措辞有区别：机器人必须写 @名字，真人不用", () => {
    const b = buildGroupReplyRules({ requesterIsBot: true }).join("\n");
    const h = buildGroupReplyRules({ requesterIsBot: false }).join("\n");
    expect(b).toContain("必须在正文里写");
    expect(h).toContain("系统会自动 @ 他");
    expect(b).not.toBe(h);
  });
});
