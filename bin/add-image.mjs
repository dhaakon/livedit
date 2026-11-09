// Brings one of the owner's photos into the site the implementer is editing
// (the current directory): optionally crops it, resizes it to at most 2400px
// on its long edge, writes public/images/<dir>/<name>.jpg and prints the
// src/w/h for the content JSON.
//
// Lives with the live-edits tooling (not in the site) so every request gets
// the current version, whichever published version it builds on.
//
//   node <this> --info <source>
//       -> {"width":1170,"height":2532,"format":"jpeg"}   (after EXIF rotation)
//   node <this> <source> <dir> <name> [--crop left,top,width,height]
//                                      [--aspect W:H] [--position center|top|bottom|left|right|'top left'…]
//       -> {"src":"/images/uploads/sunflower-kiss.jpg","w":770,"h":940}
//
// --crop takes pixels in the --info coordinate space (e.g. to cut away a
// screenshot's app chrome). --aspect crops to that ratio around --position
// (default center); both may be combined (crop first, then aspect).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const site = process.cwd();
const sharp = createRequire(join(site, 'package.json'))('sharp');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const infoSource = flag('info');
if (infoSource) {
  // rotate() first so dimensions match what a person sees.
  const { info } = await sharp(resolve(infoSource)).rotate().toBuffer({ resolveWithObject: true });
  console.log(JSON.stringify({ width: info.width, height: info.height, format: info.format }));
  process.exit(0);
}

const crop = flag('crop');
const aspect = flag('aspect');
const position = flag('position') ?? 'center';
const [source, dir = 'uploads', name] = args;
if (!source || !name || !/^[a-z0-9-]+$/.test(name) || !/^[a-z0-9-/]+$/.test(dir)) {
  fail('usage: add-image.mjs <source> <dir> <kebab-case-name> [--crop l,t,w,h] [--aspect W:H] [--position top|centre|…]\n       add-image.mjs --info <source>');
}

let image = sharp(resolve(source)).rotate();
let { info } = await image.clone().toBuffer({ resolveWithObject: true });

if (crop) {
  const [left, top, width, height] = crop.split(',').map((n) => Math.round(Number(n)));
  if ([left, top, width, height].some((n) => !Number.isFinite(n) || n < 0) || !width || !height) fail('--crop needs left,top,width,height in pixels');
  if (left + width > info.width || top + height > info.height) fail(`--crop is outside the ${info.width}x${info.height} image`);
  image = sharp(await image.extract({ left, top, width, height }).toBuffer());
  info = { width, height };
}

if (aspect) {
  // Cut the ratio out as an explicit box (a second resize() would replace the
  // final size cap rather than add to it).
  const [aw, ah] = aspect.split(':').map(Number);
  if (!aw || !ah) fail('--aspect needs W:H, e.g. 4:5');
  const target = aw / ah;
  const wide = info.width / info.height > target;
  const width = wide ? Math.round(info.height * target) : info.width;
  const height = wide ? info.height : Math.round(info.width / target);
  const words = position.toLowerCase();
  const fx = /left/.test(words) ? 0 : /right/.test(words) ? 1 : 0.5;
  const fy = /top/.test(words) ? 0 : /bottom/.test(words) ? 1 : 0.5;
  const left = Math.round((info.width - width) * fx);
  const top = Math.round((info.height - height) * fy);
  image = sharp(await image.extract({ left, top, width, height }).toBuffer());
  info = { width, height };
}

const outDir = join(site, 'public', 'images', dir);
mkdirSync(outDir, { recursive: true });
const out = await image
  .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 82, mozjpeg: true })
  .toFile(join(outDir, `${name}.jpg`));

console.log(JSON.stringify({ src: `/images/${dir}/${name}.jpg`, w: out.width, h: out.height }));
