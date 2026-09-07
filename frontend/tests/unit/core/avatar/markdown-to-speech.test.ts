import { describe, expect, it } from "@rstest/core";

import {
  estimateSpeechSeconds,
  splitIntoChunks,
  stripMarkdown,
  toSpeechChunks,
} from "@/core/avatar/markdown-to-speech";

describe("stripMarkdown", () => {
  it("keeps ordinary prose", () => {
    expect(stripMarkdown("你好，世界。")).toBe("你好，世界。");
  });

  it("removes headings, bold and code", () => {
    const input = [
      "# 标题",
      "",
      "这是 **重点** 内容。",
      "",
      "```python",
      "print('secret')",
      "```",
      "",
      "查看 [链接](http://example.com) 了解。",
    ].join("\n");

    const result = stripMarkdown(input);
    expect(result).not.toContain("#");
    expect(result).not.toContain("print");
    expect(result).not.toContain("**");
    expect(result).toContain("链接");
    expect(result).toContain("重点");
  });

  it("drops tables and bare urls", () => {
    const input = [
      "| 列1 | 列2 |",
      "| --- | --- |",
      "| a | b |",
      "详见 https://example.com 文档。",
    ].join("\n");

    const result = stripMarkdown(input);
    expect(result).not.toContain("|");
    expect(result).toContain("链接");
    expect(result).toContain("详见");
  });
});

describe("splitIntoChunks", () => {
  it("splits on CJK sentence boundaries", () => {
    const chunks = splitIntoChunks("你好。世界！这是测试。");
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe("你好。世界！这是测试。");
  });

  it("does not split decimals", () => {
    const chunks = splitIntoChunks("版本是 3.14 稳定版。请升级。");
    expect(chunks.some((chunk) => chunk.includes("3.14"))).toBe(true);
  });

  it("merges very short tail fragments", () => {
    const chunks = splitIntoChunks("好的。我们去公园吧。");
    expect(chunks.length).toBe(2);
  });

  it("bursts over-long sentences at commas", () => {
    const longSentence = `第一点，${"很长的铺垫".repeat(20)}，第二点结束。`;
    const chunks = splitIntoChunks(longSentence, 40);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  });
});

describe("toSpeechChunks", () => {
  it("returns nothing for non-speech content", () => {
    expect(toSpeechChunks("```js\nonly code\n```")).toEqual([]);
  });

  it("truncates very long reports", () => {
    const huge = "数据 ".repeat(10000);
    const chunks = toSpeechChunks(huge);
    const total = chunks.join("").length;
    expect(total).toBeLessThanOrEqual(9000);
  });
});

describe("estimateSpeechSeconds", () => {
  it("produces a sane duration for Chinese text", () => {
    const seconds =
      estimateSpeechSeconds("这是一段用于测试中文朗读时长的文本。");
    expect(seconds).toBeGreaterThan(0);
  });
});
