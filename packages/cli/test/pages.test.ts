import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { badRender, expectedPixels, pngSize } from '../src/commands/pages.js';
import { main } from '../src/main.js';
import { memIo, tempCopy, tempDir } from './helpers.js';

/** The first 24 bytes of a PNG: signature and IHDR with width and height. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('overfull pages: --dpi and the rendered image', () => {
  it('refuses --dpi above 600 as a usage error', async () => {
    const io = memIo(tempCopy('project'));
    expect(await main(['pages', '1', '--dpi', '5000'], io)).toBe(2);
    expect(io.stderrText()).toContain('--dpi must be at most 600, got 5000');
  });

  it('refuses a --pdf outside the project, like check --pdf', async () => {
    const io = memIo(tempCopy('project'));
    expect(await main(['pages', '1', '--pdf', '../elsewhere.pdf'], io)).toBe(2);
    expect(io.stderrText()).toContain('outside the project directory');
  });

  it('knows the expected size and spots a wrong image', () => {
    // A4 at 72 dpi is 595 × 842 points; rotated pages swap the sides.
    expect(expectedPixels([0, 0, 595, 842], 0, 72)).toEqual([595, 842]);
    expect(expectedPixels([0, 0, 595, 842], 90, 144)).toEqual([1684, 1190]);
    const dir = tempDir();
    writeFileSync(join(dir, 'ok.png'), png(596, 842));
    writeFileSync(join(dir, 'tiny.png'), png(1, 1));
    writeFileSync(join(dir, 'not.png'), 'hello');
    expect(pngSize(join(dir, 'ok.png'))).toEqual([596, 842]);
    expect(badRender(join(dir, 'ok.png'), [595, 842])).toBeUndefined();
    expect(badRender(join(dir, 'tiny.png'), [595, 842])).toBe(
      'the image is 1×1 pixels, expected about 595×842',
    );
    expect(badRender(join(dir, 'not.png'), [595, 842])).toBe('no PNG was written');
    expect(badRender(join(dir, 'missing.png'), [595, 842])).toBe('no PNG was written');
  });

  it.skipIf(process.platform === 'win32')(
    'reports a page whose PNG has the wrong size as a failure',
    async () => {
      // A fake pdftoppm first on PATH that writes a 1×1 PNG, as pdftoppm does at huge sizes.
      const bin = tempDir();
      writeFileSync(
        join(bin, 'pdftoppm'),
        `#!/bin/sh\nfor last; do :; done\nprintf '\\211PNG\\r\\n\\032\\n\\000\\000\\000\\rIHDR\\000\\000\\000\\001\\000\\000\\000\\001' > "$last.png"\n`,
        { mode: 0o755 },
      );
      const io = memIo(tempCopy('project'), { PATH: `${bin}:${process.env.PATH}` });
      const saved = process.env.PATH;
      process.env.PATH = `${bin}:${saved}`;
      try {
        expect(await main(['pages', '1', '--json'], io)).toBe(1);
      } finally {
        process.env.PATH = saved;
      }
      const out = JSON.parse(io.stdoutText()) as { error: { code: string; message: string } };
      expect(out.error.code).toBe('render-failed');
      expect(out.error.message).toMatch(/Could not render page 1: the image is 1×1 pixels/);
    },
  );
});
