#!/usr/bin/env node
// 把一篇文章（草稿或已发布）打包成单文件审阅页，发布为 claude.ai Artifact 后可在手机上选中文字批注。
// 用法：node scripts/review/build.mjs <文章.md> [输出目录] [--images <图片目录>]
// 输出：<输出目录>/review-<短名>.html，默认输出到系统临时目录下的 hczl-review/。
// --images：草稿配图还没放进仓库时，指定图片所在目录，构建时当作 assets/images/<短名>/ 使用。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const SITE = 'https://hczl.github.io';

const args = process.argv.slice(2);
const imgFlag = args.indexOf('--images');
const imagesArg = imgFlag >= 0 ? args.splice(imgFlag, 2)[1] : null;
const [mdArg, outArg] = args;
if (!mdArg) {
  console.error('用法：node scripts/review/build.mjs <文章.md> [输出目录] [--images <图片目录>]');
  process.exit(1);
}
const mdPath = path.resolve(mdArg);
if (!fs.existsSync(mdPath)) { console.error(`找不到文件：${mdPath}`); process.exit(1); }
const outDir = path.resolve(outArg || path.join(os.tmpdir(), 'hczl-review'));

const base = path.basename(mdPath, '.md');
const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
const isPost = /^\d{4}-\d{2}-\d{2}-/.test(base);

// 在临时目录里复制一份站点再构建，不碰工作区（_site、_drafts 都不动）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hczl-review-src-'));
const skip = new Set(['.git', '_site', 'vendor', '.bundle', '.jekyll-cache', '.sass-cache', 'node_modules', '_drafts']);
for (const name of fs.readdirSync(repo)) {
  if (skip.has(name)) continue;
  fs.cpSync(path.join(repo, name), path.join(tmp, name), { recursive: true });
}
// 同名草稿和已发布文章会撞网址：放进来的只有这一篇。
const destDir = path.join(tmp, isPost ? '_posts' : '_drafts');
fs.mkdirSync(destDir, { recursive: true });
if (!isPost) {
  for (const f of fs.readdirSync(path.join(tmp, '_posts'))) {
    if (f.replace(/^\d{4}-\d{2}-\d{2}-/, '') === `${slug}.md`) fs.rmSync(path.join(tmp, '_posts', f));
  }
}
fs.copyFileSync(mdPath, path.join(destDir, path.basename(mdPath)));
if (imagesArg) fs.cpSync(path.resolve(imagesArg), path.join(tmp, 'assets', 'images', slug), { recursive: true });

const siteOut = path.join(tmp, '_site');
// Jekyll 3 在源目录不是当前目录时找不到布局文件，所以在临时目录里运行，Gemfile 仍用仓库的。
// bundler 可能顺手改写 Gemfile.lock（平台不同时），构建完原样写回，不留改动。
const lockFile = path.join(repo, 'Gemfile.lock');
const lockBefore = fs.existsSync(lockFile) ? fs.readFileSync(lockFile) : null;
try {
  execFileSync('bundle', ['exec', 'jekyll', 'build', '--drafts', '--future', '-q', '-d', siteOut],
    { cwd: tmp, stdio: 'inherit', env: { ...process.env, BUNDLE_GEMFILE: path.join(repo, 'Gemfile') } });
} finally {
  if (lockBefore && !lockBefore.equals(fs.readFileSync(lockFile))) fs.writeFileSync(lockFile, lockBefore);
}

const built = path.join(siteOut, 'notes', slug, 'index.html');
if (!fs.existsSync(built)) { console.error(`构建结果里没有 /notes/${slug}/`); process.exit(1); }
const html = fs.readFileSync(built, 'utf8');

