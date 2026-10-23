// what grove chat sends inline: the image types the api takes, as the vs code extension decides
// it (webview `vm1`). claude code shrinks one before the api sees it. anything else (a pdf, code, a
// video, a zip) goes by its path on disk, and claude reads it from there when it needs it.

const IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** an image claude sees in the message itself. an svg or a heic goes by its path */
export const isImage = (type: string): boolean => IMAGES.includes(type.toLowerCase());

/** what a chip calls a file that goes by its path */
export function fileWord(type: string): string {
  const t = type.toLowerCase();
  if (t === "application/pdf") return "PDF";
  if (t.startsWith("image/")) return "Image";
  return t.startsWith("video/") ? "Video" : t.startsWith("audio/") ? "Audio" : "File";
}

/** 220 KB, 3.4 MB: a chip's size */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
