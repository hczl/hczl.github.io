/*
 * 按行列排的 token 格子分步演示。数据写法：
 *   config:
 *     grids: [{key: img, label: 标题, columns: 4, mobile_columns: 4, aria_name: 小图}]
 *     legend: [{color: A, text: 说明}] 或 {ring: true} / {dim: true} / {pick: true}
 *     rows: [{key, name, optional}]，同 kv-demo
 *   steps:
 *     - text: 这一步的说明
 *       <grid key>: [格子, ...]
 *       grid_labels: {<grid key>: 这一步的标题}
 *       <row key>: ["名字@颜色", ...] 或字符串
 * 格子写成 "[标记]标签[@颜色][:小字][|细条长度 0～1]"，"." 是空格子。
 * 标记：* 圈出（正在看的 query），- 变淡，! 加粗边框（这一步选中）。颜色是 A～E、S、R、G。
 * 外框、按钮和颜色来自 kv-demo.css。
 */
(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const split = (s) => {
    const at = s.lastIndexOf('@');
    return at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [s, ''];
  };

  const parse = (raw) => {
    let s = String(raw);
    if (s === '.') return { empty: true, label: '', mark: '', flags: '' };
    let flags = '';
    while (s && '*-!'.includes(s[0])) { flags += s[0]; s = s.slice(1); }
    let w = null;
    const bar = s.lastIndexOf('|');
    if (bar >= 0) { w = Math.max(0, Math.min(1, parseFloat(s.slice(bar + 1)) || 0)); s = s.slice(0, bar); }
    const colon = s.indexOf(':');
    const mark = colon < 0 ? '' : s.slice(colon + 1);
    const [label, color] = split(colon < 0 ? s : s.slice(0, colon));
    return { empty: false, label, color, mark, w, flags };
  };

  const chips = (box, items) => {
    box.textContent = '';
    if (typeof items === 'string') { box.appendChild(el('span', 'kvd-val', items)); return; }
    if (!items || !items.length) { box.appendChild(el('span', 'kvd-none', '无')); return; }
    items.forEach((raw) => {
      const [name, color] = split(String(raw));
      const c = el('span', 'kvd-chip', name);
      if (color) c.dataset.req = color;
      box.appendChild(c);
    });
  };

  function init(root) {
    if (root.classList.contains('kvd-ready')) return;
    const src = root.querySelector('.attn-demo-data');
    if (!src) return;
    let demo;
    try { demo = JSON.parse(src.textContent); } catch (e) { return; }
    const steps = demo.steps || [];
    const cfg = demo.config || {};
    const specs = cfg.grids || [];
    if (!steps.length || !specs.length || specs.some((g) => !Array.isArray(steps[0][g.key]))) return;

    const stage = el('div', 'kvd-stage');
    const grids = specs.map((spec) => {
      const n = steps[0][spec.key].length;
      const label = el('div', 'kvd-label', spec.label || '');
      const grid = el('div', 'atd-grid');
      const cols = spec.columns || n;
      grid.style.setProperty('--atd-n', cols);
      grid.style.setProperty('--atd-nm', spec.mobile_columns || Math.min(cols, 4));
      const cells = [];
      for (let i = 0; i < n; i++) {
        const c = el('div', 'atd-cell');
        c.append(el('span', 'atd-tag'), el('span', 'atd-mark'), el('span', 'atd-w'));
        c.setAttribute('role', 'img');
        grid.appendChild(c);
        cells.push(c);
      }
      stage.append(label, grid);
      return { spec, label, cells };
    });

    const legend = el('div', 'kvd-legend');
    (cfg.legend || []).forEach((item) => {
      const i = el('span', 'kvd-legend-item');
      const sw = el('span', 'atd-swatch');
      if (item.color) sw.dataset.c = item.color;
      if (item.ring) sw.classList.add('atd-ring');
      if (item.dim) sw.classList.add('atd-dim');
      if (item.pick) sw.classList.add('atd-pick');
      i.append(sw, document.createTextNode(item.text));
      legend.appendChild(i);
    });

    const queues = el('div', 'kvd-queues');
    const rows = (cfg.rows || []).map((spec) => {
      const r = el('div', 'kvd-row');
      r.appendChild(el('span', 'kvd-row-name', spec.name));
      const box = el('span', 'kvd-row-items');
      r.appendChild(box);
      queues.appendChild(r);
      return { spec, r, box };
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

    stage.append(legend);
    if (rows.length) stage.append(queues);
    stage.append(text, controls);
    const fallback = root.querySelector('.kv-demo-fallback');
    if (fallback) fallback.hidden = true;
    root.insertBefore(stage, src);
    root.classList.add('kvd-ready');

    let cur = 0;
    let timer = null;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function render(idx) {
      const s = steps[idx];
      const labels = s.grid_labels || {};
      grids.forEach(({ spec, label, cells }) => {
        label.textContent = labels[spec.key] || spec.label || '';
        const before = idx > 0 ? steps[idx - 1][spec.key] : null;
        (s[spec.key] || []).forEach((raw, i) => {
          const c = cells[i];
          if (!c) return;
          const b = parse(raw);
          c.className = 'atd-cell';
          if (b.empty) c.classList.add('atd-empty');
          if (b.color) c.dataset.c = b.color; else delete c.dataset.c;
          if (b.flags.includes('*')) c.classList.add('atd-ring');
          if (b.flags.includes('-')) c.classList.add('atd-dim');
          if (b.flags.includes('!')) c.classList.add('atd-pick');
          c.querySelector('.atd-tag').textContent = b.label;
          c.querySelector('.atd-mark').textContent = b.mark;
          const w = c.querySelector('.atd-w');
          w.style.width = b.w == null ? '0' : `${(b.w * 100).toFixed(1)}%`;
          w.hidden = b.w == null;
          const changed = before && before[i] !== raw;
          if (changed && !reduce) {
            c.classList.remove('atd-pop');
            void c.offsetWidth;
            c.classList.add('atd-pop');
          } else if (changed) {
            c.classList.add('kvd-changed-static');
          }
          const parts = [`${spec.aria_name ? spec.aria_name + ' ' : ''}${b.label || '空'}`];
          if (b.mark) parts.push(b.mark);
          if (b.flags.includes('*')) parts.push('正在看的 query');
          if (b.flags.includes('!')) parts.push('选中');
          if (b.flags.includes('-')) parts.push('不参与');
          c.setAttribute('aria-label', parts.join('，'));
        });
      });
      rows.forEach(({ spec, r, box }) => {
        const v = s[spec.key];
        if (spec.optional && v == null) { r.hidden = true; return; }
        r.hidden = false;
        chips(box, v);
      });
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

  const run = () => document.querySelectorAll('.attn-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
