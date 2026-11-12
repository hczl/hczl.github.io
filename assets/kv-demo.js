(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const parse = (s) => {
    if (s === '.') return { kind: 'empty', label: '' };
    const cached = s.startsWith('~');
    const [label, mark] = (cached ? s.slice(1) : s).split(':');
    return { kind: cached ? 'cached' : 'used', label, req: label[0], mark: mark || '' };
  };

  const chips = (box, items) => {
    box.textContent = '';
    if (!items || !items.length) { box.appendChild(el('span', 'kvd-none', '空')); return; }
    items.forEach((name) => {
      const c = el('span', 'kvd-chip', name);
      if (name.length === 1) c.dataset.req = name;
      box.appendChild(c);
    });
  };

  function init(root) {
    const src = root.querySelector('.kv-demo-data');
    if (!src) return;
    let steps;
    try { steps = JSON.parse(src.textContent); } catch (e) { return; }
    if (!steps.length) return;
    const n = steps[0].blocks.length;

    const stage = el('div', 'kvd-stage');
    const gridLabel = el('div', 'kvd-label', `KV Cache（${n} 个 block）`);
    const grid = el('div', 'kvd-grid');
    grid.style.setProperty('--kvd-n', n);
    const cells = [];
    for (let i = 0; i < n; i++) {
      const c = el('div', 'kvd-cell');
      c.appendChild(el('span', 'kvd-tag'));
      c.appendChild(el('span', 'kvd-mark'));
      grid.appendChild(c);
      cells.push(c);
    }

    const queues = el('div', 'kvd-queues');
    const row = (name) => {
      const r = el('div', 'kvd-row');
      r.appendChild(el('span', 'kvd-row-name', name));
      const box = el('span', 'kvd-row-items');
      r.appendChild(box);
      queues.appendChild(r);
      return [r, box];
    };
    const [, runBox] = row('运行队列');
    const [, waitBox] = row('等待队列（左边是最前面）');
    const [freeRow, freeBox] = row('空闲队列（从左边取）');

    const legend = el('div', 'kvd-legend');
    [['used', '被请求占用'], ['cached', '空闲，还挂着哈希，可被命中'], ['empty', '空闲']].forEach(([k, t]) => {
      const i = el('span', 'kvd-legend-item');
      i.appendChild(el('span', `kvd-swatch kvd-${k}`));
      i.appendChild(document.createTextNode(t));
      legend.appendChild(i);
    });

    const text = el('p', 'kvd-text');
    text.setAttribute('aria-live', 'polite');

    const controls = el('div', 'kvd-controls');
    const prev = el('button', 'kvd-btn', '上一步');
    const counter = el('span', 'kvd-counter');
    const next = el('button', 'kvd-btn kvd-primary', '下一步');
    const play = el('button', 'kvd-btn', '自动播放');
    const reset = el('button', 'kvd-btn', '从头开始');
    const speeds = [1, 2, 0.5];
    let speedIdx = 0;
    const speed = el('button', 'kvd-btn kvd-speed', '速度 1×');
    speed.setAttribute('aria-label', '切换自动播放速度，当前 1×');
    [prev, next, play, reset, speed].forEach((b) => { b.type = 'button'; });
    controls.append(prev, counter, next, play, reset, speed);

    stage.append(gridLabel, grid, legend, queues, text, controls);
    const fallback = root.querySelector('.kv-demo-fallback');
    if (fallback) fallback.hidden = true;
    root.insertBefore(stage, src);
    root.classList.add('kvd-ready');

    let cur = 0;
    let timer = null;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function render(idx) {
      const s = steps[idx];
      const before = idx > 0 ? steps[idx - 1].blocks : null;
      s.blocks.forEach((raw, i) => {
        const b = parse(raw);
        const c = cells[i];
        c.className = `kvd-cell kvd-${b.kind}`;
        if (b.req) c.dataset.req = b.req; else delete c.dataset.req;
        c.querySelector('.kvd-tag').textContent = b.label;
        const mark = b.mark === 'hit' ? '命中' : b.mark === 're' ? '重算' : '';
        c.querySelector('.kvd-mark').textContent = mark;
        if (b.mark) c.classList.add(`kvd-${b.mark}`);
        const changed = before && before[i] !== raw;
        if (changed && !reduce) {
          c.classList.remove('kvd-changed');
          void c.offsetWidth;
          c.classList.add('kvd-changed');
        } else if (changed) {
          c.classList.add('kvd-changed-static');
        }
        const state = b.kind === 'empty' ? '空闲' : b.kind === 'cached' ? `空闲，可命中的 ${b.label}` : `${b.label}${mark ? '，' + mark : ''}`;
        c.setAttribute('aria-label', `block ${i}：${state}`);
      });
      chips(runBox, s.running);
      chips(waitBox, s.waiting);
      if (s.free) { freeRow.hidden = false; chips(freeBox, s.free); } else { freeRow.hidden = true; }
      text.textContent = s.text;
      counter.textContent = `${idx + 1} / ${steps.length}`;
      prev.disabled = idx === 0;
      next.disabled = idx === steps.length - 1;
    }

    const interval = () => 2000 / speeds[speedIdx];
    const tick = () => {
      if (cur >= steps.length - 1) { stop(); return; }
      go(cur + 1);
    };
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      play.textContent = '自动播放';
      play.setAttribute('aria-pressed', 'false');
    }
    function go(idx) { cur = Math.max(0, Math.min(steps.length - 1, idx)); render(cur); }

    prev.addEventListener('click', () => { stop(); go(cur - 1); });
    next.addEventListener('click', () => { stop(); go(cur + 1); });
    reset.addEventListener('click', () => { stop(); go(0); });
    play.addEventListener('click', () => {
      if (timer) { stop(); return; }
      if (cur === steps.length - 1) go(0);
      play.textContent = '暂停';
      play.setAttribute('aria-pressed', 'true');
      timer = setInterval(tick, interval());
    });
    speed.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      const v = speeds[speedIdx];
      speed.textContent = `速度 ${v}×`;
      speed.setAttribute('aria-label', `切换自动播放速度，当前 ${v}×`);
      root.style.setProperty('--kvd-dur', `${0.35 / v}s`);
      if (timer) { clearInterval(timer); timer = setInterval(tick, interval()); }
    });

    go(0);
  }

  const run = () => document.querySelectorAll('.kv-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
