// Background service worker: receives export requests from the popup,
// runs Slack API calls inside an open app.slack.com tab, builds Markdown,
// and (for "download") saves the file via chrome.downloads.

import { planAttachments } from '../core/attachments';
import { buildThreadMarkdown } from '../core/md-builder';
import { parseThreadLink } from '../core/permalink';
import {
  type PageRequest,
  type PageResponse,
  type PageRunner,
  SlackExportError,
  fetchThread,
  formatWait,
  pageSlackApi,
} from '../core/slack-client';
import { EXPORT_PORT_NAME, type ExportRequest, type ExportResponse } from '../types/messages';
import { keepAliveSleep } from './keepalive';
import { makeDoneResponse } from './respond';
import { startZipJob } from './zip-export';

const SLACK_TAB_PATTERN = 'https://app.slack.com/*';

async function findSlackTab(teamId?: string): Promise<chrome.tabs.Tab> {
  const tabs = (await chrome.tabs.query({ url: SLACK_TAB_PATTERN })).filter((t) => t.id !== undefined);
  if (tabs.length === 0) {
    throw new SlackExportError('no_slack_tab', 'Please open app.slack.com and log in, then try again.');
  }
  const score = (t: chrome.tabs.Tab): number => {
    let s = 0;
    if (!t.discarded) s += 100;
    if (t.status === 'complete') s += 10;
    if (teamId && t.url?.includes(`/client/${teamId}`)) s += 50;
    if (t.active) s += 5;
    return s * 1e13 + (t.lastAccessed ?? 0);
  };
  return tabs.sort((a, b) => score(b) - score(a))[0]!;
}

function makeRunner(tabId: number): PageRunner {
  return async (req: PageRequest): Promise<PageResponse> => {
    let injection: chrome.scripting.InjectionResult<Awaited<PageResponse>>[];
    try {
      injection = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: pageSlackApi,
        args: [req],
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new SlackExportError(
        'inject_failed',
        `Could not access the Slack tab. Reload app.slack.com and try again. (${detail})`,
      );
    }
    const result = injection[0]?.result;
    if (!result) {
      throw new SlackExportError('inject_failed', 'The Slack tab returned no result. Reload app.slack.com and try again.');
    }
    return result;
  };
}

function toDataUrl(markdown: string): string {
  // Service workers have no URL.createObjectURL, so use a data: URL.
  const bytes = new TextEncoder().encode(markdown);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:text/markdown;charset=utf-8;base64,${btoa(binary)}`;
}

async function handleExport(req: ExportRequest, post: (msg: ExportResponse) => void): Promise<void> {
  const parsed = parseThreadLink(req.link);
  if (!parsed.ok) {
    post({ type: 'error', message: parsed.error.message });
    return;
  }

  post({ type: 'progress', text: 'Looking for an app.slack.com tab…' });
  const tab = await findSlackTab(parsed.value.teamId);
  const run = makeRunner(tab.id!);

  const onProgress = (text: string) => post({ type: 'progress', text });
  const { data, warning: fetchWarning } = await fetchThread(run, parsed.value, {
    onProgress,
    // Rate-limit waits happen here (not in the page) with keepalive pings + progress messages.
    sleep: (ms) => keepAliveSleep(ms, undefined, undefined, (left) => onProgress(`Rate limited by Slack — retrying in ${formatWait(left)}…`)),
  });
  // "Export" with attachments → Markdown + files/ in a .zip (when there is anything to download).
  const wantZip = req.action === 'download' && req.options.includeFiles && req.options.zipFiles;
  const plan = wantZip ? planAttachments(data.messages) : undefined;
  // Outcome per file id; skipped/failed files keep their Slack link plus a note.
  let attachments = plan?.skipped;
  let fileWarning: string | undefined;

  if (plan && plan.downloads.length > 0) {
    const job = await startZipJob();
    try {
      const fetched = await job.fetchFiles(plan, onProgress);
      attachments = fetched.outcomes;
      if (fetched.failed) {
        fileWarning = `${fetched.failed} file(s) could not be downloaded; their Slack links are kept in the Markdown.`;
      }
      // Nothing downloaded → a zip would only wrap the .md, so save the .md instead (below).
      if (fetched.saved > 0) {
        const result = buildThreadMarkdown(data, { ...req.options, attachments });
        const zipFilename = result.filename.replace(/\.md$/, '.zip');
        post({ type: 'progress', text: 'Building zip…' });
        await job.saveZip(result.filename, result.markdown, zipFilename);
        post(
          makeDoneResponse(
            'download',
            { ...result, filename: zipFilename },
            [fetchWarning, fileWarning].filter(Boolean).join(' ') || undefined,
            { saved: fetched.saved, notIncluded: attachments.size - fetched.saved },
          ),
        );
        return;
      }
    } finally {
      job.dispose();
    }
  }

  const result = buildThreadMarkdown(data, { ...req.options, attachments });
  const warning = [fetchWarning, fileWarning].filter(Boolean).join(' ') || undefined;

  if (req.action === 'download') {
    post({ type: 'progress', text: 'Saving file…' });
    await chrome.downloads.download({
      url: toDataUrl(result.markdown),
      filename: result.filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  }

  // Only "copy" needs the Markdown in the popup; downloads return metadata only.
  post(makeDoneResponse(req.action, result, warning));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== EXPORT_PORT_NAME) return;
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
  });
  // The popup may close mid-export (downloads still complete); ignore posting errors.
  const post = (msg: ExportResponse) => {
    if (!connected) return;
    try {
      port.postMessage(msg);
    } catch {
      connected = false;
    }
  };

  port.onMessage.addListener((msg: ExportRequest) => {
    if (msg?.type !== 'export') return;
    handleExport(msg, post).catch((e: unknown) => {
      const message =
        e instanceof SlackExportError ? e.message : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
      post({ type: 'error', message });
    });
  });
});
