import { useEffect, useRef, useState } from "react";

interface VideoPreviewProps {
  blobUrl: string;
}

// If the element still has no metadata after this long, the browser is either
// waiting on a very slow range read or has quietly given up on the codec
// (HEVC/x265 in MKV is the usual case — most browsers can't decode it and
// some never fire `error`, leaving the spinner up indefinitely).
const SLOW_START_MS = 15000;

export function VideoPreview({ blobUrl }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failure, setFailure] = useState<"format" | "network" | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState === 0) setSlow(true);
    }, SLOW_START_MS);
    return () => clearTimeout(timer);
  }, [blobUrl]);

  return (
    <>
      <video
        ref={videoRef}
        src={blobUrl}
        className="preview-media-video"
        controls
        playsInline
        onLoadedMetadata={() => setSlow(false)}
        onError={(e) =>
          // MEDIA_ERR_SRC_NOT_SUPPORTED (4) is a format/codec problem; anything
          // else (network, decode of a bad range, a deleted file) is not, and
          // telling the user to blame the codec would be wrong.
          setFailure(e.currentTarget.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "format" : "network")
        }
      >
        Your browser does not support this video format.
      </video>
      {(failure || slow) && (
        <div className="preview-modal-state error" role="status">
          {failure === "format"
            ? "This browser can't play this video — its format or codec (for example HEVC/x265 in MKV) isn't supported. Download the file to watch it in a media player."
            : failure === "network"
              ? "Couldn't load this video. The file may be unavailable or the connection dropped — try again, or download it."
              : "Still loading. If this never starts, the video's format or codec may not be supported by this browser — download the file to watch it in a media player."}
        </div>
      )}
    </>
  );
}
