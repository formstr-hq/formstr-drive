import { generateImagePreview } from "./imagePreview";
import { generatePdfThumbnail } from "./pdfPreview";
import { generateVideoThumbnail } from "./videoPreview";

export async function previewFile(file : File) : Promise<Uint8Array | null> {
    if(file.type.startsWith("image/")){
        return generateImagePreview(file);
    }
    if(file.type.startsWith("video/")){
        return generateVideoThumbnail(file);
    }
    if(file.type === "application/pdf"){
        return generatePdfThumbnail(file);
    }
    return null;
}