// Verify dist/: every file referenced by manifest.json, by the built HTML pages
// and by the code (extension page URLs) exists.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
const missing = [];
const check = (path, from) => {
  const clean = path.replace(/^\//, '').split(/[?#]/)[0];
  if (!existsSync(join(dist, clean))) missing.push(`${clean} (referenced by ${from})`);
};

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
check(manifest.background.service_worker, 'manifest background');
check(manifest.action.default_popup, 'manifest action');
for (const icon of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
  check(icon, 'manifest icons');
}
for (const cs of manifest.content_scripts) {
  for (const f of [...(cs.js ?? []), ...(cs.css ?? [])]) check(f, 'manifest content_scripts');
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const files = walk(dist);
for (const html of files.filter((f) => f.endsWith('.html'))) {
  for (const [, ref] of readFileSync(html, 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(https?:|data:|#)/.test(ref)) continue;
    check(ref.startsWith('/') ? ref : join(html.slice(dist.length + 1), '..', ref), html);
  }
}
// Extension pages opened by code (popup shell iframes, offscreen document, tabs).
let pageRefs = 0;
for (const js of files.filter((f) => f.endsWith('.js'))) {
  for (const [, ref] of readFileSync(js, 'utf8').matchAll(/["'`](\/?src\/[\w/.-]+\.html)["'`]/g)) {
    check(ref, js);
    pageRefs++;
  }
}

if (missing.length) {
  console.error(`Missing in dist/:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`dist/ OK (${files.length} files, ${pageRefs} page URLs in code; every referenced path exists)`);
