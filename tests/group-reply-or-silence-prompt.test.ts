/**
 * 群里「要不要回」的提示词：默认要回，只有纯确认 / 复述才沉默；机器人**第一次**打招呼开窄口子（简短回、不提问、不 @ 它）。
 *
 * 背景：同一条沉默规则散在三处（答疑 agent 的守则 / 机器人克制规则 / 非属主脚注第 4 条），措辞各异，
 * 其中「客套」二字被点名进沉默清单，机器人第一次打招呼被一刀切。防互 @ 成环现在只剩提示词这一道，
 * 所以窄口子必须在构造上不可能成环——「不 @ 它」就是那道构造（出向对机器人提问人不自动补 @，入向没 @ 本机的消息直接忽略）。
 */
import { describe, expect, it } from "vitest";

import {
  GROUP_ACK_ONLY_TEXT,
  GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW,
  GROUP_REPLY_SILENCE,
  buildBotEtiquetteNote,
  buildBotFirstGreetingException,
  buildNonOwnerGuardFootnote,
} from "@/lib/group-non-owner-prompt";
import { formatReplyRulesSection } from "@/lib/server/feishu-bridge/group-answer-context";

const BOT_NAME = "安若流年";
const BOT_ID = "ou_otherbot";

const answerRules = (requesterIsBot: boolean): string =>
  formatReplyRulesSection({ requesterIsBot }).join("\n");
const botFootnote = buildNonOwnerGuardFootnote(BOT_NAME, { isBot: true, openId: BOT_ID });
const botNote = buildBotEtiquetteNote(BOT_NAME, BOT_ID);
const humanFootnote = buildNonOwnerGuardFootnote("李四");

describe("机器人第一次打招呼的窄口子", () => {
  it("机器人克制规则（约束段第 4 条 / 同权时的单独提示）：写明第一次、不提问、不邀请继续聊、不要 @ 它、再客套就沉默", () => {
    for (const text of [botFootnote, botNote]) {
      expect(text).toContain("第一次");
      expect(text).toContain("不提问");
      expect(text).toContain("不邀请继续聊");
      expect(text).toContain("不要 @ 它");
      expect(text).toContain("它再客套就整段只写 NO_REPLY");
      // 「第一次」的依据：自己之前没在群里对它说过话
      expect(text).toContain("你之前没在群里对它说过话");
    }
  });

  it("答疑 agent 守则（两种提问方都一样）：同样写明第一次 / 不要 @ 它，依据是「群里最近的聊天」里没有「（你自己）」说过话", () => {
    for (const requesterIsBot of [true, false]) {
      const text = answerRules(requesterIsBot);
      expect(text).toContain("第一次");
      expect(text).toContain("不要 @ 它");
      expect(text).toContain("不提问");
      expect(text).toContain("不邀请继续聊");
      expect(text).toContain("上面有「群里最近的聊天」这段、且里面没有你「（你自己）」对它说过话");
    }
  });

  it("「第一次」的依据拿不到时 fail-closed：看不到「群里最近的聊天」这段就当不是第一次（不能因为没看到自己说过话就每次都招呼）", () => {
    for (const requesterIsBot of [true, false]) {
      expect(answerRules(requesterIsBot)).toContain("看不到这段就当不是第一次");
    }
  });

  it("「@ 谁」那段不和例外打架：机器人没问实质问题回 NO_REPLY 的句子里指回「第一次打招呼的例外」", () => {
    expect(answerRules(true)).toContain("它没问实质问题就回 `NO_REPLY`（第一次打招呼的例外见上面「要不要回」）");
  });

  it("窄口子绝不让 agent 去 @ 对方（成不成环全靠这条）：例外句里「不要 @ 它」，且没有任何「要 @」的指令混进例外里", () => {
    const exception = buildBotFirstGreetingException("依据");
    expect(exception).toContain("不要 @ 它");
    expect(exception).not.toMatch(/必须.{0,6}@|请 @|(?<!不)要 @ 它/);
  });
});

describe("答疑守则「要不要回」：提问方是机器人时不再先说「默认要回」", () => {
  it("提问方是真人：默认要回；提问方是机器人：没问实质问题就 NO_REPLY、问了实质问题才回（与「@ 谁」和机器人克制规则同口径）", () => {
    const human = answerRules(false);
    const bot = answerRules(true);
    expect(human).toContain("默认要回");
    expect(bot).not.toContain("默认要回");
    expect(bot).toContain("对方是机器人：它没问你实质问题");
    expect(bot).toContain("它问了实质问题才回");
    // 整段守则里不存在「默认要回」与「机器人没问实质问题就沉默」并存的自相矛盾
    expect(bot).toContain("整段回复只写 `NO_REPLY`");
  });
});

