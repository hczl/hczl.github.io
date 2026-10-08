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
