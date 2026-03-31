import pdfjsLib from "./pdfWorker";

export async function generatePdfThumbnail(file: File): Promise<Uint8Array> {
    const arrayBuffer = await file.arrayBuffer();

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 1 });

    const maxSize = 300;
    const scale = Math.min(maxSize / viewport.width, maxSize / viewport.height, 1.5);

    const scaledViewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");

    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    await page.render({
        canvas,
        viewport: scaledViewport,
    }).promise;

    const blob = await new Promise<Blob>((res) =>
        canvas.toBlob((b) => res(b!), "image/webp", 0.7)
    );

    return new Uint8Array(await blob.arrayBuffer());
}