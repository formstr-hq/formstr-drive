import heic2any from "heic2any"; // For converting HEIC to JPEG before passing into canva

function isHeic(file: File): boolean {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    file.type === "" && (
      file.name.toLowerCase().endsWith(".heic") ||
      file.name.toLowerCase().endsWith(".heif")
    )
  );
}

async function resolveImageFile(file: File): Promise<File> {
  if (!isHeic(file)) return file;

  const converted = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.8,
  });

  // heic2any returns Blob | Blob[]
  const blob = Array.isArray(converted) ? converted[0] : converted;
  return new File([blob], file.name.replace(/\.heic$/i, ".jpg"), {
    type: "image/jpeg",
  });
}

export async function generateImagePreview(file: File): Promise<Uint8Array> {
  const source = await resolveImageFile(file);  // converts if HEIC

  const img = new Image();
  img.src = URL.createObjectURL(source);
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error(`Failed to load image: ${file.name}`));  // also add error handler
  });
  const canvas = document.createElement("canvas");
  const maxSize = 300;
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);  // clean up object URL
  const blob: Blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b!), "image/webp", 0.7)
  );
  return new Uint8Array(await blob.arrayBuffer());
}