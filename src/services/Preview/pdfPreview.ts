export async function generatePdfThumbnail(file: File): Promise<Uint8Array> {
    const pdfjsLibModule = await import("./pdfWorker");
    const pdfjsLib = pdfjsLibModule.default;
    const arrayBuffer = await file.arrayBuffer();

    let pdf: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
    try {
        pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch {
        throw new Error(`Failed to parse PDF: ${file.name}`);
    }

    if (pdf.numPages < 1) {
        throw new Error(`PDF has no renderable pages: ${file.name}`);
    }

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