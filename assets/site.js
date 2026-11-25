(() => {
  const root = document.documentElement;
  const button = document.querySelector('.theme-toggle');
  const media = matchMedia('(prefers-color-scheme: dark)');
  const stored = () => { try { return localStorage.getItem('theme'); } catch { return null; } };
  const apply = theme => {
    root.dataset.theme = theme;
    if (button) button.setAttribute('aria-pressed', String(theme === 'dark'));
  };
  apply(root.dataset.theme === 'dark' ? 'dark' : 'light');
  if (button) button.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    try { localStorage.setItem('theme', next); } catch {}
  });
  media.addEventListener('change', e => { if (!stored()) apply(e.matches ? 'dark' : 'light'); });
})();
(() => {
  const article = document.querySelector('.post-content');
  if (!article) return;
  const toc = document.querySelector('.toc');
  const headings = [...article.querySelectorAll('h2, h3')];
  if (headings.length && toc) {
    const list = document.createElement('ul');
    headings.forEach((heading, i) => {
      if (!heading.id) heading.id = `section-${i + 1}`;
      const li = document.createElement('li');
      li.className = heading.tagName === 'H3' ? 'subheading' : '';
      const link = document.createElement('a');
      link.href = '#' + encodeURIComponent(heading.id);
      link.textContent = heading.textContent;
      li.append(link); list.append(li);
    });
    toc.querySelector('nav').append(list);
    toc.hidden = false;
  }
  article.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    if (!code) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.before(wrap); wrap.append(pre);
    if (!navigator.clipboard || !window.isSecureContext) return;
    const button = document.createElement('button');
    button.className = 'copy-code'; button.type = 'button';
    button.textContent = '复制'; button.setAttribute('aria-label', '复制代码');
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code.textContent); button.textContent = '已复制'; }
      catch { button.textContent = '请手动选择复制'; }
      setTimeout(() => { button.textContent = '复制'; }, 1800);
    });
    wrap.append(button);
  });
  article.querySelectorAll('table').forEach(table => {
    const wrap = document.createElement('div'); wrap.className = 'table-wrap';
    table.before(wrap); wrap.append(table);
  });
})();
(() => {
  const article = document.querySelector('.post-content');
  if (!article) return;
  const images = [...article.querySelectorAll('img')].filter(img => {
    const link = img.closest('a');
    return !link || link.href === img.currentSrc || link.href === img.src;
  });
  if (!images.length || typeof HTMLDialogElement !== 'function') return;
  const dialog = document.createElement('dialog');
  dialog.className = 'lightbox';
  dialog.setAttribute('aria-label', '图片预览');
  dialog.innerHTML = '<button class="lightbox-close" type="button" aria-label="关闭预览">×</button><figure><img alt=""><figcaption></figcaption></figure>';
  document.body.append(dialog);
  const view = dialog.querySelector('img');
  const caption = dialog.querySelector('figcaption');
  const open = img => {
    const src = img.currentSrc || img.src;
    const svg = /\.svg(\?|#|$)/i.test(src);
    view.src = src; view.alt = img.alt;
    dialog.classList.toggle('is-svg', svg);
    const w = img.naturalWidth, h = img.naturalHeight;
    view.style.setProperty('--ratio', w && h ? w / h : 1.6);
    view.style.maxWidth = svg || !w ? '' : w + 'px';
    const figcaption = img.closest('figure')?.querySelector('figcaption');
    caption.innerHTML = figcaption ? figcaption.innerHTML : '';
    caption.hidden = !figcaption;
    document.documentElement.classList.add('lightbox-open');
    dialog.showModal();
  };
  dialog.addEventListener('click', e => { if (!e.target.closest('figcaption a')) dialog.close(); });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('lightbox-open');
    view.removeAttribute('src');
  });
  images.forEach(img => {
    img.classList.add('zoomable');
    const link = img.closest('a');
    if (link) link.setAttribute('aria-label', '放大查看：' + img.alt);
    (link || img).addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
      e.preventDefault(); open(img);
    });
  });
})();
(() => {
  const article = document.querySelector('.post-content');
  if (!article) return;

  const SKIP_EQ_SELECTOR = '[data-no-eq-num], figure, .kv-demo, .bar-demo, .fwd-demo, .attn-demo, .linalg-demo, .la-demo, .ref-popover';
  const pageCache = new Map();

  const isEqAutoLabel = text => /^(?:式|\[式\]|公式)$/.test(text.trim());

  const isBlankText = node => node.nodeType === 3 && !node.textContent.trim();

  const isBareWrapperSpan = el =>
    el && el.tagName === 'SPAN' && !el.id && !el.className && el.attributes.length === 0;

  const onlyContainsChild = (parent, child) =>
    parent && [...parent.childNodes].every(n => n === child || isBlankText(n));

  const numberDisplayMath = root => {
    const map = new Map();
    let count = 0;
    root.querySelectorAll('.katex-display').forEach(display => {
      if (display.closest(SKIP_EQ_SELECTOR)) return;
      count += 1;
      const num = String(count);
      const wrapSpan = isBareWrapperSpan(display.parentElement) && onlyContainsChild(display.parentElement, display)
        ? display.parentElement
        : null;
      const mathNode = wrapSpan || display;
      const parent = mathNode.parentElement;
      const singleChildDiv = parent && parent.tagName === 'DIV' && parent !== root && onlyContainsChild(parent, mathNode);
      let row;
      if (singleChildDiv) {
        row = parent;
        if (!row.id) row.id = `eq-${num}`;
        row.classList.add('eq-row');
      } else {
        row = document.createElement('div');
        row.className = 'eq-row';
        row.id = `eq-${num}`;
        mathNode.before(row);
      }
      row.dataset.eqNum = num;
      let body = row.querySelector(':scope > .eq-body');
      if (!body) {
        body = document.createElement('div');
        body.className = 'eq-body';
        row.append(body);
      }
      body.append(display);
      if (wrapSpan) wrapSpan.remove();
      if (!row.querySelector(':scope > .eq-num')) {
        const tag = document.createElement('span');
        tag.className = 'eq-num';
        tag.setAttribute('aria-hidden', 'true');
        tag.textContent = `[${num}]`;
        row.append(tag);
      }
      map.set(row.id, { num, el: row });
    });
    return map;
  };

  const numberRawMathInDoc = doc => {
    const content = doc.querySelector('.post-content');
    const map = new Map();
    if (!content) return map;
    let count = 0;
    const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const matches = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest('pre, code, script, style, ' + SKIP_EQ_SELECTOR)) continue;
      const parts = node.nodeValue.match(/\\\[[\s\S]*?\\\]/g);
      if (!parts) continue;
      parts.forEach(() => {
        count += 1;
        const host = parent.tagName === 'DIV' && parent !== content && parent.id ? parent : null;
        if (host && !map.has(host.id)) map.set(host.id, String(count));
        else matches.push({ num: String(count), parent });
      });
    }
    return map;
  };

  const sanitizeClone = (node, remoteEqNums) => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, iframe, object, embed, .copy-code').forEach(el => el.remove());
    if (clone.removeAttribute) clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    clone.querySelectorAll('a.ref-link').forEach(a => a.classList.remove('is-active'));
    if (remoteEqNums) {
      clone.querySelectorAll('a[href^="#eq-"]').forEach(a => {
        const id = decodeURIComponent(a.getAttribute('href').slice(1));
        if (remoteEqNums.has(id) && isEqAutoLabel(a.textContent)) {
          a.textContent = `[${remoteEqNums.get(id)}]式`;
        }
      });
    }
    return clone;
  };

  const firstSentenceClone = (p, remoteEqNums) => {
    const clone = sanitizeClone(p, remoteEqNums);
    if (clone.textContent.trim().length <= 95) return clone;
    const out = document.createElement('p');
    let done = false;
    for (const child of [...clone.childNodes]) {
      if (done) break;
      if (child.nodeType === 3) {
        const idx = child.nodeValue.indexOf('。');
        if (idx !== -1) {
          out.append(document.createTextNode(child.nodeValue.slice(0, idx + 1)));
          done = true;
          break;
        }
      }
      out.append(child);
    }
    return out;
  };

  const findEqLeadParagraph = eqEl => {
    let prev = eqEl.previousElementSibling;
    let skippedEq = 0;
    while (prev) {
      if (prev.tagName === 'P') return prev;
      const isSiblingEq = (prev.classList && prev.classList.contains('eq-row')) ||
        (prev.tagName === 'DIV' && prev.id && prev.id.startsWith('eq-'));
      if (isSiblingEq && skippedEq < 1) {
        skippedEq += 1;
        prev = prev.previousElementSibling;
        continue;
      }
      break;
    }
    return null;
  };

  const findEqTailParagraph = eqEl => {
    const next = eqEl.nextElementSibling;
    if (!next || next.tagName !== 'P') return null;
    const text = next.textContent.trim();
    if (/^(?:其中|这里|就称|称为|即|由此|这说明|这个式子|\[?\d+\]?式|式\s)/.test(text)) {
      return next;
    }
    return null;
  };

  const buildPreviewFromTarget = (target, docTitle, remoteEqNum, remoteEqNums) => {
    const frag = document.createDocumentFragment();
    let label = '正文引用';
    const isEqRow = target.classList && target.classList.contains('eq-row');
    const isRemoteEq = !isEqRow && target.id && target.id.startsWith('eq-');

    if (isEqRow || isRemoteEq) {
      const num = isEqRow ? target.dataset.eqNum : remoteEqNum;
      label = num ? `[${num}]式` : '公式';

      const lead = findEqLeadParagraph(target);
      if (lead) {
        const ctx = sanitizeClone(lead, remoteEqNums);
        ctx.classList.add('ref-pop-ctx');
        frag.append(ctx);
      }

      const eqBox = document.createElement('div');
      eqBox.className = 'ref-pop-eq-box';
      if (isEqRow) {
        const body = target.querySelector(':scope > .eq-body');
        eqBox.append(sanitizeClone(body || target, remoteEqNums));
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'eq-body';
        wrap.append(sanitizeClone(target, remoteEqNums));
        eqBox.append(wrap);
      }
      if (num) {
        const tag = document.createElement('span');
        tag.className = 'eq-num';
        tag.setAttribute('aria-hidden', 'true');
        tag.textContent = `[${num}]`;
        eqBox.append(tag);
      }
      frag.append(eqBox);

      const tail = findEqTailParagraph(target);
      if (tail) {
        const ctx = firstSentenceClone(tail, remoteEqNums);
        ctx.classList.add('ref-pop-ctx', 'ref-pop-ctx-tail');
        frag.append(ctx);
      }
    } else if (target.tagName === 'SPAN') {
      const block = target.closest('p, li, blockquote, dd');
      if (block) {
        const clone = block.cloneNode(true);
        const marked = target.id ? clone.querySelector('#' + CSS.escape(target.id)) : null;
        if (marked) marked.classList.add('ref-excerpt-mark');
        frag.append(sanitizeClone(clone, remoteEqNums));
      } else {
        const p = document.createElement('p');
        p.append(sanitizeClone(target, remoteEqNums));
        frag.append(p);
      }
    } else if (/^H[2-4]$/.test(target.tagName)) {
      label = target.textContent.trim();
      let sib = target.nextElementSibling;
      let added = 0;
      while (sib && added < 2 && !/^H[1-4]$/.test(sib.tagName)) {
        if (!sib.matches(SKIP_EQ_SELECTOR)) {
          frag.append(sanitizeClone(sib, remoteEqNums));
          added += 1;
        }
        sib = sib.nextElementSibling;
      }
      if (!added) {
        const p = document.createElement('p');
        p.textContent = label;
        frag.append(p);
      }
    } else if (target.tagName === 'LI') {
      const box = document.createElement('div');
      box.className = 'ref-li-excerpt';
      [...target.childNodes].forEach(ch => {
        if (ch.nodeType === 1) box.append(sanitizeClone(ch, remoteEqNums));
        else if (ch.nodeType === 3) box.append(document.createTextNode(ch.nodeValue));
      });
      frag.append(box);
    } else {
      frag.append(sanitizeClone(target, remoteEqNums));
    }

    const title = docTitle ? `${docTitle} · ${label}` : label;
    return { title, frag };
  };

  const fetchPage = async path => {
    if (pageCache.has(path)) return pageCache.get(path);
    const promise = fetch(path, { credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const h1 = doc.querySelector('.post-header h1, h1');
        const title = h1 ? h1.textContent.trim() : '';
        const eqNums = numberRawMathInDoc(doc);
        return { doc, title, eqNums };
      });
    pageCache.set(path, promise);
    try {
      return await promise;
    } catch (err) {
      pageCache.delete(path);
      throw err;
    }
  };

  const flashTarget = el => {
    if (!el) return;
    el.classList.remove('ref-flash');
    void el.offsetWidth;
    el.classList.add('ref-flash');
    setTimeout(() => el.classList.remove('ref-flash'), 1900);
  };

  const initRefs = () => {
    const eqMap = numberDisplayMath(article);

    const resolveLink = a => {
      const rawHref = a.getAttribute('href');
      if (!rawHref || a.closest('.toc, figure, ' + SKIP_EQ_SELECTOR)) return null;
      let url;
      try { url = new URL(a.href, location.href); } catch { return null; }
      if (url.origin !== location.origin || !url.hash || url.hash === '#') return null;
      const hashId = decodeURIComponent(url.hash.slice(1));
      const samePage = url.pathname === location.pathname && url.search === location.search;
      if (samePage) {
        const target = document.getElementById(hashId);
        if (!target || !article.contains(target)) return null;
        return { samePage: true, hashId, target, path: url.pathname };
      }
      if (hashId.startsWith('eq-') || hashId.startsWith('ref-') || a.classList.contains('ref')) {
        return { samePage: false, hashId, target: null, path: url.pathname + url.search };
      }
      return null;
    };

    const refLinks = [];
    article.querySelectorAll('a[href]').forEach(a => {
      const info = resolveLink(a);
      if (!info) return;
      a.classList.add('ref-link');
      if (info.samePage && eqMap.has(info.hashId)) {
        const { num } = eqMap.get(info.hashId);
        a.classList.add('ref-eq');
        if (isEqAutoLabel(a.textContent)) a.textContent = `[${num}]式`;
      } else if (!info.samePage && info.hashId.startsWith('eq-')) {
        a.classList.add('ref-eq');
      }
      refLinks.push({ a, info });
    });

    if (location.hash && location.hash.length > 1) {
      const initial = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (initial && article.contains(initial)) {
        requestAnimationFrame(() => flashTarget(initial));
      }
    }

    if (!refLinks.length) return;

    const pop = document.createElement('div');
    pop.className = 'ref-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '引用预览');
    pop.hidden = true;
    pop.innerHTML =
      '<div class="ref-pop-head">' +
        '<span class="ref-pop-title"></span>' +
        '<div class="ref-pop-actions">' +
          '<a class="ref-pop-jump" href="#">定位原文 ↗</a>' +
          '<button class="ref-pop-close" type="button" aria-label="关闭预览">×</button>' +
        '</div>' +
      '</div>' +
      '<div class="ref-pop-body prose"></div>';
    document.body.append(pop);

    const titleEl = pop.querySelector('.ref-pop-title');
    const jumpEl = pop.querySelector('.ref-pop-jump');
    const closeBtn = pop.querySelector('.ref-pop-close');
    const bodyEl = pop.querySelector('.ref-pop-body');

    let activeLink = null;
    let activeInfo = null;
    let pinned = false;
    let openTimer = 0;
    let closeTimer = 0;
    let renderSeq = 0;

    const clearTimers = () => {
      clearTimeout(openTimer); openTimer = 0;
      clearTimeout(closeTimer); closeTimer = 0;
    };

    const positionPopover = anchor => {
      if (!anchor || pop.hidden) return;
      const rect = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.innerHeight;
      const margin = 12;
      const gap = 10;
      const popRect = pop.getBoundingClientRect();
      const w = popRect.width;
      const h = popRect.height;

      let left = rect.left + rect.width / 2 - w / 2;
      left = Math.max(margin, Math.min(left, vw - w - margin));

      const spaceAbove = rect.top - margin - gap;
      const spaceBelow = vh - rect.bottom - margin - gap;
      let top;
      if (spaceAbove >= h || (spaceAbove > spaceBelow && spaceBelow < h)) {
        top = Math.max(margin, rect.top - h - gap);
      } else {
        top = Math.min(vh - h - margin, rect.bottom + gap);
      }
      pop.style.left = Math.round(left) + 'px';
      pop.style.top = Math.round(Math.max(margin, top)) + 'px';
    };

    const close = (restoreFocus = false) => {
      clearTimers();
      if (activeLink) activeLink.classList.remove('is-active');
      const prev = activeLink;
      activeLink = null;
      activeInfo = null;
      pinned = false;
      pop.hidden = true;
      if (restoreFocus && prev) prev.focus({ preventScroll: true });
    };

    const scheduleClose = () => {
      if (pinned) return;
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => close(false), 180);
    };

    const show = async (a, info, pin = false) => {
      clearTimers();
      const seq = ++renderSeq;
      if (activeLink && activeLink !== a) activeLink.classList.remove('is-active');
      activeLink = a;
      activeInfo = info;
      pinned = pin;
      a.classList.add('is-active');

      jumpEl.href = a.href;
      jumpEl.textContent = info.samePage ? '定位原文 ↗' : '打开原文 ↗';

      if (info.samePage) {
        const { title, frag } = buildPreviewFromTarget(info.target, '', null);
        titleEl.textContent = title;
        bodyEl.replaceChildren(frag);
        pop.hidden = false;
        positionPopover(a);
        return;
      }

      titleEl.textContent = '加载引用…';
      bodyEl.innerHTML = '<p class="ref-pop-loading">正在读取引用内容…</p>';
      pop.hidden = false;
      positionPopover(a);

      try {
        const { doc, title, eqNums } = await fetchPage(info.path);
        if (seq !== renderSeq) return;
        const target = doc.getElementById(info.hashId);
        if (!target) {
          titleEl.textContent = title || '未找到锚点';
          bodyEl.innerHTML = '<p class="ref-pop-loading">未在目标文章中找到对应片段，可点击右上角打开原文查看。</p>';
          positionPopover(a);
          return;
        }
        const remoteEqNum = eqNums.get(info.hashId) || null;
        const preview = buildPreviewFromTarget(target, title, remoteEqNum, eqNums);
        titleEl.textContent = preview.title;
        bodyEl.replaceChildren(preview.frag);
        if (window.__renderMath) window.__renderMath(bodyEl);
        positionPopover(a);
      } catch {
        if (seq !== renderSeq) return;
        titleEl.textContent = '读取失败';
        bodyEl.innerHTML = '<p class="ref-pop-loading">暂时无法加载引用片段，可点击右上角打开原文。</p>';
        positionPopover(a);
      }
    };

    pop.addEventListener('pointerenter', e => {
      if (e.pointerType === 'mouse') clearTimers();
    });
    pop.addEventListener('pointerleave', e => {
      if (e.pointerType === 'mouse') scheduleClose();
    });
    closeBtn.addEventListener('click', () => close(true));

    jumpEl.addEventListener('click', e => {
      if (!activeInfo || !activeInfo.samePage) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      const target = activeInfo.target;
      close(false);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashTarget(target);
      }
    });

    document.addEventListener('click', e => {
      if (pop.hidden) return;
      if (pop.contains(e.target) || (activeLink && activeLink.contains(e.target))) return;
      close(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !pop.hidden) close(true);
    });
    window.addEventListener('resize', () => { if (!pop.hidden) positionPopover(activeLink); });
    window.addEventListener('scroll', () => {
      if (pop.hidden || !activeLink) return;
      const r = activeLink.getBoundingClientRect();
      if (r.bottom < -40 || r.top > window.innerHeight + 40) { close(false); return; }
      positionPopover(activeLink);
    }, { passive: true });

    refLinks.forEach(({ a, info }) => {
      a.addEventListener('pointerenter', e => {
        if (e.pointerType !== 'mouse') return;
        if (pinned && activeLink && activeLink !== a) return;
        clearTimers();
        if (activeLink === a && !pop.hidden) return;
        openTimer = setTimeout(() => show(a, info, false), 90);
      });
      a.addEventListener('pointerleave', e => {
        if (e.pointerType !== 'mouse') return;
        clearTimeout(openTimer); openTimer = 0;
        scheduleClose();
      });
      a.addEventListener('click', e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
        e.preventDefault();
        if (pinned && activeLink === a && !pop.hidden) close(false);
        else show(a, info, true);
      });
    });
  };

  const hasMath = Boolean(document.querySelector('script[src*="katex"]'));
  if (!hasMath || document.documentElement.dataset.mathReady === '1') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRefs, { once: true });
    else initRefs();
  } else {
    document.addEventListener('blog:math-ready', initRefs, { once: true });
  }
})();
