import { afterEach, describe, expect, it, vi } from "vitest";
import { BlossomClient, toStandardBase64Auth } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BlossomClient extraction", () => {
  it("converts URL-safe Blossom auth to padded Base64", () => {
    expect(toStandardBase64Auth("Nostr ab-_c")).toBe("Nostr ab+/c===");
    expect(toStandardBase64Auth("Bearer unchanged")).toBe("Bearer unchanged");
  });

  it("negotiates the legacy auth encoding once and reuses it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    class FakeXMLHttpRequest {
      static readonly instances: FakeXMLHttpRequest[] = [];

      readonly headers = new Map<string, string>();
      readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
      status = 200;
      responseText = JSON.stringify({ sha256: "stored" });
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;

      constructor() {
        FakeXMLHttpRequest.instances.push(this);
      }

      open(): void {}

      setRequestHeader(name: string, value: string): void {
        this.headers.set(name, value);
      }

      getResponseHeader(): string | null {
        return null;
      }

      send(): void {
        this.onload?.();
      }

      abort(): void {
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const auth = "Nostr ab-_c";
    const standardAuth = "Nostr ab+/c===";
    const client = new BlossomClient("https://blossom.example.com");

    await expect(client.upload(Uint8Array.of(1), auth)).resolves.toBe("stored");
    await expect(client.upload(Uint8Array.of(2), auth)).resolves.toBe("stored");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: auth,
    });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: standardAuth,
    });
    expect(FakeXMLHttpRequest.instances).toHaveLength(2);
    expect(FakeXMLHttpRequest.instances.every(
      (xhr) => xhr.headers.get("Authorization") === standardAuth,
    )).toBe(true);
  });

  it("downloads the response bytes unchanged", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) },
        }),
      ),
    );

    const client = new BlossomClient("https://blossom.example.com");
    await expect(client.download("abc")).resolves.toEqual(bytes);
  });

  it("continues treating an already-missing delete as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const client = new BlossomClient("https://blossom.example.com");
    await expect(client.delete("abc", "Nostr token")).resolves.toBe(true);
  });

  it("retries forbidden deletes with standard Base64 auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new BlossomClient("https://blossom.example.com");
    await expect(client.delete("abc", "Nostr ab-_c")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: "Nostr ab-_c",
    });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({
      Authorization: "Nostr ab+/c===",
    });
  });

  it("rejects an upload that was aborted before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new BlossomClient("https://blossom.example.com");
    await expect(
      client.upload(Uint8Array.from([1]), "Nostr token", undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
