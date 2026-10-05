#!/usr/bin/env node
// 生成“审阅台”：一个 claude.ai Artifact 页面，集中放所有审阅稿，手机上选中文字或点选段落即可批注。
// 用法：node scripts/review/build.mjs <输出目录> <文章.md> [<文章.md> ...] [--images <图片目录>]
//   文章可以是 _drafts/ 里的草稿（文件名不带日期），也可以是 _posts/ 里已发布的文章。
//   --images：只给一篇草稿时可用，草稿配图还没放进仓库时指定图片目录，当作 assets/images/<短名>/ 使用。
// 输出：
//   <输出目录>/index.html          审阅台外壳（站点样式、KaTeX、批注层），作为 Artifact 页面本身发布
//   <输出目录>/posts/<短名>.html   每篇文章的正文片段（图片已内联），作为 Artifact 的附属文件发布
//   <输出目录>/posts/<短名>.json   每篇文章的列表信息，写进 Artifact 数据库的 posts 集合
// 发布方法见 WRITING.md 的“手机审阅”。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const SITE = 'https://hczl.github.io';
const usage = '用法：node scripts/review/build.mjs <输出目录> <文章.md> [<文章.md> ...] [--images <图片目录>]';

const args = process.argv.slice(2);
const imgFlag = args.indexOf('--images');
const imagesArg = imgFlag >= 0 ? args.splice(imgFlag, 2)[1] : null;
const [outArg, ...mdArgs] = args;
if (!outArg || !mdArgs.length) { console.error(usage); process.exit(1); }
if (imagesArg && mdArgs.length !== 1) { console.error('--images 只能和一篇文章一起用'); process.exit(1); }
const outDir = path.resolve(outArg);

const datePrefix = /^\d{4}-\d{2}-\d{2}-/;
const sources = mdArgs.map(a => {
  const mdPath = path.resolve(a);
  if (!fs.existsSync(mdPath)) { console.error(`找不到文件：${mdPath}`); process.exit(1); }
  const base = path.basename(mdPath, '.md');
  return { mdPath, slug: base.replace(datePrefix, ''), isPost: datePrefix.test(base) };
});

// 在临时目录里复制一份站点再构建，不碰工作区（_site、_drafts 都不动）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hczl-review-src-'));
const skip = new Set(['.git', '_site', 'vendor', '.bundle', '.jekyll-cache', '.sass-cache', 'node_modules', '_drafts']);
for (const name of fs.readdirSync(repo)) {
  if (skip.has(name)) continue;
  fs.cpSync(path.join(repo, name), path.join(tmp, name), { recursive: true });
}
fs.mkdirSync(path.join(tmp, '_drafts'), { recursive: true });
for (const s of sources) {
  // 同名草稿和已发布文章会撞网址：草稿替换掉同名的已发布文章。
  if (!s.isPost) {
    for (const f of fs.readdirSync(path.join(tmp, '_posts'))) {
      if (f.replace(datePrefix, '') === `${s.slug}.md`) fs.rmSync(path.join(tmp, '_posts', f));
    }
  }
  fs.copyFileSync(s.mdPath, path.join(tmp, s.isPost ? '_posts' : '_drafts', path.basename(s.mdPath)));
}
if (imagesArg) fs.cpSync(path.resolve(imagesArg), path.join(tmp, 'assets', 'images', sources[0].slug), { recursive: true });

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

