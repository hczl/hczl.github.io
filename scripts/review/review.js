// 审阅页的批注层：选中文字或点一下段落、图、公式、代码块、表格即可批注。
// 批注存在 Artifact 的 db 里（集合 comments），Claude 用 ArtifactData 读取并回写处理结果。
(() => {
  const meta = JSON.parse(document.getElementById('review-meta').textContent);
  const article = document.querySelector('main article');
  if (!article) return;
  const prose = article.querySelector('.post-content');

  // ---------- 正文文本索引：把可批注的文字拼成一条字符串，偏移量用于定位 ----------
  const SKIP = '.katex-mathml,script,style,[data-rv-ui],.copy-code,.series-box,.toc,.series-pager,.post-end,.back-link,.post-meta';
  let idx = null;
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
  buildIndex();

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

  const headings = () => [...article.querySelectorAll('.post-content h2, .post-content h3')];
  const sectionOf = node => {
    let label = '开头';
    for (const h of headings()) {
      if (h === node || h.contains(node) || (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) label = h.textContent.trim();
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
      kind: 'text',
      label,
      quote: quote.slice(0, QUOTE_MAX),
      prefix: idx.text.slice(Math.max(0, s - 40), s),
      suffix: idx.text.slice(e, e + 40),
      tex: texIn(range),
      section: sectionOf(node),
      start: s,
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
  const figureInfo = el => {
    const img = el.querySelector('img');
    return {
      kind: 'figure',
      label: '这张图',
      file: img?.dataset.file || '',
      alt: img?.getAttribute('alt') || '',
      caption: el.querySelector('figcaption')?.textContent.trim() || '',
      section: sectionOf(el),
      start: elementOffsets(el)[0],
    };
  };
  const snapshotFromBlock = b => {
    if (b.type === 'figure') return figureInfo(b.el);
    const [s, e] = elementOffsets(b.el);
    const r = document.createRange(); r.selectNodeContents(b.el);
    const snap = snapshotFromOffsets(s, e, b.el, r, b.label);
    if (snap) snap.block = b.type;
    return snap;
  };
  const snapshotFromSelection = () => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!article.contains(r.commonAncestorContainer)) return null;
    const s = pointToOffset(r.startContainer, r.startOffset);
    const e = pointToOffset(r.endContainer, r.endOffset);
    if (e <= s) return null;
    const snap = snapshotFromOffsets(s, e, r.startContainer, r, `选中的 ${[...idx.text.slice(s, e).trim()].length} 字`);
    return snap;
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
    if (best < 0) return null;
    return { start: best, end: best + c.quote.length };
  };

  // ---------- 界面 ----------
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
  const figLabel = c => (c.caption && c.caption.startsWith('图') ? c.caption : `图：${c.caption || c.alt || c.file}`);
  const oneLine = s => s.replace(/\s+/g, ' ').trim();

  const intro = h('div', { class: 'rv-intro', 'data-rv-ui': true },
    h('strong', {}, '审阅稿'),
    h('span', {}, '选中文字，或点一下段落、图、公式、代码块、表格，再点底部的“批注”。批注会一起交给 Claude 修改。'));
  article.querySelector('.post-header')?.prepend(intro);

  const fab = h('button', { class: 'rv-fab', type: 'button', 'data-rv-ui': true, 'aria-label': '查看批注' }, '批注');
  const bar = h('div', { class: 'rv-bar', 'data-rv-ui': true, hidden: true });
  const barLabel = h('span', { class: 'rv-bar-label' });
  const barGo = h('button', { class: 'rv-btn rv-primary', type: 'button', id: 'rv-bar-go' }, '批注');
  const barX = h('button', { class: 'rv-btn rv-ghost', type: 'button', 'aria-label': '取消' }, '取消');
  bar.append(barLabel, h('div', { class: 'rv-bar-actions' }, barX, barGo));

  const sheet = h('div', { class: 'rv-sheet', 'data-rv-ui': true, hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rv-sheet-title' });
  const sheetTitle = h('div', { class: 'rv-sheet-title', id: 'rv-sheet-title' });
  const sheetQuote = h('blockquote', { class: 'rv-quote' });
  const note = h('textarea', { id: 'rv-note', class: 'rv-note', rows: '4', maxlength: '2000', placeholder: '写下意见：哪里不对、怎么改、或者一个疑问' });
  const sheetSave = h('button', { class: 'rv-btn rv-primary', type: 'button', id: 'rv-save' }, '保存');
  const sheetCancel = h('button', { class: 'rv-btn rv-ghost', type: 'button', id: 'rv-cancel' }, '取消');
  sheet.append(h('div', { class: 'rv-sheet-inner' }, sheetTitle, sheetQuote, note, h('div', { class: 'rv-sheet-actions' }, sheetCancel, sheetSave)));

  const panel = h('aside', { class: 'rv-panel', 'data-rv-ui': true, hidden: true, 'aria-label': '批注列表' });
  const panelList = h('div', { class: 'rv-list' });
  const panelCount = h('span', { class: 'rv-panel-count' });
  const filterOpen = h('button', { class: 'rv-tab', type: 'button', 'aria-pressed': 'true' }, '待处理');
  const filterAll = h('button', { class: 'rv-tab', type: 'button', 'aria-pressed': 'false' }, '全部');
  panel.append(h('div', { class: 'rv-panel-inner' },
    h('div', { class: 'rv-panel-head' },
      h('div', { class: 'rv-panel-title' }, h('strong', {}, '批注'), panelCount),
      h('div', { class: 'rv-panel-tools' }, filterOpen, filterAll,
        h('button', { class: 'rv-btn rv-ghost', type: 'button', onclick: () => openComposer({ kind: 'general', label: '整篇', section: '整篇' }) }, '整体意见'),
        h('button', { class: 'rv-btn rv-ghost', type: 'button', 'aria-label': '关闭批注列表', onclick: () => togglePanel(false) }, '关闭'))),
    panelList));

  const toast = h('div', { class: 'rv-toast', 'data-rv-ui': true, role: 'status', hidden: true });
  document.body.append(fab, bar, sheet, panel, toast);

  let toastTimer;
  const say = msg => { toast.textContent = msg; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 3200); };

  // ---------- 选中与点选 ----------
  let pending = null;   // 底部栏对应的批注目标
  let picked = null;    // 点选高亮的块
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
  const hideBar = () => { bar.hidden = true; fab.hidden = false; pending = null; setPicked(null); };

  document.addEventListener('selectionchange', () => {
    if (!sheet.hidden) return;
    const snap = snapshotFromSelection();
    if (snap) { setPicked(null); showBar(snap); return; }
    if (pending && !picked) { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!getSelection().toString()) hideBar(); }, 600); }
  });
  article.addEventListener('click', e => {
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

  // ---------- 存储 ----------
  let db = null;
  let comments = [];
  let editing = null;
  let showAll = false;
  const COL = 'comments';

  const openComposer = (snap, existing = null) => {
    editing = existing;
    const target = existing || snap;
    sheetTitle.textContent = existing ? '修改批注' : target.kind === 'general' ? '整体意见' : `批注 · ${target.section || ''}`;
    const q = target.kind === 'figure'
      ? figLabel(target)
      : target.kind === 'general' ? '针对整篇文章' : clip(oneLine(target.quote || ''), 160);
    sheetQuote.textContent = q;
    note.value = existing ? existing.note : '';
    sheet.dataset.snap = '';
    sheet._snap = snap;
    sheet.hidden = false;
    bar.hidden = true;
    fab.hidden = true;
    setTimeout(() => note.focus(), 50);
  };
  const closeComposer = () => {
    sheet.hidden = true; editing = null; sheet._snap = null;
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
        const s = sheet._snap;
        const doc = { slug: meta.slug, round: meta.sourceHash, status: 'open', note: text, createdAt: now, updatedAt: now, kind: s.kind, section: s.section || '' };
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

  // ---------- 高亮与列表 ----------
  const supportsHL = !!(window.CSS && CSS.highlights && window.Highlight);
  let placed = new Map();
  const STATUS = { open: '待处理', done: '已修改', kept: '未改' };

  const paint = () => {
    article.querySelectorAll('.rv-flag').forEach(el => el.classList.remove('rv-flag'));
    placed = new Map();
    const ranges = [];
    for (const c of comments) {
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
    const target = r.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center', behavior: smooth });
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
  const render = () => {
    paint();
    const open = comments.filter(c => c.status === 'open').length;
    fab.textContent = open ? `批注 ${open}` : '批注';
    panelCount.textContent = `待处理 ${open} · 共 ${comments.length}`;
    filterOpen.setAttribute('aria-pressed', String(!showAll));
    filterAll.setAttribute('aria-pressed', String(showAll));
    const list = comments.filter(c => showAll || c.status === 'open').sort((a, b) => order(a) - order(b) || a.createdAt.localeCompare(b.createdAt));
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
    fab.hidden = on || !bar.hidden;
    if (on) render();
  };
  fab.addEventListener('click', () => togglePanel(true));
  filterOpen.addEventListener('click', () => { showAll = false; render(); });
  filterAll.addEventListener('click', () => { showAll = true; render(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!sheet.hidden) closeComposer(); else togglePanel(false); } });

  render();

  const connect = async () => {
    try { db = window.claude?.use ? await window.claude.use('db') : null; } catch { db = null; }
    if (!db) { say('只能阅读：批注需要在 claude.ai 或 Claude App 里打开这个页面。'); return; }
    db.collection(COL).onSnapshot(snap => {
      comments = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.slug || c.slug === meta.slug);
      render();
    }, err => say(`读取批注失败（${err?.code || '未知原因'}）`));
  };
  connect();
})();
