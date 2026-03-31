export async function generateVideoThumbnail(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(file);

        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";

        video.onloadedmetadata = () => {
            // Some browsers fail exactly at 0 → use tiny offset
            video.currentTime = 0.01;
        };

        video.onseeked = async () => {
            try {
                const canvas = document.createElement("canvas");

                const maxSize = 300;
                const scale = Math.min(
                    maxSize / video.videoWidth,
                    maxSize / video.videoHeight,
                    1
                );

                canvas.width = video.videoWidth * scale;
                canvas.height = video.videoHeight * scale;

                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                const blob = await new Promise<Blob>((res) =>
                    canvas.toBlob((b) => res(b!), "image/webp", 0.7)
                );

                const buffer = new Uint8Array(await blob.arrayBuffer());

                URL.revokeObjectURL(url);
                resolve(buffer);
            } catch (err) {
                reject(err);
            }
        };

        video.onerror = reject;
    });
}