const read = p => fs.readFileSync(path.join(siteOut, p), 'utf8');
const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const dataUri = p => {
  const file = path.join(siteOut, decodeURI(p));
  if (!fs.existsSync(file)) { console.warn(`警告：缺少资源 ${p}`); return null; }
  return `data:${mime[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;
};

const title = (html.match(/<h1>([\s\S]*?)<\/h1>/) || [])[1] || slug;
let article = (html.match(/<main id="main">([\s\S]*?)<\/main>/) || [])[1];
if (!article) { console.error('页面里找不到 <main>'); process.exit(1); }

// 文中图片转成 data URI；SVG 打上标记，沿用站点黑夜模式下反色的规则。
article = article.replace(/<img([^>]*?)src="(\/assets\/[^"]+)"/g, (m, pre, src) => {
  const uri = dataUri(src);
  if (!uri) return m;
  return `<img${pre}data-file="${src}" ${src.endsWith('.svg') ? 'data-svg ' : ''}src="${uri}"`;
});
// 图片外层的“查看原图”链接在审阅页里没有意义，交给批注层接管。
article = article.replace(/<a href="\/assets\/images\/[^"]+" target="_blank" rel="noopener">/g, '<a class="figure-link">');
// 站内链接指向线上站点。
article = article.replace(/href="\/(?!\/)([^"]*)"/g, `href="${SITE}/$1" target="_blank" rel="noopener"`);

const hasMath = html.includes('katex.min.js');
let katexCss = '';
let katexJs = '';
if (hasMath) {
  katexCss = read('assets/katex/katex.min.css').replace(/url\((fonts\/[^)]+?\.woff2)\)/g, (m, f) => {
    const uri = dataUri(`/assets/katex/${f}`);
    return uri ? `url(${uri})` : m;
  }).replace(/,url\(fonts\/[^)]+\) format\("(woff|truetype)"\)/g, '');
  const snippet = (html.match(/<script>(document\.addEventListener\('DOMContentLoaded',\(\)=>\{const el=document\.querySelector\('\.post-content'\)[\s\S]*?)<\/script>/) || [])[1] || '';
  katexJs = `<script>${read('assets/katex/katex.min.js')}</script>\n<script>${read('assets/katex/auto-render.min.js')}</script>\n<script>${snippet.replace("document.addEventListener('DOMContentLoaded',()=>", 'window.__renderMath=(()=>').replace(/\}\)$/, '})')}</script>`;
}

const siteCss = read('assets/style.css') + '\n' + read('assets/series.css');
const siteJs = read('assets/site.js');
const reviewCss = fs.readFileSync(path.join(here, 'review.css'), 'utf8');
const reviewJs = fs.readFileSync(path.join(here, 'review.js'), 'utf8');

const source = fs.readFileSync(mdPath);
const meta = {
  slug,
  title: title.replace(/<[^>]+>/g, ''),
  kind: isPost ? 'post' : 'draft',
  builtAt: new Date().toISOString(),
  sourceHash: createHash('sha256').update(source).digest('hex').slice(0, 12),
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const builtLabel = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

const page = `<title>审阅 · ${esc(meta.title)}</title>
<style>${siteCss}
${katexCss}
${reviewCss}</style>
<script>(()=>{const r=document.documentElement;if(r.dataset.theme!=='dark'&&r.dataset.theme!=='light')r.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()</script>
<script id="review-meta" type="application/json">${JSON.stringify(meta).replace(/</g, '\\u003c')}</script>
<div class="site-shell review-shell">
  <header class="site-header">
    <span class="brand"><span class="brand-symbol" aria-hidden="true">h.</span><span>hczl<span class="brand-caption"> / 审阅稿</span></span></span>
    <nav aria-label="审阅工具">
      <span class="review-stamp">${meta.kind === 'draft' ? '草稿' : '已发布'} · ${esc(builtLabel)}</span>
      <button class="theme-toggle" type="button" aria-label="切换黑夜模式" title="切换黑夜模式"><svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
    </nav>
  </header>
  <main id="main">${article}</main>
</div>
${katexJs}
<script>${siteJs}</script>
<script>if(window.__renderMath)window.__renderMath();</script>
<script>${reviewJs}</script>
`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `review-${slug}.html`);
fs.writeFileSync(outFile, page);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${outFile}  ${(Buffer.byteLength(page) / 1024).toFixed(0)} KB  ${meta.title}`);
