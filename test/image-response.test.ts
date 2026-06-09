import { describe, expect, it } from "vitest";
import { extractImageReferences, parseImageApiResponse, targetRequestBodyForTask } from "../src/index";

describe("extractImageReferences", () => {
  it("extracts OpenAI-compatible image URLs", () => {
    expect(
      extractImageReferences({
        data: [
          {
            url: "https://example.com/image.png"
          }
        ]
      })
    ).toEqual(["https://example.com/image.png"]);
  });

  it("extracts base64 image payloads", () => {
    expect(
      extractImageReferences({
        images: [
          {
            b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
          }
        ]
      })
    ).toEqual(["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="]);
  });

  it("does not treat ordinary text output as base64 images", () => {
    expect(
      extractImageReferences({
        output: "plain text response"
      })
    ).toEqual([]);
  });

  it("deduplicates common nested image fields", () => {
    expect(
      extractImageReferences({
        output: [
          {
            image_url: "https://example.com/image.webp"
          }
        ],
        result: {
          images: ["https://example.com/image.webp"]
        }
      })
    ).toEqual(["https://example.com/image.webp"]);
  });
});

describe("parseImageApiResponse", () => {
  it("accepts direct image responses", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "Content-Type": "image/png"
      }
    });

    await expect(parseImageApiResponse(response)).resolves.toEqual([
      {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png"
      }
    ]);
  });

  it("accepts JSON data URLs", async () => {
    const response = Response.json({
      data: [
        {
          image: "data:image/png;base64,AQID"
        }
      ]
    });

    const images = await parseImageApiResponse(response);
    expect(images[0].contentType).toBe("image/png");
    expect([...images[0].bytes]).toEqual([1, 2, 3]);
  });

  it("accepts OpenAI Images b64_json data responses", async () => {
    const response = Response.json({
      data: [
        {
          b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
        }
      ]
    });

    const images = await parseImageApiResponse(response);
    expect(images[0].contentType).toBe("image/png");
    expect(images[0].bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("targetRequestBodyForTask", () => {
  it("passes through the stored payload when available", () => {
    expect(
      targetRequestBodyForTask({
        target_payload: JSON.stringify({
          model: "gpt-image-1",
          prompt: "A clean product render",
          size: "1024x1024",
          quality: "high"
        }),
        model_id: "ignored-model",
        prompt: "ignored prompt"
      })
    ).toBe('{"model":"gpt-image-1","prompt":"A clean product render","size":"1024x1024","quality":"high"}');
  });

  it("keeps the previous model and prompt body for old tasks", () => {
    expect(
      targetRequestBodyForTask({
        target_payload: null,
        model_id: "image-model",
        prompt: "A clean product render"
      })
    ).toBe('{"model":"image-model","prompt":"A clean product render"}');
  });
});
