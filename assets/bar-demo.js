/*
 * 数据写法：
 *   config:
 *     scale: 整根条代表的量；digits: 算出来的数保留几位小数；min_pct: 非零段的最小宽度（%）
 *     axis: [左端文字, 右端文字]；rest_label: cap 以内没分出去的部分；outside_label: cap 之外的部分
 *     bars: [{key, name}]；legend: [{color, style, text}]；rows: [{key, name, optional}]，同 kv-demo
 *   steps:
 *     - text: 这一步的说明
 *       bars:
 *         <key>: {cap, segs: [[名字, 数值, 颜色, 样式]], mark: [位置, 文字], note, bad, name, dim}
 *       <row key>: [条目, "名字@颜色"] 或字符串
 * 某一步没写的条沿用上一步。颜色是 A～E、S、R、G，样式 hatch 画斜线。
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
    const src = root.querySelector('.bar-demo-data');
    if (!src) return;
    let demo;
    try { demo = JSON.parse(src.textContent); } catch (e) { return; }
    const steps = demo.steps || [];
    const cfg = demo.config || {};
    if (!steps.length || !cfg.bars || !cfg.scale) return;
    const digits = cfg.digits || 0;
    const fmt = (v) => (Number.isInteger(v) && !digits ? String(v) : String(+v.toFixed(digits)));

    const states = [];
    steps.forEach((s, i) => {
      const prevState = i ? states[i - 1] : {};
      const st = {};
      cfg.bars.forEach((b) => { st[b.key] = (s.bars && s.bars[b.key]) || prevState[b.key] || { segs: [] }; });
      states.push(st);
    });

    const stage = el('div', 'kvd-stage');
    const barsBox = el('div', 'bd-bars');
    const views = cfg.bars.map((b) => {
      const block = el('div', 'bd-block');
      const head = el('div', 'bd-head');
      const name = el('span', 'bd-name', b.name);
      const note = el('span', 'bd-note');
      head.append(name, note);
      const track = el('div', 'bd-track');
      const marker = el('span', 'bd-marker');
      marker.setAttribute('aria-hidden', 'true');
      const markText = el('div', 'bd-mark-row');
      const markLabel = el('span', 'bd-mark-text');
      markText.appendChild(markLabel);
      const sum = el('div', 'bd-sum');
      block.append(head, track, markText, sum);
      barsBox.appendChild(block);
      return { b, block, name, note, track, marker, markText, markLabel, sum, segs: new Map() };
    });
    let axis = null;
    if (cfg.axis) {
      axis = el('div', 'bd-axis');
      axis.append(el('span', '', cfg.axis[0]), el('span', '', cfg.axis[1]));
    }

    const legend = el('div', 'kvd-legend');
    (cfg.legend || []).forEach((item) => {
      const i = el('span', 'kvd-legend-item');
      const sw = el('span', `bd-swatch${item.style ? ' bd-' + item.style : ''}`);
      if (item.color) sw.dataset.c = item.color;
      i.appendChild(sw);
      i.appendChild(document.createTextNode(item.text));
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

    stage.append(barsBox);
    if (axis) stage.append(axis);
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

    function layout(bar) {
      const scale = cfg.scale;
      const cap = bar.cap != null ? bar.cap : scale;
      const segs = (bar.segs || []).map(([label, value, color, style]) => ({
        key: label, label, value, color, style,
        pct: value > 0 ? Math.max(value / scale * 100, cfg.min_pct || 0) : 0,
      }));
      const used = segs.reduce((a, s) => a + s.value, 0);
      const rest = Math.max(0, cap - used);
      if (rest > 1e-9) segs.push({ key: '__rest', label: cfg.rest_label || '未分配', value: rest, rest: true, pct: rest / scale * 100 });
      if (cap < scale) segs.push({ key: '__out', label: cfg.outside_label || '不在范围内', value: scale - cap, color: 'G', style: 'hatch', out: true, pct: (scale - cap) / scale * 100 });
      const total = segs.reduce((a, s) => a + s.pct, 0);
      if (total > 100) segs.forEach((s) => { s.pct = s.pct * 100 / total; });
      return segs;
    }

    // 段太窄时只写数字，再放不下就不写，数字在条下方都有。
    function fit(v) {
      const width = v.track.clientWidth;
      (v.last || []).forEach((x) => {
        const node = v.segs.get(x.key);
        node.style.flexBasis = `${x.pct}%`;
        const t = node.firstChild;
        const room = x.pct / 100 * width - 4;
        t.textContent = `${x.label} ${fmt(x.value)}`;
        if (t.scrollWidth > room) t.textContent = fmt(x.value);
        t.style.visibility = t.scrollWidth > room ? 'hidden' : '';
      });
    }

    function render(idx) {
      const s = steps[idx];
      const st = states[idx];
      const before = idx > 0 ? states[idx - 1] : null;
      views.forEach((v) => {
        const bar = st[v.b.key];
        const old = before ? before[v.b.key] : null;
        const oldVals = new Map();
        if (old) layout(old).forEach((x) => oldVals.set(x.key, x.value));
        v.name.textContent = bar.name || v.b.name;
        v.note.textContent = bar.note || '';
        v.note.className = `bd-note${bar.bad ? ' bd-bad' : bar.note ? ' bd-ok' : ''}`;
        v.block.classList.toggle('bd-dim', !!bar.dim);
        const segs = layout(bar);
        const keep = new Set();
        segs.forEach((x) => {
          keep.add(x.key);
          let node = v.segs.get(x.key);
          if (!node) {
            node = el('span', 'bd-seg');
            node.appendChild(el('span', 'bd-seg-text'));
            node.style.flexBasis = '0%';
            v.segs.set(x.key, node);
          }
          node.className = `bd-seg${x.rest ? ' bd-rest' : ''}${x.style ? ' bd-' + x.style : ''}`;
          if (x.color) node.dataset.c = x.color; else delete node.dataset.c;
          const label = `${x.label} ${fmt(x.value)}`;
          node.firstChild.textContent = label;
          node.title = label;
          v.track.appendChild(node);
          const changed = before && (!oldVals.has(x.key) || Math.abs(oldVals.get(x.key) - x.value) > 1e-9);
          if (changed && !x.rest && !x.out) {
            if (reduce) node.classList.add('kvd-changed-static');
            else { node.classList.remove('bd-pop'); void node.offsetWidth; node.classList.add('bd-pop'); }
          }
        });
        [...v.segs.keys()].forEach((k) => {
          if (!keep.has(k)) { v.segs.get(k).remove(); v.segs.delete(k); }
        });
        v.last = segs;
        requestAnimationFrame(() => fit(v));
        if (bar.mark) {
          const pos = Math.min(100, Math.max(0, bar.mark[0] / cfg.scale * 100));
          v.marker.style.left = `${pos}%`;
          v.track.appendChild(v.marker);
          v.markLabel.textContent = bar.mark[1];
          v.markLabel.style.left = `${pos}%`;
          v.markLabel.classList.toggle('bd-left', pos > 50);
          v.markText.hidden = false;
        } else {
          if (v.marker.parentNode) v.marker.remove();
          v.markText.hidden = true;
        }
        v.sum.textContent = '';
        segs.forEach((x) => {
          const item = el('span', 'bd-sum-item');
          const dot = el('span', `bd-swatch${x.rest ? ' bd-rest' : ''}${x.style ? ' bd-' + x.style : ''}`);
          if (x.color) dot.dataset.c = x.color;
          item.append(dot, document.createTextNode(`${x.label} ${fmt(x.value)}${cfg.unit ? ' ' + cfg.unit : ''}`));
          v.sum.appendChild(item);
        });
        v.track.setAttribute('role', 'img');
        v.track.setAttribute('aria-label', `${bar.name || v.b.name}：${segs.map((x) => `${x.label} ${fmt(x.value)}${cfg.unit ? ' ' + cfg.unit : ''}`).join('，')}${bar.note ? '。' + bar.note : ''}`);
      });
      rows.forEach(({ spec, r, box }) => {
        const val = s[spec.key];
        if (spec.optional && val == null) { r.hidden = true; return; }
        r.hidden = false;
        chips(box, val);
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
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => views.forEach(fit), 150);
    });
  }

  const run = () => document.querySelectorAll('.bar-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
