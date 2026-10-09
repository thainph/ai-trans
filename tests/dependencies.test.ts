// Dependency direction (documented in CLAUDE.md):
//   src/shared            → nothing outside src/shared
//   src/features/<name>   → src/shared, its own folder, and the Devdy service API (features/devdy/api.ts)
//   entry points (background, offscreen, popup, content) → anything
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve('src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

/** Relative imports of a file, resolved to paths under src/ (e.g. "shared/errors"). */
function imports(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  return [...code.matchAll(/(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) =>
    relative(SRC, resolve(dirname(file), m[1]!)).replace(/\.ts$/, ''),
  );
}

describe('dependency direction', () => {
  it('src/shared imports nothing outside src/shared', () => {
    const bad = tsFiles(join(SRC, 'shared')).flatMap((f) =>
      imports(f)
        .filter((i) => !i.startsWith('shared/'))
        .map((i) => `${relative(SRC, f)} → ${i}`),
    );
    expect(bad).toEqual([]);
  });

  it('features import only src/shared, themselves and the Devdy service API', () => {
    const bad = tsFiles(join(SRC, 'features')).flatMap((f) => {
      const feature = relative(SRC, f).split('/')[1];
      return imports(f)
        .filter((i) => !i.startsWith('shared/') && !i.startsWith(`features/${feature}/`) && i !== 'features/devdy/api')
        .map((i) => `${relative(SRC, f)} → ${i}`);
    });
    expect(bad).toEqual([]);
  });
});
