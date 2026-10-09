// File name sanitization shared by every export (Slack threads, attachments,
// Web → MD pages, images in zips). Keeps letters/digits of any script.

/** Replace anything but letters, digits, `.`, `_`, `-` with `-`; trim `-`/`.`. */
export function cleanFilenamePart(s: string): string {
  return s
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

/**
 * Filesystem/zip-safe name that keeps the extension, at most `maxLen` code points,
 * e.g. "Ảnh màn hình (2).png" -> "Ảnh-màn-hình-2.png".
 */
export function safeFileName(name: string, maxLen = 80): string {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot >= name.length - 11;
  const ext = hasExt ? cleanFilenamePart(name.slice(dot + 1)).toLowerCase() : '';
  const base = cleanFilenamePart(hasExt ? name.slice(0, dot) : name) || 'file';
  const room = Math.max(1, maxLen - (ext ? ext.length + 1 : 0));
  const head = Array.from(base).slice(0, room).join('');
  return ext ? `${head}.${ext}` : head;
}

/** A label used inside a file name (channel, page title…): cleaned, capped, with a fallback. */
export function filenamePart(s: string, fallback: string, maxLen = 60): string {
  return cleanFilenamePart(s).slice(0, maxLen) || fallback;
}

/** Already-compressed formats: stored as-is in the zip (deflating them only costs CPU). */
export function isPrecompressedPath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|heic|heif|zip|gz|tgz|bz2|xz|7z|rar|pdf|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|ogg|opus|flac|docx|xlsx|pptx|odt|ods|odp|key|pages|numbers|jar|apk|ipa|dmg|woff2?)$/i.test(
    path,
  );
}
