const RENDERABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/apng",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/x-ms-bmp",
]);

export function browserRenderableImage(mimeType?: string): boolean {
  return RENDERABLE_IMAGE_TYPES.has((mimeType ?? "").split(";")[0]!.trim().toLowerCase());
}