const read = p => fs.readFileSync(path.join(siteOut, p), 'utf8');
const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2' };
const dataUri = p => {
  const file = path.join(siteOut, decodeURI(p));
  if (!fs.existsSync(file)) { console.warn(`警告：缺少资源 ${p}`); return null; }
  return `data:${mime[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;
};
const unescape = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pick = (html, re) => unescape(((html.match(re) || [])[1] || '').replace(/<[^>]+>/g, '').trim());

fs.mkdirSync(path.join(outDir, 'posts'), { recursive: true });
const builtAt = new Date().toISOString();

for (const s of sources) {
  const built = path.join(siteOut, 'notes', s.slug, 'index.html');
  if (!fs.existsSync(built)) { console.error(`构建结果里没有 /notes/${s.slug}/`); process.exit(1); }
  const html = fs.readFileSync(built, 'utf8');
  let article = (html.match(/<main id="main">([\s\S]*?)<\/main>/) || [])[1];
  if (!article) { console.error(`${s.slug}：页面里找不到 <main>`); process.exit(1); }

  // 文中图片转成 data URI，保留原路径（data-file）方便批注定位；SVG 打上标记，沿用站点黑夜模式下反色的规则。
  article = article.replace(/<img([^>]*?)src="(\/assets\/[^"]+)"/g, (m, pre, src) => {
    const uri = dataUri(src);
    if (!uri) return m;
    return `<img${pre}data-file="${src}" ${src.endsWith('.svg') ? 'data-svg ' : ''}src="${uri}"`;
  });
  // 图片外层的“查看原图”链接在审阅页里没有意义，交给批注层接管。
  article = article.replace(/<a href="\/assets\/images\/[^"]+" target="_blank" rel="noopener">/g, '<a class="figure-link">');
  // 站内链接指向线上站点。
  article = article.replace(/href="\/(?!\/)([^"]*)"/g, `href="${SITE}/$1" target="_blank" rel="noopener"`);
  fs.writeFileSync(path.join(outDir, 'posts', `${s.slug}.html`), article);

  const order = pick(html, /series-pos">第 (\d+) 篇/);
  const meta = {
    slug: s.slug,
    title: pick(html, /<h1>([\s\S]*?)<\/h1>/) || s.slug,
    description: pick(html, /<meta name="description" content="([^"]*)"/),
    kind: s.isPost ? 'post' : 'draft',
    date: pick(html, /<time datetime="([^"]+)"/),
    series: pick(html, /series-name">([^<]*)</),
    seriesOrder: order ? Number(order) : null,
    builtAt,
    sourceHash: createHash('sha256').update(fs.readFileSync(s.mdPath)).digest('hex').slice(0, 12),
  };
  fs.writeFileSync(path.join(outDir, 'posts', `${s.slug}.json`), JSON.stringify(meta, null, 2) + '\n');
  console.log(`posts/${s.slug}.html  ${(fs.statSync(path.join(outDir, 'posts', `${s.slug}.html`)).size / 1024).toFixed(0)} KB  ${meta.kind === 'draft' ? '草稿' : '已发布'}  ${meta.title}`);
}

// ---------- 审阅台外壳 ----------
const katexCss = read('assets/katex/katex.min.css').replace(/url\((fonts\/[^)]+?\.woff2)\)/g, (m, f) => {
  const uri = dataUri(`/assets/katex/${f}`);
  return uri ? `url(${uri})` : m;
}).replace(/,url\(fonts\/[^)]+\) format\("(woff|truetype)"\)/g, '');

// site.js 的第二段（目录、代码复制按钮、表格滚动）要在每篇正文载入后再跑一次，抽成函数。
const siteJs = read('assets/site.js');
const enhanceAt = siteJs.indexOf('(() => {\n  const article');
if (enhanceAt < 0 || !siteJs.trimEnd().endsWith('})();')) { console.error('assets/site.js 结构变了，需要更新 build.mjs 里抽取正文增强脚本的方式'); process.exit(1); }
const enhanceJs = 'window.__enhance = () => {' + siteJs.slice(enhanceAt + '(() => {'.length).trimEnd().replace(/\}\)\(\);$/, '};');

const css = [read('assets/style.css'), read('assets/series.css'), katexCss, fs.readFileSync(path.join(here, 'review.css'), 'utf8')].join('\n');
const shell = `<title>博客审阅台</title>
<style>${css}</style>
<script>(()=>{const r=document.documentElement;if(r.dataset.theme==='dark'||r.dataset.theme==='light')return;let t;try{t=localStorage.getItem('theme')}catch(e){}if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';r.dataset.theme=t})()</script>
<div class="site-shell review-shell">
  <header class="site-header">
    <a class="brand" href="#" aria-label="审阅台首页"><span class="brand-symbol" aria-hidden="true">h.</span><span>hczl<span class="brand-caption"> / 审阅台</span></span></a>
    <nav aria-label="审阅工具">
      <button class="theme-toggle" type="button" aria-label="切换黑夜模式" title="切换黑夜模式"><svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg><svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
    </nav>
  </header>
  <main id="main"></main>
</div>
<script>${read('assets/katex/katex.min.js')}</script>
<script>${read('assets/katex/auto-render.min.js')}</script>
<script>
// 与 _includes/math.html 的配置一致。
window.__renderMath = el => { if (window.renderMathInElement) renderMathInElement(el, { delimiters: [{ left: '\\\\[', right: '\\\\]', display: true }, { left: '\\\\(', right: '\\\\)', display: false }], throwOnError: false }); };
${enhanceJs}
</script>
<script>${fs.readFileSync(path.join(here, 'review.js'), 'utf8')}</script>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), shell);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`index.html  ${(Buffer.byteLength(shell) / 1024).toFixed(0)} KB  输出目录：${outDir}`);
