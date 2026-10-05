// 审阅台：首页列出所有审阅稿和待处理批注数，点进一篇后可以批注。
// 选中文字，或点一下段落、标题、图、公式、代码块、表格，再点底部的“批注”。
// 数据都在 Artifact 的 db 里：posts 集合是文章列表（Claude 写），comments 集合是批注（页面写，Claude 回写处理结果）。
(() => {
  const POSTS = 'posts';
  const COL = 'comments';
  const main = document.getElementById('main');
  const root = document.documentElement;

  // ---------- 主题切换（站点 site.js 的第一段，审阅台自己实现） ----------
  const themeBtn = document.querySelector('.theme-toggle');
  const applyTheme = t => { root.dataset.theme = t; themeBtn?.setAttribute('aria-pressed', String(t === 'dark')); };
  applyTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');
  themeBtn?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch {}
  });

  // ---------- 小工具 ----------
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...kids.flat().filter(k => k != null && k !== false));
    return el;
  };
  const clip = (s, n) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s);
  const oneLine = s => s.replace(/\s+/g, ' ').trim();
  const figLabel = c => (c.caption && c.caption.startsWith('图') ? c.caption : `图：${c.caption || c.alt || c.file}`);
  const fmtTime = iso => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return iso; }
  };
  const fmtDate = iso => (iso ? iso.slice(0, 10) : '');

  // ---------- 状态 ----------
  let db = null;
  let dbState = 'connecting';   // connecting | ready | none
  let posts = [];
  let comments = [];
  let view = null;              // null = 首页；否则为当前文章的 slug
  let article = null;           // 当前文章的 <article>
  let idx = null;

  // ---------- 正文文本索引：把可批注的文字拼成一条字符串，偏移量用于定位 ----------
  const SKIP = '.katex-mathml,script,style,[data-rv-ui],.copy-code,.series-box,.toc,.series-pager,.post-end,.back-link,.post-meta';
  const buildIndex = () => {
    const nodes = [];
    const map = new Map();
    let text = '';
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      map.set(n, nodes.length);
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    idx = { nodes, map, text };
  };
  const pointToOffset = (container, offset) => {
    const i = idx.map.get(container);
    if (i !== undefined) return idx.nodes[i].start + Math.min(offset, container.length);
    const r = document.createRange();
    try { r.setStart(container, offset); } catch { return idx.text.length; }
    for (const n of idx.nodes) if (r.comparePoint(n.node, 0) >= 0) return n.start;
    return idx.text.length;
  };
  const offsetToPoint = off => {
    const ns = idx.nodes;
    let lo = 0, hi = ns.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ns[mid].start <= off) lo = mid; else hi = mid - 1; }
    const n = ns[lo];
    return [n.node, Math.min(off - n.start, n.node.length)];
  };
  const offsetsToRange = (s, e) => {
    if (!idx.nodes.length) return null;
    const r = document.createRange();
    r.setStart(...offsetToPoint(s));
    r.setEnd(...offsetToPoint(e));
    return r;
  };
  const elementOffsets = el => {
    const r = document.createRange(); r.selectNodeContents(el);
    return [pointToOffset(r.startContainer, r.startOffset), pointToOffset(r.endContainer, r.endOffset)];
  };
  const sectionOf = node => {
    let label = '开头';
    for (const hd of article.querySelectorAll('.post-content h2, .post-content h3')) {
      if (hd === node || hd.contains(node) || (hd.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) label = hd.textContent.trim();
      else break;
    }
    return label;
  };
  const texIn = range => [...article.querySelectorAll('.katex')]
    .filter(k => range.intersectsNode(k))
    .map(k => k.querySelector('annotation')?.textContent?.trim())
    .filter(Boolean);

  const QUOTE_MAX = 2000;
  const snapshotFromOffsets = (s, e, node, range, label) => {
    const quote = idx.text.slice(s, e);
    if (!quote.trim()) return null;
    return {
      kind: 'text', label,
      quote: quote.slice(0, QUOTE_MAX),
      prefix: idx.text.slice(Math.max(0, s - 40), s),
      suffix: idx.text.slice(e, e + 40),
      tex: texIn(range),
      section: sectionOf(node),
    };
  };

  // ---------- 可点选的块 ----------
  const BLOCKS = [
    ['figure', '.post-content figure, .post-content p:has(> img:only-child)', '这张图'],
    ['math', '.post-content .katex-display', '这个公式'],
    ['code', '.post-content .code-wrap', '这段代码'],
    ['table', '.post-content .table-wrap', '这张表'],
    ['heading', '.post-header h1, .post-content h2, .post-content h3, .post-content h4', '这个标题'],
    ['para', '.post-header > p, .post-content p, .post-content li, .post-content blockquote', '这一段'],
  ];
  const blockOf = target => {
    if (!(target instanceof Element) || target.closest('a[href], button, summary, [data-rv-ui]')) return null;
    for (const [type, sel, label] of BLOCKS) {
      const el = target.closest(sel);
      if (el && article.contains(el)) return { type, el, label };
    }
    return null;
  };
  const snapshotFromBlock = b => {
    if (b.type === 'figure') {
      const img = b.el.querySelector('img');
      return {
        kind: 'figure', label: '这张图',
        file: img?.dataset.file || '',
        alt: img?.getAttribute('alt') || '',
        caption: b.el.querySelector('figcaption')?.textContent.trim() || '',
        section: sectionOf(b.el),
      };
    }
    const [s, e] = elementOffsets(b.el);
    const r = document.createRange(); r.selectNodeContents(b.el);
    const snap = snapshotFromOffsets(s, e, b.el, r, b.label);
    if (snap) snap.block = b.type;
    return snap;
  };
  const snapshotFromSelection = () => {
    if (!article) return null;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!article.contains(r.commonAncestorContainer)) return null;
    const s = pointToOffset(r.startContainer, r.startOffset);
    const e = pointToOffset(r.endContainer, r.endOffset);
    if (e <= s) return null;
    return snapshotFromOffsets(s, e, r.startContainer, r, `选中的 ${[...idx.text.slice(s, e).trim()].length} 字`);
  };

  // ---------- 重新定位已有批注 ----------
  const commonTail = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
  const commonHead = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
  const locate = c => {
    if (c.kind === 'figure') {
      const img = [...article.querySelectorAll('img[data-file]')].find(i => i.dataset.file === c.file);
      const el = img?.closest('figure, p') || null;
      return el ? { el, start: elementOffsets(el)[0] } : null;
    }
    if (c.kind !== 'text' || !c.quote) return null;
    const t = idx.text;
    let best = -1, bestScore = -1;
    for (let i = t.indexOf(c.quote); i !== -1; i = t.indexOf(c.quote, i + 1)) {
      const score = commonTail(t.slice(Math.max(0, i - 40), i), c.prefix || '') + commonHead(t.slice(i + c.quote.length, i + c.quote.length + 40), c.suffix || '');
      if (score > bestScore) { best = i; bestScore = score; }
    }
    return best < 0 ? null : { start: best, end: best + c.quote.length };
  };

  // ---------- 固定界面：浮动按钮、底部栏、输入框、批注列表、提示 ----------
  const fab = h('button', { class: 'rv-fab', type: 'button', 'data-rv-ui': true, 'aria-label': '查看本篇批注', hidden: true }, '批注');
  const bar = h('div', { class: 'rv-bar', 'data-rv-ui': true, hidden: true });
  const barLabel = h('span', { class: 'rv-bar-label' });
  const barGo = h('button', { class: 'rv-btn rv-primary', type: 'button', id: 'rv-bar-go' }, '批注');
  const barX = h('button', { class: 'rv-btn rv-ghost', type: 'button' }, '取消');
  bar.append(barLabel, h('div', { class: 'rv-bar-actions' }, barX, barGo));

  const sheet = h('div', { class: 'rv-sheet', 'data-rv-ui': true, hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rv-sheet-title' });
  const sheetTitle = h('div', { class: 'rv-sheet-title', id: 'rv-sheet-title' });
  const sheetQuote = h('blockquote', { class: 'rv-quote' });
  const note = h('textarea', { id: 'rv-note', class: 'rv-note', rows: '4', maxlength: '2000', placeholder: '写下意见：哪里不对、怎么改、或者一个疑问' });
  const sheetSave = h('button', { class: 'rv-btn rv-primary', type: 'button', id: 'rv-save' }, '保存');
  const sheetCancel = h('button', { class: 'rv-btn rv-ghost', type: 'button', id: 'rv-cancel' }, '取消');
  sheet.append(h('div', { class: 'rv-sheet-inner' }, sheetTitle, sheetQuote, note, h('div', { class: 'rv-sheet-actions' }, sheetCancel, sheetSave)));

  const panel = h('aside', { class: 'rv-panel', 'data-rv-ui': true, hidden: true, 'aria-label': '本篇批注' });
  const panelList = h('div', { class: 'rv-list' });
  const panelCount = h('span', { class: 'rv-panel-count' });
  const filterOpen = h('button', { class: 'rv-tab', type: 'button', 'aria-pressed': 'true' }, '待处理');
  const filterAll = h('button', { class: 'rv-tab', type: 'button', 'aria-pressed': 'false' }, '全部');
  panel.append(h('div', { class: 'rv-panel-inner' },
    h('div', { class: 'rv-panel-head' },
      h('div', { class: 'rv-panel-title' }, h('strong', {}, '本篇批注'), panelCount),
      h('div', { class: 'rv-panel-tools' }, filterOpen, filterAll,
        h('button', { class: 'rv-btn rv-ghost', type: 'button', onclick: () => { togglePanel(false); openComposer({ kind: 'general', label: '整篇', section: '整篇' }); } }, '整体意见'),
        h('button', { class: 'rv-btn rv-ghost', type: 'button', 'aria-label': '关闭批注列表', onclick: () => togglePanel(false) }, '关闭'))),
    panelList));

  const toast = h('div', { class: 'rv-toast', 'data-rv-ui': true, role: 'status', hidden: true });
  document.body.append(fab, bar, sheet, panel, toast);

  let toastTimer;
  const say = msg => { toast.textContent = msg; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3200); };

  // ---------- 选中与点选 ----------
  let pending = null;
  let picked = null;
  let hideTimer;
  const setPicked = el => {
    if (picked) picked.classList.remove('rv-picked');
    picked = el;
    if (picked) picked.classList.add('rv-picked');
  };
  const showBar = snap => {
    pending = snap;
    clearTimeout(hideTimer);
    barLabel.textContent = snap.kind === 'figure' ? `批注这张图${snap.caption ? '：' + clip(snap.caption, 18) : ''}` : `批注${snap.label}`;
    bar.hidden = false;
    fab.hidden = true;
  };
  const hideBar = () => { bar.hidden = true; fab.hidden = !view; pending = null; setPicked(null); };

  document.addEventListener('selectionchange', () => {
    if (!article || !sheet.hidden) return;
    const snap = snapshotFromSelection();
    if (snap) { setPicked(null); showBar(snap); return; }
    if (pending && !picked) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!getSelection().toString()) hideBar(); }, 600); }
  });
  main.addEventListener('click', e => {
    if (!article) return;
    // 正文目录等页内锚点：直接滚动，不改地址栏（地址栏的 # 用来记当前文章）。
    const anchor = e.target.closest?.('a[href^="#"]');
    if (anchor) {
      const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
      const target = id && document.getElementById(id);
      if (target) { e.preventDefault(); target.scrollIntoView({ block: 'start' }); }
      return;
    }
    if (!getSelection().isCollapsed) return;
    const b = blockOf(e.target);
    if (b?.type === 'figure') e.preventDefault();
    if (!b || b.el === picked) { hideBar(); return; }
    const snap = snapshotFromBlock(b);
    if (!snap) return;
    setPicked(b.el);
    showBar(snap);
  });
  barX.addEventListener('click', () => { getSelection().removeAllRanges(); hideBar(); });
  // 手机上点按钮时选区可能先被清掉，所以按下时就锁定目标。
  let locked = null;
  barGo.addEventListener('pointerdown', () => { locked = pending; clearTimeout(hideTimer); });
  barGo.addEventListener('click', () => { const snap = locked || pending; locked = null; if (snap) openComposer(snap); });

  // ---------- 写批注 ----------
  let editing = null;
  let composing = null;
  const openComposer = (snap, existing = null) => {
    editing = existing;
    composing = snap;
    const target = existing || snap;
    sheetTitle.textContent = existing ? '修改批注' : target.kind === 'general' ? '整体意见' : `批注 · ${target.section || ''}`;
    sheetQuote.textContent = target.kind === 'figure' ? figLabel(target)
      : target.kind === 'general' ? '针对整篇文章' : clip(oneLine(target.quote || ''), 160);
    note.value = existing ? existing.note : '';
    sheet.hidden = false;
    bar.hidden = true;
    fab.hidden = true;
    setTimeout(() => note.focus(), 50);
  };
  const closeComposer = () => {
    sheet.hidden = true; editing = null; composing = null;
    getSelection().removeAllRanges(); hideBar();
  };
  sheetCancel.addEventListener('click', closeComposer);

  sheetSave.addEventListener('click', async () => {
    const text = note.value.trim();
    if (!text) { say('先写下意见再保存。'); note.focus(); return; }
    if (!db) { say('批注没有保存：这个页面需要在 claude.ai 或 Claude App 里打开。'); return; }
    sheetSave.disabled = true;
    const now = new Date().toISOString();
    try {
      if (editing) {
        await db.collection(COL).doc(editing.id).update({ note: text, updatedAt: now });
        say('已修改');
      } else {
        const s = composing;
        const post = posts.find(p => p.slug === view);
        const doc = { slug: view, round: post?.sourceHash || '', status: 'open', note: text, createdAt: now, updatedAt: now, kind: s.kind, section: s.section || '' };
        if (s.kind === 'text') Object.assign(doc, { quote: s.quote, prefix: s.prefix, suffix: s.suffix, tex: s.tex || [], block: s.block || 'selection' });
        if (s.kind === 'figure') Object.assign(doc, { file: s.file, alt: s.alt, caption: s.caption });
        await db.collection(COL).add(doc);
        say('已保存，可以接着批注');
      }
      closeComposer();
    } catch (err) {
      say(`保存失败（${err?.code || '未知原因'}），意见还在输入框里，稍后再点保存。`);
    } finally {
      sheetSave.disabled = false;
    }
  });

  // ---------- 本篇的高亮与批注列表 ----------
  const supportsHL = !!(window.CSS && CSS.highlights && window.Highlight);
  let placed = new Map();
  let showAll = false;
  const STATUS = { open: '待处理', done: '已修改', kept: '未改' };
  const mine = () => comments.filter(c => c.slug === view);

  const paint = () => {
    if (supportsHL) CSS.highlights.delete('rv-open');
    placed = new Map();
    if (!article) return;
    article.querySelectorAll('.rv-flag').forEach(el => el.classList.remove('rv-flag'));
    const ranges = [];
    for (const c of mine()) {
      const loc = locate(c);
      if (!loc) continue;
      placed.set(c.id, loc);
      if (c.status !== 'open') continue;
      if (loc.el) loc.el.classList.add('rv-flag');
      else { const r = offsetsToRange(loc.start, loc.end); if (r) ranges.push(r); }
    }
    if (supportsHL) CSS.highlights.set('rv-open', new Highlight(...ranges));
  };

  const reveal = c => {
    const loc = placed.get(c.id);
    if (!loc) { say('原文里找不到这段了，可能已经改过。'); return; }
    togglePanel(false);
    const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    if (loc.el) {
      loc.el.scrollIntoView({ block: 'center', behavior: smooth });
      loc.el.classList.add('rv-pulse'); setTimeout(() => loc.el.classList.remove('rv-pulse'), 1600);
      return;
    }
    const r = offsetsToRange(loc.start, loc.end);
    if (!r) return;
    r.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: smooth });
    if (supportsHL) { CSS.highlights.set('rv-active', new Highlight(r)); setTimeout(() => CSS.highlights.delete('rv-active'), 2000); }
  };

  const confirmDelete = (btn, c) => {
    if (btn.dataset.armed) {
      db.collection(COL).doc(c.id).delete().then(() => say('已删除')).catch(err => say(`删除失败（${err?.code || '未知原因'}）`));
      return;
    }
    btn.dataset.armed = '1'; btn.textContent = '确认删除';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = '删除'; }, 3000);
  };

  const order = c => (c.kind === 'general' ? -1 : placed.get(c.id)?.start ?? Number.MAX_SAFE_INTEGER);
  const renderPost = () => {
    paint();
    const list0 = mine();
    const open = list0.filter(c => c.status === 'open').length;
    fab.textContent = open ? `批注 ${open}` : '批注';
    panelCount.textContent = `待处理 ${open} · 共 ${list0.length}`;
    filterOpen.setAttribute('aria-pressed', String(!showAll));
    filterAll.setAttribute('aria-pressed', String(showAll));
    const list = list0.filter(c => showAll || c.status === 'open').sort((a, b) => order(a) - order(b) || String(a.createdAt).localeCompare(String(b.createdAt)));
    panelList.replaceChildren(...(list.length ? list.map(c => {
      const lost = c.kind !== 'general' && !placed.has(c.id);
      const quote = c.kind === 'figure' ? figLabel(c) : c.kind === 'general' ? '整篇' : clip(oneLine(c.quote || ''), 120);
      const del = h('button', { class: 'rv-link', type: 'button' }, '删除');
      del.addEventListener('click', () => confirmDelete(del, c));
      return h('article', { class: `rv-item rv-${c.status}` },
        h('div', { class: 'rv-item-meta' },
          h('span', { class: `rv-chip rv-chip-${c.status}` }, STATUS[c.status] || c.status),
          h('span', {}, c.section || ''),
          lost ? h('span', { class: 'rv-lost' }, '原文已变动') : null),
        h('button', { class: 'rv-item-quote', type: 'button', onclick: () => reveal(c) }, quote),
        h('p', { class: 'rv-item-note' }, c.note),
        c.reply ? h('p', { class: 'rv-item-reply' }, h('span', {}, 'Claude：'), c.reply) : null,
        c.status === 'open' ? h('div', { class: 'rv-item-actions' },
          h('button', { class: 'rv-link', type: 'button', onclick: () => { togglePanel(false); openComposer(null, c); } }, '修改'),
          del) : null);
    }) : [h('p', { class: 'rv-empty' }, showAll ? '还没有批注。选中文字或点一下段落即可开始。' : '没有待处理的批注。')]));
  };

  const togglePanel = on => {
    panel.hidden = !on;
    fab.hidden = on || !bar.hidden || !view;
    if (on) renderPost();
  };
  fab.addEventListener('click', () => togglePanel(true));
  filterOpen.addEventListener('click', () => { showAll = false; renderPost(); });
  filterAll.addEventListener('click', () => { showAll = true; renderPost(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!sheet.hidden) closeComposer(); else togglePanel(false); } });

  // ---------- 首页：审阅稿列表 ----------
  const countsFor = slug => {
    const cs = comments.filter(c => c.slug === slug);
    return { open: cs.filter(c => c.status === 'open').length, handled: cs.filter(c => c.status !== 'open').length };
  };
  const card = p => {
    const n = countsFor(p.slug);
    const eyebrow = p.series ? `${p.series} · 第 ${p.seriesOrder} 篇` : '单篇';
    return h('a', { class: 'rv-card', href: `#${p.slug}` },
      h('span', { class: 'rv-card-eyebrow' }, eyebrow),
      h('span', { class: 'rv-card-title' }, p.title),
      h('span', { class: 'rv-card-meta' },
        h('span', {}, p.kind === 'draft' ? '草稿' : `已发布 ${fmtDate(p.date)}`),
        h('span', {}, `审阅稿更新于 ${fmtTime(p.builtAt)}`)),
      h('span', { class: 'rv-card-counts' },
        n.open ? h('span', { class: 'rv-chip rv-chip-open' }, `待处理 ${n.open}`) : null,
        n.handled ? h('span', { class: 'rv-chip rv-chip-done' }, `已处理 ${n.handled}`) : null,
        !n.open && !n.handled ? h('span', { class: 'rv-card-none' }, '还没有批注') : null));
  };
  const renderHome = () => {
    const drafts = posts.filter(p => p.kind === 'draft').sort((a, b) => String(b.builtAt).localeCompare(String(a.builtAt)));
    const published = posts.filter(p => p.kind !== 'draft').sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const openTotal = comments.filter(c => c.status === 'open' && posts.some(p => p.slug === c.slug)).length;
    const head = h('header', { class: 'page-header rv-home-head' },
      h('p', { class: 'eyebrow' }, '审阅台'),
      h('h1', {}, '审阅稿'),
      h('p', {}, dbState === 'none' ? '这个页面需要在 Claude App 或 claude.ai 里打开，才能看到审阅稿和批注。'
        : `${drafts.length} 篇草稿，${published.length} 篇已发布。${openTotal ? `共有 ${openTotal} 条批注待处理，` : ''}点进文章后选中文字或点一下段落即可批注；看完在线程里说“按批注改”。`));
    const section = (label, list, empty) => h('section', { class: 'rv-home-section' },
      h('h2', { class: 'rv-home-h2' }, label, h('span', {}, String(list.length))),
      list.length ? h('div', { class: 'rv-cards' }, list.map(card)) : h('p', { class: 'rv-empty' }, empty));
    main.replaceChildren(h('div', { class: 'rv-home' }, head,
      dbState === 'connecting' ? h('p', { class: 'rv-empty' }, '正在读取审阅稿……') : [
        section('草稿', drafts, '目前没有草稿。新草稿写好后，Claude 会把它加到这里。'),
        section('已发布', published, '还没有已发布文章的审阅稿。'),
      ]));
  };

  // ---------- 文章页 ----------
  let loadToken = 0;
  const openPost = async slug => {
    const token = ++loadToken;
    article = null; idx = null; view = slug;
    hideBar(); togglePanel(false);
    main.replaceChildren(h('p', { class: 'rv-empty rv-loading' }, '正在载入……'));
    let html;
    try {
      const res = await fetch(`posts/${encodeURIComponent(slug)}.html`);
      if (!res.ok) throw new Error(String(res.status));
      html = await res.text();
    } catch {
      if (token !== loadToken) return;
      main.replaceChildren(h('div', { class: 'rv-home' }, h('p', { class: 'rv-empty' }, '这篇的审阅稿文件不存在，可能还没上传。'), h('a', { class: 'text-link', href: '#' }, '← 回到审阅稿列表')));
      return;
    }
    if (token !== loadToken) return;
    main.innerHTML = html;
    article = main.querySelector('article');
    if (!article) return;
    const back = article.querySelector('.back-link');
    if (back) { back.textContent = '← 全部审阅稿'; back.setAttribute('href', '#'); back.removeAttribute('target'); }
    window.__renderMath?.(article);
    window.__enhance?.();
    article.querySelector('.post-header')?.prepend(h('div', { class: 'rv-intro', 'data-rv-ui': true },
      h('strong', {}, '审阅稿'),
      h('span', {}, '选中文字，或点一下段落、图、公式、代码块、表格，再点底部的“批注”。')));
    buildIndex();
    window.scrollTo(0, 0);
    fab.hidden = false;
    renderPost();
  };

  const route = () => {
    const slug = decodeURIComponent(location.hash.slice(1));
    if (slug && slug === view && article) return;
    if (slug) { openPost(slug); return; }
    view = null; article = null; idx = null;
    hideBar(); togglePanel(false); fab.hidden = true;
    if (supportsHL) CSS.highlights.delete('rv-open');
    renderHome();
  };
  window.addEventListener('hashchange', route);

  const refresh = () => { if (view) { if (article) renderPost(); } else renderHome(); };
  route();

  const connect = async () => {
    try { db = window.claude?.use ? await window.claude.use('db') : null; } catch { db = null; }
    if (!db) { dbState = 'none'; refresh(); if (view) say('只能阅读：批注需要在 claude.ai 或 Claude App 里打开这个页面。'); return; }
    dbState = 'ready';
    db.collection(POSTS).onSnapshot(snap => {
      posts = snap.docs.map(d => ({ slug: d.id, ...d.data() }));
      refresh();
    }, err => say(`读取文章列表失败（${err?.code || '未知原因'}）`));
    db.collection(COL).onSnapshot(snap => {
      comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      refresh();
    }, err => say(`读取批注失败（${err?.code || '未知原因'}）`));
  };
  connect();
})();
