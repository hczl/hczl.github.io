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
