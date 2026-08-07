import { describe, expect, it } from "vitest";

import {
  buildSteerPreviewBody,
  isSteerPreviewComplete,
  resolveSteerMediaKind,
} from "./received-time.js";

describe("isSteerPreviewComplete", () => {
  it("treats a long text-only message as complete", () => {
    expect(isSteerPreviewComplete({ rawText: "这是一条足够长的文字消息" })).toBe(true);
  });

  it("treats a very short text-only message as incomplete", () => {
    expect(isSteerPreviewComplete({ rawText: "好" })).toBe(false);
    expect(isSteerPreviewComplete({ rawText: "" })).toBe(false);
    expect(isSteerPreviewComplete({})).toBe(false);
  });

  it("does not treat a long caption as complete when media was not downloaded", () => {
    // Regression: caption length must never mask a missing attachment.
    expect(
      isSteerPreviewComplete({
        rawText: "这是一段很长的说明文字，帮我看看这个文件",
        mediaKind: "file",
      }),
    ).toBe(false);
    expect(
      isSteerPreviewComplete({
        rawText: "这是一段很长的图片说明文字",
        mediaKind: "image",
        steerMediaPath: "   ",
      }),
    ).toBe(false);
  });

  it("treats media + caption as complete once the media is downloaded", () => {
    expect(
      isSteerPreviewComplete({
        rawText: "这是一段很长的说明文字",
        mediaKind: "file",
        steerMediaPath: "/data/media/a.txt",
      }),
    ).toBe(true);
    expect(
      isSteerPreviewComplete({ mediaKind: "image", steerMediaPath: "/data/media/a.jpg" }),
    ).toBe(true);
  });

  it("treats downloaded but untranscribed audio as incomplete", () => {
    expect(
      isSteerPreviewComplete({ mediaKind: "audio", steerMediaPath: "/data/media/a.ogg" }),
    ).toBe(false);
    expect(
      isSteerPreviewComplete({
        mediaKind: "audio",
        steerMediaPath: "/data/media/a.ogg",
        transcript: "嗯",
      }),
    ).toBe(false);
    // A long caption alongside audio must not substitute for the transcript.
    expect(
      isSteerPreviewComplete({
        rawText: "这是一段很长的说明文字",
        mediaKind: "audio",
        steerMediaPath: "/data/media/a.ogg",
      }),
    ).toBe(false);
  });

  it("treats downloaded and transcribed audio as complete", () => {
    expect(
      isSteerPreviewComplete({
        mediaKind: "audio",
        steerMediaPath: "/data/media/a.ogg",
        transcript: "帮我看一下这个文件",
      }),
    ).toBe(true);
  });

  it("treats audio without a local file as incomplete", () => {
    expect(isSteerPreviewComplete({ mediaKind: "audio", transcript: "帮我看一下" })).toBe(false);
  });
});

describe("buildSteerPreviewBody with caption", () => {
  it("keeps the media marker when a caption is present", () => {
    const body = buildSteerPreviewBody({
      text: "帮我看看这个文件",
      mediaKind: "file",
      filePath: "/data/media/a.txt",
    });
    expect(body).toContain("帮我看看这个文件");
    expect(body).toContain("<media:file>");
    expect(body).toContain("/data/media/a.txt");
  });

  it("warns about the missing download when a caption is present but media is not downloaded", () => {
    const body = buildSteerPreviewBody({ text: "帮我看看这个文件", mediaKind: "file" });
    expect(body).toContain("帮我看看这个文件");
    expect(body).toContain("未能预下载");
  });

  it("returns plain text for text-only messages", () => {
    expect(buildSteerPreviewBody({ text: "纯文字消息" })).toBe("纯文字消息");
  });
});

describe("resolveSteerMediaKind", () => {
  it("classifies a document even when a caption is present", () => {
    // Regression: captioned documents used to resolve to `undefined`, which
    // skipped the pre-download and let the caption mark the preview complete.
    expect(resolveSteerMediaKind({ document: { file_id: "a" } })).toBe("file");
  });

  it("classifies photo/voice/audio/video", () => {
    expect(resolveSteerMediaKind({ photo: [{ file_id: "a" }] })).toBe("image");
    expect(resolveSteerMediaKind({ voice: { file_id: "a" } })).toBe("audio");
    expect(resolveSteerMediaKind({ audio: { file_id: "a" } })).toBe("audio");
    expect(resolveSteerMediaKind({ video: { file_id: "a" } })).toBe("video");
  });

  it("returns undefined for text-only messages", () => {
    expect(resolveSteerMediaKind({})).toBe(undefined);
    expect(resolveSteerMediaKind(undefined)).toBe(undefined);
    expect(resolveSteerMediaKind({ photo: [] })).toBe(undefined);
  });
});

describe("captioned document steer preview", () => {
  it("is incomplete when the pre-download failed, so the formal message must requeue", () => {
    const mediaKind = resolveSteerMediaKind({ document: { file_id: "a" } });
    expect(
      isSteerPreviewComplete({ rawText: "帮我看看这个 jsonl 文件", mediaKind }),
    ).toBe(false);
  });

  it("is complete and exposes the local path when the pre-download succeeded", () => {
    const mediaKind = resolveSteerMediaKind({ document: { file_id: "a" } });
    expect(
      isSteerPreviewComplete({
        rawText: "帮我看看这个 jsonl 文件",
        mediaKind,
        steerMediaPath: "/data/media/inbound/a.jsonl",
      }),
    ).toBe(true);
    const body = buildSteerPreviewBody({
      text: "帮我看看这个 jsonl 文件",
      mediaKind,
      filePath: "/data/media/inbound/a.jsonl",
    });
    expect(body).toContain("/data/media/inbound/a.jsonl");
  });
});
