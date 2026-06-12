// Render Pitchbox brand exports (favicons, app icons, extension icons) from
// the SVG masters in `assets/brand/`. Run with `pnpm exec tsx scripts/render-brand.ts`.
//
// Outputs:
//   - assets/brand/exports/mark-{size}.png
//   - web/static/favicon.svg, favicon.ico (PNG fallback at /favicon-32.png), apple-touch-icon.png, og-image.png
//   - extension/public/icons/icon-{size}.png
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const MARK = resolve(ROOT, 'assets/brand/mark.svg');

const FAVICON_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const EXTENSION_SIZES = [16, 32, 48, 128];

async function ensure(dir: string) {
  await mkdir(dir, { recursive: true });
}

async function renderPng(svg: Buffer, size: number, out: string) {
  await ensure(dirname(out));
  await sharp(svg, { density: Math.max(72, size * 2) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

async function main() {
  const svg = await readFile(MARK);

  // Brand exports
  for (const s of FAVICON_SIZES) {
    await renderPng(svg, s, resolve(ROOT, `assets/brand/exports/mark-${s}.png`));
  }

  // Web static
  const webStatic = resolve(ROOT, 'web/static');
  await ensure(webStatic);
  await copyFile(MARK, resolve(webStatic, 'favicon.svg'));
  await renderPng(svg, 32, resolve(webStatic, 'favicon-32.png'));
  await renderPng(svg, 180, resolve(webStatic, 'apple-touch-icon.png'));
  await renderPng(svg, 512, resolve(webStatic, 'icon-512.png'));
  // OG image at 1200x630 with the mark centered on the brand background colour.
  const og = await sharp({
    create: { width: 1200, height: 630, channels: 4, background: '#0b1220' },
  })
    .composite([
      {
        input: await sharp(svg, { density: 600 }).resize(360, 360).png().toBuffer(),
        top: 135,
        left: 420,
      },
    ])
    .png()
    .toBuffer();
  await writeFile(resolve(webStatic, 'og-image.png'), og);
  console.log(`wrote ${resolve(webStatic, 'og-image.png')}`);

  // Webmanifest
  const manifest = {
    name: 'Pitchbox',
    short_name: 'Pitchbox',
    description: 'Self-hosted outreach agent for Reddit.',
    icons: [
      { src: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    theme_color: '#0a0a0a',
    background_color: '#0a0a0a',
    display: 'standalone',
  };
  await writeFile(resolve(webStatic, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${resolve(webStatic, 'manifest.webmanifest')}`);

  // Extension icons
  for (const s of EXTENSION_SIZES) {
    await renderPng(svg, s, resolve(ROOT, `extension/public/icons/icon-${s}.png`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
