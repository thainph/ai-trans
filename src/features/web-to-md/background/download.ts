// Web → MD "Download" (service worker side): when the Markdown references
// images, fetch them in the offscreen document and save a zip (`<name>.md` +
// images/, links rewritten to them) — like the Slack export. Without
// downloadable images the popup saves the plain .md itself.

import { onTargetMessage, type Result } from '../../../shared/messaging';
import { startZipJob } from '../../../shared/offscreen/zip-job';
import { fromExtensionPage } from '../../../shared/sender';
import {
  collectImageUrls,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  planImages,
  rewriteImageLinks,
} from '../core/web-capture';
import { type DownloadPageResponse, WEB_TARGET, type WebRequest } from '../messages';
import { checkMarkdown } from './limits';

export async function downloadPageZip(
  markdown: string,
  filename: string,
  pageUrl?: string,
): Promise<DownloadPageResponse> {
  const images = planImages(collectImageUrls(markdown));
  if (images.length === 0) return { ok: true, zipped: false, images: { saved: 0, failed: 0 } };
  try {
    return await downloadZip(images, markdown, filename, pageUrl);
  } catch {
    // Offscreen / zip failure: the popup saves the plain .md (original image links).
    return { ok: true, zipped: false, images: { saved: 0, failed: images.length } };
  }
}

async function downloadZip(
  images: ReturnType<typeof planImages>,
  markdown: string,
  filename: string,
  pageUrl?: string,
): Promise<DownloadPageResponse> {
  const job = await startZipJob();
  try {
    const { saved, failed } = await job.fetchImages(
      images,
      { maxBytes: MAX_IMAGE_BYTES, maxTotalBytes: MAX_TOTAL_IMAGE_BYTES, pageUrl },
      () => {},
    );
    if (saved.size === 0) return { ok: true, zipped: false, images: { saved: 0, failed } };
    const zipName = `${filename.replace(/\.md$/i, '')}.zip`;
    // Same "Save as" dialog as the plain .md download.
    await job.saveZip(filename, rewriteImageLinks(markdown, saved), zipName, { saveAs: true });
    return { ok: true, zipped: true, filename: zipName, images: { saved: saved.size, failed } };
  } finally {
    job.dispose();
  }
}

onTargetMessage<WebRequest>(WEB_TARGET, (req, sender) => {
  // Only the Web → MD tab (an extension page) asks for downloads.
  if (!fromExtensionPage(sender)) return { ok: false, error: 'Not allowed.' } satisfies Result;
  const invalid = checkMarkdown(req.markdown);
  if (invalid) return { ok: false, error: invalid } satisfies Result;
  switch (req.type) {
    case 'download-page':
      return downloadPageZip(req.markdown, req.filename, req.pageUrl);
  }
});
