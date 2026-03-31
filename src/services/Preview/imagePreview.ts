export async function generateImagePreview(file: File): Promise<Uint8Array> {
    const img = new Image();
    img.src = URL.createObjectURL(file);

    await new Promise<void>((res) => {
        img.onload = () => res();
    });

    const canvas = document.createElement("canvas");

    const maxSize = 300;
    const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);

    canvas.width = img.width * scale;
    canvas.height = img.height * scale;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob: Blob = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b!), "image/webp", 0.7)
    );

    const arrayBuffer = await blob.arrayBuffer();

    return new Uint8Array(arrayBuffer);
}