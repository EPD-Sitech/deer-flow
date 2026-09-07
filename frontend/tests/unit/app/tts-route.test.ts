import { writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { NextRequest } from "next/server";

import { POST } from "@/app/tts/route";

// Replace the real Edge TTS client with a stub that simply writes a small file,
// so the success path can be exercised without a network round-trip to
// Microsoft's TTS service.
rs.mock("node-edge-tts", () => {
  return {
    EdgeTTS: class {
      async ttsPromise(_text: string, audioPath: string) {
        await writeFile(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
      }
    },
  };
});

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest("http://localhost/tts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /tts", () => {
  afterEach(() => {
    delete process.env.TTS_ENABLED;
  });

  it("returns 404 when TTS is disabled", async () => {
    process.env.TTS_ENABLED = "false";
    const response = await post({ text: "你好" });
    expect(response.status).toBe(404);
  });

  it("rejects empty text with 400", async () => {
    const response = await post({ text: "   " });
    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(
      new NextRequest("http://localhost/tts", {
        method: "POST",
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("synthesizes through the stub and returns mp3", async () => {
    const response = await post({
      text: "你好，世界。",
      voice: "zh-CN-XiaoxiaoNeural",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toContain("private");

    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
  });

  it("falls back to the default voice for an unallowlisted voice", async () => {
    const response = await post({
      text: "测试",
      voice: "DROP TABLE voices",
    });
    // A rejected voice must not surface as a 400 from the validation layer;
    // it is replaced with the default before synthesis.
    expect(response.status).toBe(200);
  });
});
