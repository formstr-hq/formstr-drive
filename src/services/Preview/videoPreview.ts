import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;

type CaptureStreamCanvas = HTMLCanvasElement & {
    captureStream?: (frameRate?: number) => MediaStream;
    mozCaptureStream?: (frameRate?: number) => MediaStream;
};



async function loadFFmpeg(): Promise<FFmpeg> {
    if (ffmpeg) return ffmpeg;

    const instance = new FFmpeg();
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

    await instance.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });

    ffmpeg = instance;
    return ffmpeg;
}

export async function extractFrameWithFFmpeg(file: File): Promise<Uint8Array | null> {
    try {
        const ff = await loadFFmpeg();

        await ff.writeFile("input", await fetchFile(file));
        await ff.exec([
            "-i", "input",
            "-ss", "0.01",       // seek to 10ms
            "-frames:v", "1",    // extract one frame
            "-vf", "scale=300:-1", // max width 300, keep aspect ratio
            "thumb.jpg"
        ]);

        const data = await ff.readFile("thumb.jpg");

        // cleanup
        await ff.deleteFile("input");
        await ff.deleteFile("thumb.jpg");

        return data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    } catch {
        return null;
    }
}
export async function generateVideoThumbnail(file: File): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(file);
        let settled = false;

        const cleanup = () => {
            URL.revokeObjectURL(url);
            if (video.parentNode) video.parentNode.removeChild(video);
        };

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn();
        };

        // Failsafe timeout
        setTimeout(() => {
            settle(() => reject(new Error("Video thumbnail generation timed out")));
        }, 15000);

        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";

        video.onloadeddata = async () => {
            try {
                const maxSize = 300;
                const scale = Math.min(maxSize / video.videoWidth, maxSize / video.videoHeight, 1);

                const canvas = document.createElement("canvas");
                canvas.width = video.videoWidth * scale;
                canvas.height = video.videoHeight * scale;
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("Failed to get canvas 2D context");

                const captureCanvas = canvas as CaptureStreamCanvas;
                const stream = captureCanvas.captureStream
                    ? captureCanvas.captureStream(15)
                    : captureCanvas.mozCaptureStream
                      ? captureCanvas.mozCaptureStream(15)
                      : null;
                const mimeType = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 
                                 typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : '';

                const fallbackToStatic = () => {
                    video.currentTime = 0.01;
                    video.onseeked = async () => {
                        try {
                            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                            const blob = await new Promise<Blob>((res, rej) =>
                                canvas.toBlob((b) => b ? res(b) : rej(new Error("Canvas export failed")), "image/webp", 0.7)
                            );
                            const buffer = new Uint8Array(await blob.arrayBuffer());
                            settle(() => resolve(buffer));
                        } catch (e) { settle(() => reject(e)); }
                    };
                };

                if (!stream || !mimeType) {
                    return fallbackToStatic();
                }

                const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 500000 });
                const chunks: Blob[] = [];
                recorder.ondataavailable = (e) => chunks.push(e.data);
                recorder.onstop = async () => {
                    const blob = new Blob(chunks, { type: mimeType });
                    if (blob.size < 100) return fallbackToStatic();
                    const buffer = new Uint8Array(await blob.arrayBuffer());
                    settle(() => resolve(buffer));
                };

                recorder.start();

                const fps = 15;
                const durationToCapture = Math.min(2, video.duration || 2);
                const frames = Math.floor(durationToCapture * fps);

                for (let i = 0; i <= frames; i++) {
                    if (settled) break;
                    video.currentTime = i / fps;
                    await new Promise(r => {
                        video.onseeked = r;
                        setTimeout(r, 300); // Failsafe if seek hangs
                    });
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    await new Promise(r => setTimeout(r, 1000 / fps)); // Wait for MediaRecorder to capture it
                }

                if (!settled) {
                    recorder.stop();
                }
            } catch (err) {
                settle(() => reject(err));
            }
        };

        video.onerror = () => settle(() => reject(new Error("Video loading failed")));
    });
}
