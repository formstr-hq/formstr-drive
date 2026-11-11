import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { imageBytesToThumbnail } from "../encode";

/** Cover art embedded in an audio file's tags (mp3 ID3, m4a, flac, ogg). Reads only the tag region. */
export async function audioThumbnail(file: File, signal: AbortSignal): Promise<Uint8Array> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const tags = await input.getMetadataTags();
    signal.throwIfAborted();
    const images = tags.images ?? [];
    const cover = images.find((image) => image.kind === "coverFront") ?? images[0];
    if (!cover) throw new Error("Audio file has no cover art");
    return await imageBytesToThumbnail(cover.data, cover.mimeType || "image/jpeg");
  } finally {
    input.dispose();
  }
}
