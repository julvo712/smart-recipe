import { describe, expect, it, vi } from "vitest";
import { MonsieurCuisineSmartClient } from "../src/mc/client.js";
import type { AuthProvider } from "../src/mc/auth.js";

const authProvider: AuthProvider = {
  getSession: async () => ({ cookie: "MC_COOKIE=test", source: "config" } as never)
};

function fetchReturning(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }) as unknown as Response);
}

const VENDOR_MEDIA_WRAPPER_BODY = {
  // Real vendor shape observed 2026-10-06 after the API changed:
  // media list at proxy top level instead of nested under data.media.
  media: [
    {
      video: null,
      id: 10668203,
      uploadStatus: "3",
      url: "https://mc-web-user-content-cdn.tecpal.com/media-service-upload/images/x-details.jpeg",
      mediaType: "image",
      createdAt: "2026-10-06T09:04:43.165Z",
      updatedAt: "2026-10-06T09:04:43.000Z"
    }
  ]
};

describe("MonsieurCuisineSmartClient.getMedia shape tolerance", () => {
  it("accepts the legacy shape (data.media)", async () => {
    const client = new MonsieurCuisineSmartClient({
      authProvider,
      fetch: fetchReturning({ data: { media: VENDOR_MEDIA_WRAPPER_BODY.media } } as never)
    });
    const media = await client.getMedia([10668203]);
    expect(Array.isArray(media)).toBe(true);
  });

  it("accepts the 2026-10 wrapped shape (top-level media)", async () => {
    const client = new MonsieurCuisineSmartClient({
      authProvider,
      fetch: fetchReturning(VENDOR_MEDIA_WRAPPER_BODY as never)
    });
    const media = await client.getMedia([10668203]);
    expect(media).toEqual(VENDOR_MEDIA_WRAPPER_BODY.media);
  });
});