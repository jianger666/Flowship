/**
 * chat payload 指纹对图片内容的敏感度（V1-03，第二轮 review 2026-10-20）
 *
 * 现象：粘贴的截图文件名恒为 `image.png`。先有一条 uncertain（状态不明）的图片消息挂着，
 * 用户又贴了**另一张**同名截图发送——旧指纹只认文件名（或 mime + 长度），两条指纹相等，
 * 第二条被当成 uncertain 那条的「重试」复用 itemId → 服务端判「已受理」→ 第二条从未发送，
 * 草稿被清、无任何提示。task 通道（talk-send-attempt）早就带内容 hash，两个通道口径相反。
 */
import { describe, expect, it } from "vitest";

import {
  computeChatPayloadFingerprint,
  fingerprintFromChatSendArgs,
  imageKeysFromPayloads,
} from "@/lib/chat-payload-fingerprint";
import { fingerprintFromMessagePayload } from "@/lib/server/chat-queue";
import { talkSendFingerprint } from "@/lib/talk-send-attempt";

const png = (data: string, filename?: string) => ({
  data,
  mimeType: "image/png",
  ...(filename === undefined ? {} : { filename }),
});

describe("imageKeysFromPayloads：内容不同的图键不同", () => {
  it("同名（粘贴恒为 image.png）、同长度、内容不同 → 键不同（修前：两个键都是 `image.png`）", () => {
    const a = imageKeysFromPayloads([png("AAAA", "image.png")]);
    const b = imageKeysFromPayloads([png("BBBB", "image.png")]);
    expect(a).not.toEqual(b);
  });

  it("没有文件名、同 mime、同长度、内容不同 → 键不同（修前只比 mime + 长度）", () => {
    const a = imageKeysFromPayloads([png("AAAA")]);
    const b = imageKeysFromPayloads([png("BBBB")]);
    expect(a).not.toEqual(b);
  });

  it("同一张图重复计算 → 键稳定（uncertain 重试仍能认出是同一条）", () => {
    expect(imageKeysFromPayloads([png("AAAA", "image.png")])).toEqual(
      imageKeysFromPayloads([png("AAAA", "image.png")]),
    );
    expect(imageKeysFromPayloads([png("AAAA")])).toEqual(
      imageKeysFromPayloads([png("AAAA")]),
    );
  });

  it("多张图按序一一对应；没传 / 空 → 空数组", () => {
    expect(imageKeysFromPayloads(undefined)).toEqual([]);
    expect(imageKeysFromPayloads([])).toEqual([]);
    const keys = imageKeysFromPayloads([png("AAAA", "image.png"), png("BBBB", "image.png")]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("文件名纯空白按没有文件名处理（与修前一致），同样带内容区分", () => {
    const a = imageKeysFromPayloads([png("AAAA", "  ")]);
    const b = imageKeysFromPayloads([png("BBBB", "  ")]);
    expect(a).not.toEqual(b);
  });
});

describe("发送指纹：同名不同内容的截图不再被当成重试", () => {
  const send = (data: string) =>
    fingerprintFromChatSendArgs({
      text: "看这张图",
      images: [png(data, "image.png")],
    });

  it("同文字 + 同名同长不同内容的图 → 指纹不同（修前相等：第二条会复用第一条的 itemId、从未发送）", () => {
    expect(send("AAAA")).not.toBe(send("BBBB"));
  });

  it("同文字 + 同一张图 → 指纹相等（真重试照旧复用 id，不重复发）", () => {
    expect(send("AAAA")).toBe(send("AAAA"));
  });

  it("server 兜底（client 没带指纹时按请求体重算）与 client 算的一致", () => {
    const images = [png("AAAA", "image.png"), png("CCCC")];
    const client = fingerprintFromChatSendArgs({ text: "t", images });
    const server = fingerprintFromMessagePayload({ text: "t", images });
    expect(server).toBe(client);
  });

  it("computeChatPayloadFingerprint 的其它字段口径不变（文字 / 路径附件 / skill 各自仍参与）", () => {
    const base = {
      text: "t",
      imagePaths: imageKeysFromPayloads([png("AAAA", "image.png")]),
      attachmentPaths: ["/a"],
      skills: [{ name: "s", absPath: "/s" }],
    };
    const fp = computeChatPayloadFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(computeChatPayloadFingerprint({ ...base, text: "u" })).not.toBe(fp);
    expect(computeChatPayloadFingerprint({ ...base, attachmentPaths: ["/b"] })).not.toBe(fp);
    expect(computeChatPayloadFingerprint({ ...base, skills: [] })).not.toBe(fp);
  });
});

describe("两个通道口径一致：task 通道早就区分同名不同内容的图", () => {
  it("talkSendFingerprint 对同名不同内容的图给出不同指纹（chat 通道现在与之同向）", () => {
    const a = talkSendFingerprint({ text: "t", images: [png("AAAA", "image.png")] });
    const b = talkSendFingerprint({ text: "t", images: [png("BBBB", "image.png")] });
    expect(a).not.toBe(b);
  });
});