describe("沉默只限于纯确认 / 复述：去掉模糊的「客套」", () => {
  it("沉默清单里不再点名「客套」：真人变体 / 设置页预览整段没有；机器人变体与答疑守则只在「它再客套就沉默」（首次招呼之后）里出现", () => {
    for (const text of [humanFootnote, GROUP_NON_OWNER_GUARD_PROMPT_PREVIEW]) {
      expect(text).not.toContain("客套");
    }
    for (const text of [botFootnote, botNote, answerRules(true), answerRules(false)]) {
      // 把首次招呼例外里那一句拿掉，剩下的（沉默清单、克制要求）不许再有「客套」
      expect(text.replaceAll("它再客套就整段只写 NO_REPLY", "")).not.toContain("客套");
    }
  });

  it("答疑守则：默认要回，只有没问任何问题 + 纯确认 / 复述 / 系统提示 / 转述才整段 NO_REPLY；不加「有问题随时问我」", () => {
    const text = answerRules(false);
    expect(text).toContain("默认要回");
    expect(text).toContain("没问你任何问题");
    expect(text).toContain("转发的系统提示");
    expect(text).toContain("转述别人的话");
    expect(text).toContain("第一行、原样、不加别的字");
    expect(text).toContain("也别加「有问题随时问我」");
    expect(text).toContain("两个机器人互相客气会无限循环");
  });

  it("答疑守则：告诉 agent「@名字（你）」是被点名了、同条还 @ 别人是同时叫了几位、照样答自己那份", () => {
    const text = answerRules(false);
    expect(text).toContain("「@名字（你）」");
    expect(text).toContain("同时叫了几位");
    expect(text).toContain("照样答你自己的那份");
  });

  it("真人变体第 4 条：沉默只剩「收到 / 好的」这类确认 / 复述，没有机器人才有的首次招呼例外", () => {
    // 真人版沉默口径是共享句 GROUP_REPLY_SILENCE：没问任何问题 + 纯确认 / 复述，才整段 NO_REPLY
    expect(humanFootnote).toContain(`对方没问任何问题、${GROUP_ACK_ONLY_TEXT}时，整段只写 NO_REPLY`);
    expect(humanFootnote).toContain(GROUP_REPLY_SILENCE);
    // GROUP_ACK_ONLY_TEXT 自己以「只是」开头：拼进模板时不能再加一个（曾拼出「只是只是」）
    expect(humanFootnote).not.toContain("只是只是");
    expect(humanFootnote).not.toContain("第一次");
    // 真人变体字面上不出现机器人变体的口子 / 禁令（既有测试也钉了 not 「别回「收到」」）
    expect(humanFootnote).not.toContain("别回「收到」");
    expect(humanFootnote).not.toContain("不要 @ 它");
  });
});

describe("三处共用同一份文字（不再各写各的）", () => {
  it("沉默口径的共用句：真人脚注 / 机器人规则 / 答疑守则都含 GROUP_ACK_ONLY_TEXT", () => {
    for (const text of [humanFootnote, botFootnote, botNote, answerRules(true), answerRules(false)]) {
      expect(text).toContain(GROUP_ACK_ONLY_TEXT);
    }
  });

  it("首次招呼例外：机器人规则与答疑守则里是共用函数的输出（只有「依据」各写各的）", () => {
    expect(botFootnote).toContain(buildBotFirstGreetingException("你之前没在群里对它说过话"));
    expect(botNote).toContain(buildBotFirstGreetingException("你之前没在群里对它说过话"));
    const basis =
      "上面有「群里最近的聊天」这段、且里面没有你「（你自己）」对它说过话；看不到这段就当不是第一次";
    expect(answerRules(true)).toContain(buildBotFirstGreetingException(basis));
    expect(answerRules(false)).toContain(buildBotFirstGreetingException(basis));
  });

  it("保留既有测试钉死的字面：必须在正文里 @ 它 / 别回「收到」/ 互相客气那句整段只出现一次", () => {
    for (const text of [botFootnote, botNote]) {
      expect(text).toContain("必须在正文里 @ 它");
      expect(text).toContain("别回「收到」");
      expect(text).toContain(`<at user_id="${BOT_ID}">${BOT_NAME}</at>`);
      expect(text.split("两个机器人互相客气会无限循环下去").length - 1).toBe(1);
    }
  });
});
