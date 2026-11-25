/*
 * 3Blue1Brown 风格的线性变换、点积投影与奇异值分解分步连续几何动画。
 * 所有步骤切换均采用连续状态插值（无硬切跳帧）：
 *   mode: "basis2d"   — 二维基向量线性组合、列落点、面积行列式、逆矩阵还原、外积降维与矩阵复合
 *   mode: "dotproj2d" — 三种范数等距圈、点积余弦夹角、正交半平面、直线正交投影与外积投影矩阵
 *   mode: "eigen2d"   — 切换矩阵时先平滑还原至恒等网格、旋转探测向量并淡入新特征线，再连续施加新线性变换
 *   mode: "svd3d"     — 三维单位球经 V^T -> Sigma -> U -> 秩 1 截断全流程连续形变，视角、网格与辅助线平滑过渡
 */
(() => {
  const S2 = Math.SQRT2;
  const INV_S2 = 1 / S2;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const easeInOut = (x) => {
    const t = clamp(x, 0, 1);
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => {
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * t;
  };
  const fmt = (v) => {
    const z = Math.abs(v) < 0.005 ? 0 : v;
    return z.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  };

  function drawArrow2D(ctx, x0, y0, x1, y1, color, width = 2.4, head = 9, dashed = false, alpha = 1) {
    if (alpha <= 0.01) return;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1.2) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    if (dashed) ctx.setLineDash([5, 4]);
    const trim = Math.min(head * 0.72, len * 0.45);
    const ux = dx / len;
    const uy = dy / len;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 - ux * trim, y1 - uy * trim);
    ctx.stroke();
    ctx.setLineDash([]);
    const h = Math.min(head, len * 0.65);
    const w = h * 0.48;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - ux * h - uy * w, y1 - uy * h + ux * w);
    ctx.lineTo(x1 - ux * h + uy * w, y1 - uy * h - ux * w);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawSpanLine(ctx, cx, cy, vx, vy, radiusPx, color, alpha = 0.45) {
    if (alpha <= 0.01) return;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return;
    const ux = (vx / len) * radiusPx;
    const uy = (-vy / len) * radiusPx;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha *= alpha;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(cx - ux, cy - uy);
    ctx.lineTo(cx + ux, cy + uy);
    ctx.stroke();
    ctx.restore();
  }

  function drawPillLabel(ctx, x, y, text, color, align = 'left', alpha = 1) {
    if (alpha <= 0.01 || !text) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.font = '600 12.5px ui-monospace, SFMono-Regular, Menlo, Consolas, "PingFang SC", sans-serif';
    const padX = 6;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 20;
    const rx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    const ry = y - h / 2;
    ctx.fillStyle = 'rgba(13, 19, 33, 0.82)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(rx, ry, w, h, 4);
    else ctx.rect(rx, ry, w, h);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, rx + padX, y + 0.5);
    ctx.restore();
  }

  const evalStepMat2D = (mat, rot90, prog) => {
    if (rot90) {
      const a = prog * (Math.PI / 2);
      const c = Math.cos(a);
      const s = Math.sin(a);
      return [c, -s, s, c];
    }
    return [
      1 + prog * (mat[0] - 1),
      prog * mat[1],
      prog * mat[2],
      1 + prog * (mat[3] - 1),
    ];
  };

  // --- Mode 1: 2D Linear Transformation & Eigenvectors (seamless multi-beat choreography) ---
  function createEigen2D(canvas, badge, scrubInput, scrubVal, cfg, steps, onManual, onUserCustomize) {
    let activeStep = steps[0];
    let p = activeStep.t != null ? activeStep.t : 0;
    let dispMat = evalStepMat2D(activeStep.mat || [2, 1, 1, 2], !!activeStep.rot90, p);
    let probeRad = ((activeStep.probe_deg || 0) * Math.PI) / 180;
    let userMovedProbe = false;
    let decompProg = activeStep.decompose ? 1 : 0;
    // Outgoing & incoming eigen overlays for smooth cross-fade when switching matrices
    let prevEigens = [];
    let prevEigenAlpha = 0;
    let curEigens = activeStep.eigens || [];
    let curEigenAlpha = 1;
    let svdPair = activeStep.svd_axes || null;
    let svdAlpha = svdPair ? 1 : 0;
    let curMatName = activeStep.mat_label || 'A';
    let animId = null;

    function paint() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth || 640;
      const H = canvas.clientHeight || 360;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.52;
      const scale = Math.min(W, H) / 7.4;
      const toScreen = (x, y) => [cx + x * scale, cy - y * scale];
      const M = dispMat;
      const applyM = (x, y) => [M[0] * x + M[1] * y, M[2] * x + M[3] * y];

      // 1. Background fixed reference grid
      ctx.save();
      ctx.lineWidth = 1;
      for (let k = -8; k <= 8; k++) {
        ctx.strokeStyle = k === 0 ? 'rgba(148, 163, 184, 0.28)' : 'rgba(148, 163, 184, 0.09)';
        const [x0, y0] = toScreen(k, -8);
        const [x1, y1] = toScreen(k, 8);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const [hx0, hy0] = toScreen(-8, k);
        const [hx1, hy1] = toScreen(8, k);
        ctx.beginPath(); ctx.moveTo(hx0, hy0); ctx.lineTo(hx1, hy1); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(cx, cy, scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 2. Live deforming cyan coordinate grid
      ctx.save();
      for (let k = -6; k <= 6; k++) {
        const major = k === 0;
        ctx.strokeStyle = major ? 'rgba(56, 189, 248, 0.62)' : 'rgba(34, 211, 238, 0.24)';
        ctx.lineWidth = major ? 1.5 : 1.05;
        let [ax, ay] = applyM(k, -6);
        let [bx, by] = applyM(k, 6);
        let [sx0, sy0] = toScreen(ax, ay);
        let [sx1, sy1] = toScreen(bx, by);
        ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();

        [ax, ay] = applyM(-6, k);
        [bx, by] = applyM(6, k);
        [sx0, sy0] = toScreen(ax, ay);
        [sx1, sy1] = toScreen(bx, by);
        ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
      }
      ctx.restore();

      // 3. Transformed unit circle -> ellipse
      ctx.save();
      ctx.beginPath();
      const segs = 96;
      for (let i = 0; i <= segs; i++) {
        const th = (i / segs) * Math.PI * 2;
        const [tx, ty] = applyM(Math.cos(th), Math.sin(th));
        const [px, py] = toScreen(tx, ty);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.72)';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.restore();

      const maxR = Math.hypot(W, H);

      // 4. Outgoing & current eigenvector span lines + arrows (smoothly cross-faded)
      const renderEigenSet = (list, alpha) => {
        if (alpha <= 0.01) return;
        list.forEach(([vx, vy, , label, color]) => {
          drawSpanLine(ctx, cx, cy, vx, vy, maxR, color, 0.55 * alpha);
          const [ex, ey] = applyM(vx, vy);
          const [epx, epy] = toScreen(ex, ey);
          drawArrow2D(ctx, cx, cy, epx, epy, color, 2.7, 9.5, false, alpha);
          const off = 14;
          const norm = Math.hypot(ex, ey) || 1;
          drawPillLabel(ctx, epx + (ex / norm) * off, epy - (ey / norm) * off, label, color, ex >= 0 ? 'left' : 'right', alpha);
        });
      };
      renderEigenSet(prevEigens, prevEigenAlpha);
      renderEigenSet(curEigens, curEigenAlpha);

      // 4b. Optional orthogonal SVD input->output pair with right-angle marker (bridge to SVD)
      if (svdPair && svdAlpha > 0.01 && svdPair.length === 2) {
        const [a1, a2] = svdPair;
        const [u1x, u1y] = applyM(a1[0], a1[1]);
        const [u2x, u2y] = applyM(a2[0], a2[1]);
        const n1 = Math.hypot(u1x, u1y) || 1;
        const n2 = Math.hypot(u2x, u2y) || 1;
        // Right-angle marker at origin if vectors remain nearly orthogonal
        const cos12 = Math.abs((u1x * u2x + u1y * u2y) / (n1 * n2));
        if (cos12 < 0.12) {
          const r = 0.24;
          const e1x = (u1x / n1) * r, e1y = (u1y / n1) * r;
          const e2x = (u2x / n2) * r, e2y = (u2y / n2) * r;
          const pA = toScreen(e1x, e1y);
          const pB = toScreen(e1x + e2x, e1y + e2y);
          const pC = toScreen(e2x, e2y);
          ctx.save();
          ctx.globalAlpha = 0.85 * svdAlpha;
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(pA[0], pA[1]);
          ctx.lineTo(pB[0], pB[1]);
          ctx.lineTo(pC[0], pC[1]);
          ctx.stroke();
          ctx.restore();
        }
        [a1, a2].forEach(([vx, vy, lbl, col]) => {
          const [tx, ty] = applyM(vx, vy);
          const [spx, spy] = toScreen(tx, ty);
          drawArrow2D(ctx, cx, cy, spx, spy, col, 2.8, 9.5, false, svdAlpha);
          const nm = Math.hypot(tx, ty) || 1;
          drawPillLabel(ctx, spx + (tx / nm) * 14, spy - (ty / nm) * 14, lbl, col, tx >= 0 ? 'left' : 'right', svdAlpha);
        });
      }

      // 5. Progressive orthogonal parallelogram decomposition (Manim GrowArrow + ShowCreation)
      const px0 = Math.cos(probeRad);
      const py0 = Math.sin(probeRad);
      const [outX, outY] = applyM(px0, py0);
      if (decompProg > 0.01) {
        const arrowGrow = smoothstep(0, 0.58, decompProg);
        const dashGrow = smoothstep(0.42, 1.0, decompProg);
        const q1x = INV_S2, q1y = INV_S2;
        const q2x = INV_S2, q2y = -INV_S2;
        const c1 = px0 * q1x + py0 * q1y;
        const c2 = px0 * q2x + py0 * q2y;
        const [v1x, v1y] = applyM(c1 * q1x, c1 * q1y);
        const [v2x, v2y] = applyM(c2 * q2x, c2 * q2y);
        const [s1x, s1y] = toScreen(v1x * arrowGrow, v1y * arrowGrow);
        const [s2x, s2y] = toScreen(v2x * arrowGrow, v2y * arrowGrow);
        const [f1x, f1y] = toScreen(v1x, v1y);
        const [f2x, f2y] = toScreen(v2x, v2y);
        const [sox, soy] = toScreen(outX, outY);

        drawArrow2D(ctx, cx, cy, s1x, s1y, '#93c5fd', 2.2, 8, false, arrowGrow);
        drawArrow2D(ctx, cx, cy, s2x, s2y, '#6ee7b7', 2.2, 8, false, arrowGrow);

        if (dashGrow > 0.01) {
          ctx.save();
          ctx.globalAlpha = dashGrow;
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = '#60a5fa';
          ctx.beginPath();
          ctx.moveTo(f2x, f2y);
          ctx.lineTo(lerp(f2x, sox, dashGrow), lerp(f2y, soy, dashGrow));
          ctx.stroke();
          ctx.strokeStyle = '#34d399';
          ctx.beginPath();
          ctx.moveTo(f1x, f1y);
          ctx.lineTo(lerp(f1x, sox, dashGrow), lerp(f1y, soy, dashGrow));
          ctx.stroke();
          ctx.restore();
        }
      }

      // 6. Draggable gold probe vector x, its original span line, and M(t)x
      drawSpanLine(ctx, cx, cy, px0, py0, maxR, '#fbbf24', 0.65);
      const [ix, iy] = toScreen(px0, py0);
      const distFromI = Math.hypot(M[0] - 1, M[1], M[2], M[3] - 1);
      if (distFromI > 0.04) {
        drawArrow2D(ctx, cx, cy, ix, iy, 'rgba(251, 191, 36, 0.55)', 1.8, 7, true);
      }
      const [ox, oy] = toScreen(outX, outY);
      drawArrow2D(ctx, cx, cy, ox, oy, '#fbbf24', 3.0, 10.5);

      ctx.save();
      ctx.beginPath();
      ctx.arc(ix, iy, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0d1321';
      ctx.stroke();
      if (distFromI > 0.12 && Math.hypot(ox - ix, oy - iy) > 22) {
        ctx.font = '600 11.5px ui-monospace, SFMono-Regular, Menlo, sans-serif';
        ctx.fillStyle = 'rgba(253, 230, 138, 0.85)';
        ctx.fillText('x', ix + (px0 >= 0 ? 8 : -15), iy + (py0 >= 0 ? -7 : 14));
      }
      ctx.restore();

      drawPillLabel(ctx, ox + (outX >= 0 ? 10 : -10), oy - (outY >= 0 ? 12 : -12),
        distFromI < 0.04 ? `x = [${fmt(px0)}, ${fmt(py0)}]ᵀ` : `${curMatName}x = [${fmt(outX)}, ${fmt(outY)}]ᵀ`,
        '#fde68a', outX >= 0 ? 'left' : 'right');

      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();

      // HUD badge
      const cross = Math.abs(px0 * outY - py0 * outX);
      const dot = px0 * outX + py0 * outY;
      const onSpan = distFromI > 0.12 && cross < 0.035;
      badge.classList.toggle('m3b-hit', onSpan);
      if (distFromI <= 0.04) {
        badge.textContent = `恒等网格 I | 探测向量 x = [${fmt(px0)}, ${fmt(py0)}]ᵀ`;
      } else if (onSpan) {
        badge.textContent = `落在特征直线上：${curMatName}x = ${fmt(dot)}x（方向未偏转）`;
      } else {
        badge.textContent = `x = [${fmt(px0)}, ${fmt(py0)}]ᵀ → ${curMatName}x = [${fmt(outX)}, ${fmt(outY)}]ᵀ（偏离原直线）`;
      }
      scrubInput.value = String(Math.round(p * 100));
      scrubVal.textContent = `t = ${p.toFixed(2)}`;
    }

    function animateTo(targetStep, speedMul, reduceMotion, onDone) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }

      const prevMatSpec = activeStep.mat || [2, 1, 1, 2];
      const nextMatSpec = targetStep.mat || [2, 1, 1, 2];
      const sameMat = nextMatSpec.every((v, i) => Math.abs(v - prevMatSpec[i]) < 1e-6)
        && !!targetStep.rot90 === !!activeStep.rot90;

      const startDispMat = dispMat.slice();
      const startP = p;
      const startProbe = probeRad;
      const targetProbe = (!userMovedProbe && targetStep.probe_deg != null)
        ? (targetStep.probe_deg * Math.PI) / 180
        : probeRad;
      const startDecomp = decompProg;
      const targetDecomp = targetStep.decompose ? 1 : 0;
      const startSvdAlpha = svdAlpha;
      const nextSvdPair = targetStep.svd_axes || null;
      const targetT = targetStep.t != null ? targetStep.t : 1;

      if (reduceMotion) {
        activeStep = targetStep;
        p = targetT;
        dispMat = evalStepMat2D(nextMatSpec, !!targetStep.rot90, p);
        probeRad = targetProbe;
        decompProg = targetDecomp;
        svdPair = nextSvdPair;
        svdAlpha = nextSvdPair ? 1 : 0;
        prevEigens = [];
        prevEigenAlpha = 0;
        curEigens = targetStep.eigens || [];
        curEigenAlpha = 1;
        curMatName = targetStep.mat_label || 'A';
        paint();
        if (onDone) onDone();
        return;
      }

      if (sameMat) {
        // Smooth transition on the SAME matrix (e.g. Step 1 -> Step 2 I->A, or Step 2 -> Step 3 growing decomposition)
        activeStep = targetStep;
        if (nextSvdPair) svdPair = nextSvdPair;
        prevEigens = [];
        prevEigenAlpha = 0;
        curEigens = targetStep.eigens || [];
        curEigenAlpha = 1;
        curMatName = targetStep.mat_label || 'A';

        const dur = (Math.abs(targetT - startP) < 0.05 ? 780 : 1050) / speedMul;
        const t0 = performance.now();
        const frame = (now) => {
          const u = clamp((now - t0) / dur, 0, 1);
          const e = easeInOut(u);
          p = lerp(startP, targetT, e);
          dispMat = evalStepMat2D(nextMatSpec, !!targetStep.rot90, p);
          probeRad = lerpAngle(startProbe, targetProbe, e);
          decompProg = lerp(startDecomp, targetDecomp, u);
          svdAlpha = lerp(startSvdAlpha, nextSvdPair ? 1 : 0, e);
          paint();
          if (u < 1) animId = requestAnimationFrame(frame);
          else {
            if (!nextSvdPair) svdPair = null;
            animId = null;
            if (onDone) onDone();
          }
        };
        animId = requestAnimationFrame(frame);
        return;
      }

      // Different matrix (e.g. A -> B, B -> J, J -> R):
      // Choreographed 3-beat Manim transition with ZERO hard cut:
      //   Beat 1 [0.00..0.36]: smoothly unwind current dispMat -> I, fade out old decomp & old eigens, rotate probe x
      //   Beat 2 [0.30..0.48]: cross-fade in new eigen-directions on the clean identity grid
      //   Beat 3 [0.44..1.00]: smoothly deform I -> target matrix
      prevEigens = curEigens;
      prevEigenAlpha = curEigenAlpha;
      curEigens = targetStep.eigens || [];
      curEigenAlpha = 0;
      const outgoingSvdPair = svdPair;
      activeStep = targetStep;

      const wasIdentity = Math.hypot(startDispMat[0] - 1, startDispMat[1], startDispMat[2], startDispMat[3] - 1) < 0.04;
      const dur = (wasIdentity ? 1050 : 1650) / speedMul;
      const t0 = performance.now();
      const frame = (now) => {
        const u = clamp((now - t0) / dur, 0, 1);
        if (wasIdentity) {
          const e = easeInOut(u);
          prevEigenAlpha = 1 - smoothstep(0, 0.35, u);
          curEigenAlpha = smoothstep(0.1, 0.45, u);
          if (nextSvdPair) { svdPair = nextSvdPair; svdAlpha = smoothstep(0.1, 0.45, u); }
          else { svdPair = outgoingSvdPair; svdAlpha = startSvdAlpha * (1 - smoothstep(0, 0.3, u)); }
          curMatName = targetStep.mat_label || 'A';
          probeRad = lerpAngle(startProbe, targetProbe, smoothstep(0, 0.45, u));
          decompProg = lerp(startDecomp, targetDecomp, u);
          p = lerp(0, targetT, e);
          dispMat = evalStepMat2D(nextMatSpec, !!targetStep.rot90, p);
        } else {
          const unwind = easeInOut(clamp(u / 0.36, 0, 1));
          const apply = easeInOut(clamp((u - 0.44) / 0.56, 0, 1));
          prevEigenAlpha = 1 - smoothstep(0.05, 0.34, u);
          curEigenAlpha = smoothstep(0.30, 0.48, u);
          if (u < 0.34) {
            svdPair = outgoingSvdPair;
            svdAlpha = startSvdAlpha * (1 - smoothstep(0.02, 0.32, u));
          } else {
            svdPair = nextSvdPair;
            svdAlpha = nextSvdPair ? smoothstep(0.32, 0.48, u) : 0;
          }
          decompProg = startDecomp * (1 - smoothstep(0, 0.28, u)) + targetDecomp * smoothstep(0.75, 1.0, u);
          probeRad = lerpAngle(startProbe, targetProbe, easeInOut(clamp(u / 0.44, 0, 1)));
          if (u < 0.44) {
            curMatName = u < 0.34 ? curMatName : (targetStep.mat_label || 'A');
            p = startP * (1 - unwind);
            dispMat = [
              lerp(startDispMat[0], 1, unwind),
              lerp(startDispMat[1], 0, unwind),
              lerp(startDispMat[2], 0, unwind),
              lerp(startDispMat[3], 1, unwind),
            ];
          } else {
            curMatName = targetStep.mat_label || 'A';
            p = targetT * apply;
            dispMat = evalStepMat2D(nextMatSpec, !!targetStep.rot90, p);
          }
        }
        paint();
        if (u < 1) animId = requestAnimationFrame(frame);
        else {
          prevEigens = [];
          prevEigenAlpha = 0;
          curEigenAlpha = 1;
          svdPair = nextSvdPair;
          svdAlpha = nextSvdPair ? 1 : 0;
          animId = null;
          if (onDone) onDone();
        }
      };
      animId = requestAnimationFrame(frame);
    }

    let dragging = false;
    const updateProbeFromEvent = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width * 0.5;
      const y = -(e.clientY - rect.top - rect.height * 0.52);
      if (Math.hypot(x, y) < 6) return;
      let ang = Math.atan2(y, x);
      for (const [vx, vy] of curEigens) {
        for (const sgn of [1, -1]) {
          const ea = Math.atan2(sgn * vy, sgn * vx);
          const diff = Math.atan2(Math.sin(ang - ea), Math.cos(ang - ea));
          if (Math.abs(diff) < 0.055) { ang = ea; break; }
        }
      }
      probeRad = ang;
      paint();
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      userMovedProbe = true;
      if (onUserCustomize) onUserCustomize(true);
      canvas.setPointerCapture(e.pointerId);
      onManual();
      updateProbeFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) updateProbeFromEvent(e); });
    const endDrag = () => { dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    scrubInput.addEventListener('input', () => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      onManual();
      p = parseFloat(scrubInput.value) / 100;
      prevEigens = [];
      prevEigenAlpha = 0;
      curEigenAlpha = 1;
      curMatName = activeStep.mat_label || 'A';
      dispMat = evalStepMat2D(activeStep.mat || [2, 1, 1, 2], !!activeStep.rot90, p);
      paint();
    });

    return {
      paint,
      animateTo,
      resetCustom: () => {
        userMovedProbe = false;
        probeRad = ((activeStep.probe_deg || 0) * Math.PI) / 180;
        paint();
      },
      stopAnim: () => { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  // --- Mode 2: 3D-to-2D Continuous SVD Pipeline (M = U Sigma V^T) ---
  function createSVD3D(canvas, badge, scrubInput, scrubVal, cfg, steps, onManual, onStepSync, onUserCustomize) {
    const v1 = [INV_S2, INV_S2, 0];
    const v2 = [1 / (3 * S2), -1 / (3 * S2), 4 / (3 * S2)];
    const v3 = [2 / 3, -2 / 3, -1 / 3];
    const VT = [v1, v2, v3];
    const tr = VT[0][0] + VT[1][1] + VT[2][2];
    const phi = Math.acos(clamp((tr - 1) / 2, -1, 1));
    const denom = 2 * Math.sin(phi);
    const axis = [
      (VT[2][1] - VT[1][2]) / denom,
      (VT[0][2] - VT[2][0]) / denom,
      (VT[1][0] - VT[0][1]) / denom,
    ];

    const rodrigues = (s) => {
      const th = phi * s;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const t = 1 - c;
      const [kx, ky, kz] = axis;
      return [
        [c + kx * kx * t, kx * ky * t - kz * sn, kx * kz * t + ky * sn],
        [ky * kx * t + kz * sn, c + ky * ky * t, ky * kz * t - kx * sn],
        [kz * kx * t - ky * sn, kz * ky * t + kx * sn, c + kz * kz * t],
      ];
    };

    const mul3 = (A, B) => {
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
        }
      }
      return C;
    };
    const apply3 = (A, p) => [
      A[0][0] * p[0] + A[0][1] * p[1] + A[0][2] * p[2],
      A[1][0] * p[0] + A[1][1] * p[1] + A[1][2] * p[2],
      A[2][0] * p[0] + A[2][1] * p[1] + A[2][2] * p[2],
    ];

    const rings = [];
    for (const lat of [-60, -30, 0, 30, 60]) {
      const r = Math.cos((lat * Math.PI) / 180);
      const z = Math.sin((lat * Math.PI) / 180);
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push([r * Math.cos(a), r * Math.sin(a), z]);
      }
      rings.push({ pts, major: lat === 0 });
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const a = (lon * Math.PI) / 180;
      const pts = [];
      for (let i = 0; i <= 64; i++) {
        const b = (i / 64) * Math.PI * 2;
        pts.push([Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)]);
      }
      rings.push({ pts, major: lon === 0 || lon === 90 });
    }

    let tau = steps[0].tau || 0;
    let userYawOffset = 0;
    let userPitchOffset = 0;
    let animId = null;

    function matrixAt(t) {
      if (t <= 1) return rodrigues(clamp(t, 0, 1));
      if (t <= 2) {
        const s = t - 1;
        const D = [[1 + 4 * s, 0, 0], [0, 1 + 2 * s, 0], [0, 0, 1 - s]];
        return mul3(D, VT);
      }
      if (t <= 3) {
        const s = t - 2;
        const u00 = 1 + s * (INV_S2 - 1);
        const u01 = s * INV_S2;
        const u10 = s * INV_S2;
        const u11 = 1 + s * (-INV_S2 - 1);
        const U2 = [[u00, u01, 0], [u10, u11, 0], [0, 0, 0]];
        const SigVT = mul3([[5, 0, 0], [0, 3, 0], [0, 0, 0]], VT);
        return mul3(U2, SigVT);
      }
      const s = clamp(t - 3, 0, 1);
      const Ufull = [[INV_S2, INV_S2, 0], [INV_S2, -INV_S2, 0], [0, 0, 0]];
      const SigTrunc = [[5, 0, 0], [0, 3 * (1 - s), 0], [0, 0, 0]];
      return mul3(Ufull, mul3(SigTrunc, VT));
    }

    function paint() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth || 640;
      const H = canvas.clientHeight || 360;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.53;
      // Smooth C1 zoom and camera glide from 3D oblique view to clearer 2D plane view
      const grow = smoothstep(0.75, 2.0, tau);
      const flatBlend = smoothstep(1.2, 2.8, tau);
      const scale = Math.min(W, H) / (3.1 + 6.9 * grow);
      const yaw = lerp(-0.62, -0.22, flatBlend) + userYawOffset;
      const pitch = clamp(lerp(0.48, 0.88, flatBlend) + userPitchOffset, 0.12, 1.45);

      const cyaw = Math.cos(yaw), syaw = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const project = (p3) => {
        const x1 = p3[0] * cyaw - p3[1] * syaw;
        const y1 = p3[0] * syaw + p3[1] * cyaw;
        const z1 = p3[2];
        const sx = x1;
        const sy = y1 * sp + z1 * cp;
        const depth = y1 * cp - z1 * sp;
        return [cx + sx * scale, cy - sy * scale, depth];
      };

      // 1. Continuous z=0 plane grid (no sudden jump from 2 to 5)
      const outerAlpha = smoothstep(0.6, 1.7, tau);
      const gridExtent = lerp(2.2, 5.0, outerAlpha);
      ctx.save();
      for (let k = -5; k <= 5; k++) {
        if (Math.abs(k) > gridExtent + 0.01) continue;
        const edgeFade = Math.abs(k) <= 2 ? 1 : outerAlpha;
        const baseA = k === 0 ? 0.34 : 0.12;
        ctx.strokeStyle = `rgba(148, 163, 184, ${(baseA * edgeFade).toFixed(3)})`;
        ctx.lineWidth = k === 0 ? 1.3 : 0.9;
        let a = project([k, -gridExtent, 0]);
        let b = project([k, gridExtent, 0]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        a = project([-gridExtent, k, 0]);
        b = project([gridExtent, k, 0]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      const zAlpha = 1 - 0.65 * smoothstep(1.6, 2.3, tau);
      const zBot = project([0, 0, -1.6]);
      const zTop = project([0, 0, 1.6]);
      ctx.strokeStyle = `rgba(148, 163, 184, ${(0.26 * zAlpha).toFixed(3)})`;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(zBot[0], zBot[1]); ctx.lineTo(zTop[0], zTop[1]); ctx.stroke();
      ctx.restore();

      const T = matrixAt(tau);

      // 2. Smoothly faded ghost ellipse & progressive error arrow during rank-1 truncation (tau in 3..4)
      if (tau > 3.005) {
        const truncProg = clamp(tau - 3, 0, 1);
        const ghostAlpha = smoothstep(0.02, 0.45, truncProg);
        const Tfull = matrixAt(3);
        ctx.save();
        ctx.strokeStyle = `rgba(148, 163, 184, ${(0.48 * ghostAlpha).toFixed(3)})`;
        ctx.lineWidth = 1.45;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2;
          const pIn = [
            v1[0] * Math.cos(a) + v2[0] * Math.sin(a),
            v1[1] * Math.cos(a) + v2[1] * Math.sin(a),
            v1[2] * Math.cos(a) + v2[2] * Math.sin(a),
          ];
          const [px, py] = project(apply3(Tfull, pIn));
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();

        const org = project([0, 0, 0]);
        const errTip = project([3 * INV_S2 * truncProg, -3 * INV_S2 * truncProg, 0]);
        drawArrow2D(ctx, org[0], org[1], errTip[0], errTip[1], '#fbbf24', 2.3, 8.5, true, ghostAlpha);
        const fullTip = project([3 * INV_S2, -3 * INV_S2, 0]);
        drawPillLabel(ctx, fullTip[0] + 8, fullTip[1] + 8, '丢弃项 3u₂（误差 σ₂ = 3）', '#fde68a', 'left', smoothstep(0.35, 0.85, truncProg));
      }

      // 3. Transformed wireframe sphere / ellipsoid / flat ellipse / rank-1 segment
      ctx.save();
      rings.forEach(({ pts, major }) => {
        ctx.strokeStyle = major ? 'rgba(56, 189, 248, 0.56)' : 'rgba(34, 211, 238, 0.22)';
        ctx.lineWidth = major ? 1.5 : 1.0;
        ctx.beginPath();
        pts.forEach((pt, idx) => {
          const [px, py] = project(apply3(T, pt));
          if (idx === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
      ctx.restore();

      // 4. Singular triad vectors with smooth fade-out as singular values collapse to 0
      const org = project([0, 0, 0]);
      const tv1 = apply3(T, v1);
      const tv2 = apply3(T, v2);
      const tv3 = apply3(T, v3);
      const len1 = Math.hypot(tv1[0], tv1[1], tv1[2]);
      const len2 = Math.hypot(tv2[0], tv2[1], tv2[2]);
      const len3 = Math.hypot(tv3[0], tv3[1], tv3[2]);

      const alpha3 = clamp(len3 / 0.28, 0, 1);
      if (alpha3 > 0.01) {
        const p3 = project(tv3);
        drawArrow2D(ctx, org[0], org[1], p3[0], p3[1], '#f87171', 2.4, 8.5, false, alpha3);
        const lbl3 = tau < 0.85 ? 'v₃（零空间）' : `σ₃ = ${fmt(len3)}`;
        drawPillLabel(ctx, p3[0] + 6, p3[1] - 10, lbl3, '#fca5a5', 'left', alpha3);
      }

      const alpha2 = clamp(len2 / 0.65, 0, 1);
      if (alpha2 > 0.01) {
        const p2 = project(tv2);
        drawArrow2D(ctx, org[0], org[1], p2[0], p2[1], '#34d399', 2.7, 9.5, false, alpha2);
        const lbl2 = tau < 0.85 ? 'v₂' : tau < 1.85 ? `${fmt(len2)}e₂` : `${fmt(len2)}u₂`;
        drawPillLabel(ctx, p2[0] + 8, p2[1] + 10, lbl2, '#6ee7b7', 'left', alpha2);
      }

      const p1 = project(tv1);
      drawArrow2D(ctx, org[0], org[1], p1[0], p1[1], '#60a5fa', 2.9, 10);
      const lbl1 = tau < 0.85 ? 'v₁' : tau < 1.85 ? `${fmt(len1)}e₁` : `${fmt(len1)}u₁`;
      drawPillLabel(ctx, p1[0] + 8, p1[1] - 12, lbl1, '#93c5fd', 'left');

      ctx.beginPath();
      ctx.arc(org[0], org[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();

      const stageNames = [
        '起点：三维单位球与正交轴 v₁, v₂, v₃',
        '1. 乘 Vᵀ：三维刚体正交旋转（长度不变）',
        '2. 乘 Σ：拉长 5 倍、3 倍，v₃ 压扁进二维平面',
        '3. 乘 U：二维输出平面正交对齐 5u₁ 与 3u₂',
        '4. 秩 1 截断 M₁：丢掉 σ₂=3，椭圆塌成一维线段',
      ];
      const idx = clamp(Math.round(tau), 0, 4);
      badge.classList.toggle('m3b-hit', tau > 3.5);
      badge.textContent = `${stageNames[idx]} | 半轴 [${fmt(len1)}, ${fmt(len2)}, ${fmt(len3)}]`;
      scrubInput.value = String(Math.round((tau / 4) * 400));
      scrubVal.textContent = `阶段 ${tau.toFixed(2)} / 4`;
    }

    function animateTo(targetStep, speedMul, reduceMotion, onDone) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      const targetTau = targetStep.tau != null ? targetStep.tau : 0;
      const startTau = tau;
      if (reduceMotion || Math.abs(targetTau - startTau) < 1e-4) {
        tau = targetTau;
        paint();
        if (onDone) onDone();
        return;
      }
      const dist = Math.max(0.85, Math.abs(targetTau - startTau));
      const dur = (1150 * Math.min(2.2, dist)) / speedMul;
      const t0 = performance.now();
      const stepFrame = (now) => {
        const u = clamp((now - t0) / dur, 0, 1);
        tau = lerp(startTau, targetTau, easeInOut(u));
        paint();
        if (u < 1) animId = requestAnimationFrame(stepFrame);
        else { animId = null; if (onDone) onDone(); }
      };
      animId = requestAnimationFrame(stepFrame);
    }

    let dragging = false;
    let lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      userYawOffset += dx * 0.008;
      userPitchOffset = clamp(userPitchOffset + dy * 0.008, -0.75, 0.75);
      if (onUserCustomize) onUserCustomize(true);
      paint();
    });
    const endDrag = () => { dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    scrubInput.addEventListener('input', () => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      onManual();
      tau = parseFloat(scrubInput.value) / 100;
      if (onStepSync) onStepSync(Math.round(tau));
      paint();
    });

    return {
      paint,
      animateTo,
      resetCustom: () => {
        userYawOffset = 0;
        userPitchOffset = 0;
        paint();
      },
      stopAnim: () => { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  const mul2 = (A, B) => [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
  ];

  // --- Mode 3: 2D Basis Combination, Determinant Area, Outer Product Collapse & Matrix Composition ---
  function createBasis2D(canvas, badge, scrubInput, scrubVal, cfg, steps, onManual, onUserCustomize) {
    let activeStep = steps[0];
    let p = activeStep.t != null ? activeStep.t : 0;
    let vecX = (activeStep.vec_x || [2, 1]).slice();
    let userMovedX = false;
    let animId = null;

    function evalStepState(step, prog) {
      if (step.compose) {
        const c = step.compose;
        if (prog <= 0.5) {
          const u1 = easeInOut(clamp(prog / 0.46, 0, 1));
          const M = evalStepMat2D(c.first, !!c.first_rot90, u1);
          return { M, label: prog < 0.03 ? 'I' : c.first_label, ghostAlpha: 0 };
        }
        const u2 = easeInOut(clamp((prog - 0.54) / 0.46, 0, 1));
        const M1 = evalStepMat2D(c.first, !!c.first_rot90, 1);
        const M2 = evalStepMat2D(c.second, !!c.second_rot90, u2);
        const lbl = u2 < 0.06 ? c.first_label : (u2 > 0.94 ? c.prod_label : `${c.second_label}${c.first_label}`);
        return { M: mul2(M2, M1), label: lbl, ghostAlpha: c.ghost_mat ? smoothstep(0.35, 0.95, u2) : 0 };
      }
      const M = evalStepMat2D(step.mat || [1, 0, 0, 1], !!step.rot90, prog);
      return { M, label: prog < 0.03 ? 'I' : (step.mat_label || 'A'), ghostAlpha: 0 };
    }

    let state = evalStepState(activeStep, p);
    let dispMat = state.M;
    let curLabel = state.label;
    let ghostAlpha = state.ghostAlpha;

    function paint() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth || 640;
      const H = canvas.clientHeight || 360;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.52;
      const scale = Math.min(W, H) / 8.2;
      const toScreen = (x, y) => [cx + x * scale, cy - y * scale];
      const M = dispMat;
      const applyM = (x, y) => [M[0] * x + M[1] * y, M[2] * x + M[3] * y];

      // 1. Fixed reference background grid
      ctx.save();
      ctx.lineWidth = 1;
      for (let k = -9; k <= 9; k++) {
        ctx.strokeStyle = k === 0 ? 'rgba(148, 163, 184, 0.28)' : 'rgba(148, 163, 184, 0.09)';
        const [x0, y0] = toScreen(k, -9);
        const [x1, y1] = toScreen(k, 9);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const [hx0, hy0] = toScreen(-9, k);
        const [hx1, hy1] = toScreen(9, k);
        ctx.beginPath(); ctx.moveTo(hx0, hy0); ctx.lineTo(hx1, hy1); ctx.stroke();
      }
      ctx.restore();

      // 2. Live deforming cyan grid
      ctx.save();
      for (let k = -6; k <= 6; k++) {
        const major = k === 0;
        ctx.strokeStyle = major ? 'rgba(56, 189, 248, 0.60)' : 'rgba(34, 211, 238, 0.22)';
        ctx.lineWidth = major ? 1.45 : 1.0;
        let [ax, ay] = applyM(k, -6);
        let [bx, by] = applyM(k, 6);
        let [sx0, sy0] = toScreen(ax, ay);
        let [sx1, sy1] = toScreen(bx, by);
        ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();

        [ax, ay] = applyM(-6, k);
        [bx, by] = applyM(6, k);
        [sx0, sy0] = toScreen(ax, ay);
        [sx1, sy1] = toScreen(bx, by);
        ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
      }
      ctx.restore();

      const a1 = applyM(1, 0);
      const a2 = applyM(0, 1);
      const det = M[0] * M[3] - M[1] * M[2];
      const distFromI = Math.hypot(M[0] - 1, M[1], M[2], M[3] - 1);

      // 3. Unit square -> transformed parallelogram (det area visualization)
      const p00 = toScreen(0, 0);
      const p10 = toScreen(a1[0], a1[1]);
      const p11 = toScreen(a1[0] + a2[0], a1[1] + a2[1]);
      const p01 = toScreen(a2[0], a2[1]);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p00[0], p00[1]);
      ctx.lineTo(p10[0], p10[1]);
      ctx.lineTo(p11[0], p11[1]);
      ctx.lineTo(p01[0], p01[1]);
      ctx.closePath();
      ctx.fillStyle = det >= -0.01 ? 'rgba(56, 189, 248, 0.15)' : 'rgba(244, 114, 182, 0.16)';
      ctx.fill();
      ctx.strokeStyle = det >= -0.01 ? 'rgba(125, 211, 252, 0.48)' : 'rgba(244, 114, 182, 0.55)';
      ctx.lineWidth = 1.3;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();

      // If rank-1 collapsed (det ~ 0), highlight the collapsed output line and input null fiber through x
      const maxR = Math.hypot(W, H);
      if (distFromI > 0.1 && Math.abs(det) < 0.03) {
        const colDir = Math.hypot(a1[0], a1[1]) >= Math.hypot(a2[0], a2[1]) ? a1 : a2;
        drawSpanLine(ctx, cx, cy, colDir[0], colDir[1], maxR, '#38bdf8', 0.72);
        const rowLen = Math.hypot(M[0], M[1]) >= Math.hypot(M[2], M[3]) ? [M[0], M[1]] : [M[2], M[3]];
        const kerX = -rowLen[1], kerY = rowLen[0];
        const [ix, iy] = toScreen(vecX[0], vecX[1]);
        drawSpanLine(ctx, ix, iy, kerX, kerY, maxR, '#fbbf24', 0.42);
      }

      // 4. Linear-combination parallelogram x₁a₁ + x₂a₂ = Mx
      const [vx, vy] = vecX;
      const c1 = [vx * a1[0], vx * a1[1]];
      const c2 = [vy * a2[0], vy * a2[1]];
      const out = [c1[0] + c2[0], c1[1] + c2[1]];
      const sC1 = toScreen(c1[0], c1[1]);
      const sC2 = toScreen(c2[0], c2[1]);
      const sOut = toScreen(out[0], out[1]);

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.72)';
      ctx.beginPath(); ctx.moveTo(sC2[0], sC2[1]); ctx.lineTo(sOut[0], sOut[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.72)';
      ctx.beginPath(); ctx.moveTo(sC1[0], sC1[1]); ctx.lineTo(sOut[0], sOut[1]); ctx.stroke();
      ctx.restore();
      drawArrow2D(ctx, cx, cy, sC1[0], sC1[1], 'rgba(96, 165, 250, 0.55)', 2.0, 7.5, true);
      drawArrow2D(ctx, cx, cy, sC2[0], sC2[1], 'rgba(52, 211, 153, 0.55)', 2.0, 7.5, true);

      // 5. Basis / column vectors a₁ and a₂
      drawArrow2D(ctx, cx, cy, p10[0], p10[1], '#60a5fa', 2.8, 9.5);
      drawArrow2D(ctx, cx, cy, p01[0], p01[1], '#34d399', 2.8, 9.5);
      const n1 = Math.hypot(a1[0], a1[1]) || 1;
      const n2 = Math.hypot(a2[0], a2[1]) || 1;
      const lbl1 = distFromI < 0.04 ? 'e₁ = [1, 0]ᵀ' : `a₁ = [${fmt(a1[0])}, ${fmt(a1[1])}]ᵀ`;
      const lbl2 = distFromI < 0.04 ? 'e₂ = [0, 1]ᵀ' : `a₂ = [${fmt(a2[0])}, ${fmt(a2[1])}]ᵀ`;
      drawPillLabel(ctx, p10[0] + (a1[0] / n1) * 10, p10[1] - (a1[1] / n1) * 13 + 8, lbl1, '#93c5fd', a1[0] >= -0.1 ? 'left' : 'right');
      // Offset a₂ label cleanly even if collinear with a₁
      const colDot = (a1[0] * a2[0] + a1[1] * a2[1]) / (n1 * n2);
      const extraY = Math.abs(colDot) > 0.95 ? -16 : -12;
      drawPillLabel(ctx, p01[0] + (a2[0] / n2) * 10, p01[1] - (a2[1] / n2) * 10 + extraY, lbl2, '#6ee7b7', a2[0] <= 0.1 ? 'right' : 'left');

      // 6. Optional ghost comparison vector (e.g. RBx vs BRx)
      if (activeStep.compose && activeStep.compose.ghost_mat && ghostAlpha > 0.01) {
        const gm = activeStep.compose.ghost_mat;
        const gx = gm[0] * vx + gm[1] * vy;
        const gy = gm[2] * vx + gm[3] * vy;
        const [gsx, gsy] = toScreen(gx, gy);
        drawArrow2D(ctx, cx, cy, gsx, gsy, '#c084fc', 2.4, 9, true, ghostAlpha);
        const gn = Math.hypot(gx, gy) || 1;
        drawPillLabel(ctx, gsx + (gx / gn) * 10, gsy - (gy / gn) * 12,
          `${activeStep.compose.ghost_label || '对比'} = [${fmt(gx)}, ${fmt(gy)}]ᵀ`,
          '#e9d5ff', gx >= 0 ? 'left' : 'right', ghostAlpha);
      }

      // 7. Input handle x & transformed output vector Mx
      const [ix, iy] = toScreen(vx, vy);
      if (distFromI > 0.04) {
        drawArrow2D(ctx, cx, cy, ix, iy, 'rgba(251, 191, 36, 0.52)', 1.8, 7, true);
      }
      drawArrow2D(ctx, cx, cy, sOut[0], sOut[1], '#fbbf24', 3.1, 10.5);

      ctx.save();
      ctx.beginPath();
      ctx.arc(ix, iy, 5.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0d1321';
      ctx.stroke();
      if (distFromI > 0.08 && Math.hypot(sOut[0] - ix, sOut[1] - iy) > 20) {
        ctx.font = '600 11.5px ui-monospace, SFMono-Regular, Menlo, sans-serif';
        ctx.fillStyle = 'rgba(253, 230, 138, 0.9)';
        ctx.fillText(`x=[${fmt(vx)},${fmt(vy)}]ᵀ`, ix + (vx >= 0 ? 9 : -68), iy + (vy >= 0 ? -8 : 15));
      }
      ctx.restore();

      const outText = curLabel === 'I'
        ? `x = ${fmt(vx)}e₁ + ${fmt(vy)}e₂ = [${fmt(vx)}, ${fmt(vy)}]ᵀ`
        : `${curLabel}x = [${fmt(out[0])}, ${fmt(out[1])}]ᵀ`;
      drawPillLabel(ctx, sOut[0] + (out[0] >= 0 ? 10 : -10), sOut[1] - (out[1] >= 0 ? 13 : -13),
        outText, '#fde68a', out[0] >= 0 ? 'left' : 'right');

      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();

      const collapsed = distFromI > 0.1 && Math.abs(det) < 0.03;
      badge.classList.toggle('m3b-hit', collapsed);
      if (collapsed) {
        badge.textContent = `秩 1 降维（det = 0）：[${fmt(vx)}, ${fmt(vy)}]ᵀ → ${curLabel}x = [${fmt(out[0])}, ${fmt(out[1])}]ᵀ`;
      } else {
        badge.textContent = `当前变换 ${curLabel} | [${fmt(vx)}, ${fmt(vy)}]ᵀ → [${fmt(out[0])}, ${fmt(out[1])}]ᵀ | 面积倍率 det = ${fmt(det)}`;
      }
      scrubInput.value = String(Math.round(p * 100));
      scrubVal.textContent = `t = ${p.toFixed(2)}`;
    }

    function animateTo(targetStep, speedMul, reduceMotion, onDone) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      const startMat = dispMat.slice();
      const startX = vecX.slice();
      const targetX = (!userMovedX && targetStep.vec_x) ? targetStep.vec_x.slice() : vecX.slice();
      const targetT = targetStep.t != null ? targetStep.t : 1;

      if (reduceMotion) {
        activeStep = targetStep;
        p = targetT;
        vecX = targetX;
        const st = evalStepState(targetStep, p);
        dispMat = st.M;
        curLabel = st.label;
        ghostAlpha = st.ghostAlpha;
        paint();
        if (onDone) onDone();
        return;
      }

      // Check if current displayed matrix already matches compose.first (e.g. Step 2 A -> Step 3 A⁻¹A)
      const c = targetStep.compose;
      const matchesComposeFirst = c && c.first.every((v, i) => Math.abs(v - startMat[i]) < 1e-3);
      const wasIdentity = Math.hypot(startMat[0] - 1, startMat[1], startMat[2], startMat[3] - 1) < 0.04;

      activeStep = targetStep;
      if (matchesComposeFirst) {
        const dur = 1100 / speedMul;
        const t0 = performance.now();
        const frame = (now) => {
          const u = clamp((now - t0) / dur, 0, 1);
          p = lerp(0.5, targetT, u);
          vecX = [lerp(startX[0], targetX[0], easeInOut(u)), lerp(startX[1], targetX[1], easeInOut(u))];
          const st = evalStepState(targetStep, p);
          dispMat = st.M;
          curLabel = st.label;
          ghostAlpha = st.ghostAlpha;
          paint();
          if (u < 1) animId = requestAnimationFrame(frame);
          else { animId = null; if (onDone) onDone(); }
        };
        animId = requestAnimationFrame(frame);
        return;
      }

      const needUnwind = !wasIdentity && targetT > 0.02;
      const totalDur = ((c ? 1650 : 1050) + (needUnwind ? 520 : 0)) / speedMul;
      const split = needUnwind ? 0.28 : 0;
      const startP = p;
      const t0 = performance.now();
      const frame = (now) => {
        const u = clamp((now - t0) / totalDur, 0, 1);
        vecX = [lerp(startX[0], targetX[0], easeInOut(clamp(u / Math.max(0.45, split), 0, 1))),
                lerp(startX[1], targetX[1], easeInOut(clamp(u / Math.max(0.45, split), 0, 1)))];
        if (needUnwind && u < split) {
          const uw = easeInOut(u / split);
          p = startP * (1 - uw);
          dispMat = [
            lerp(startMat[0], 1, uw),
            lerp(startMat[1], 0, uw),
            lerp(startMat[2], 0, uw),
            lerp(startMat[3], 1, uw),
          ];
          curLabel = uw > 0.85 ? 'I' : curLabel;
          ghostAlpha = 0;
        } else if (targetT <= 0.02) {
          const uw = easeInOut(u);
          p = lerp(startP, targetT, uw);
          dispMat = [
            lerp(startMat[0], 1, uw),
            lerp(startMat[1], 0, uw),
            lerp(startMat[2], 0, uw),
            lerp(startMat[3], 1, uw),
          ];
          curLabel = uw > 0.85 ? 'I' : curLabel;
          ghostAlpha = 0;
        } else {
          const v = clamp((u - split) / (1 - split), 0, 1);
          p = c ? lerp(0, targetT, v) : lerp(0, targetT, easeInOut(v));
          const st = evalStepState(targetStep, p);
          dispMat = st.M;
          curLabel = st.label;
          ghostAlpha = st.ghostAlpha;
        }
        paint();
        if (u < 1) animId = requestAnimationFrame(frame);
        else { animId = null; if (onDone) onDone(); }
      };
      animId = requestAnimationFrame(frame);
    }

    let dragging = false;
    const updateXFromEvent = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width || 640, rect.height || 360) / 8.2;
      let mx = clamp((e.clientX - rect.left - rect.width * 0.5) / scale, -3.2, 3.2);
      let my = clamp(-(e.clientY - rect.top - rect.height * 0.52) / scale, -2.8, 2.8);
      const rx = Math.round(mx);
      const ry = Math.round(my);
      if (Math.hypot(mx - rx, my - ry) < 0.13) { mx = rx; my = ry; }
      else {
        const hx = Math.round(mx * 2) / 2;
        const hy = Math.round(my * 2) / 2;
        if (Math.hypot(mx - hx, my - hy) < 0.075) { mx = hx; my = hy; }
      }
      vecX = [mx, my];
      paint();
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      userMovedX = true;
      if (onUserCustomize) onUserCustomize(true);
      canvas.setPointerCapture(e.pointerId);
      onManual();
      updateXFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) updateXFromEvent(e); });
    const endDrag = () => { dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    scrubInput.addEventListener('input', () => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      onManual();
      p = parseFloat(scrubInput.value) / 100;
      const st = evalStepState(activeStep, p);
      dispMat = st.M;
      curLabel = st.label;
      ghostAlpha = st.ghostAlpha;
      paint();
    });

    return {
      paint,
      animateTo,
      resetCustom: () => {
        userMovedX = false;
        vecX = (activeStep.vec_x || [2, 1]).slice();
        paint();
      },
      stopAnim: () => { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  // --- Mode 4: 2D Norms, Dot Product, Angle Cosine, Orthogonality & Outer-Product Projection ---
  function createDotProj2D(canvas, badge, scrubInput, scrubVal, cfg, steps, onManual, onUserCustomize) {
    let activeStep = steps[0];
    let p = activeStep.t != null ? activeStep.t : 0;
    let vecA = (activeStep.vec_a || [3, -4]).slice();
    let vecB = (activeStep.vec_b || [4, 2]).slice();
    let bAlpha = activeStep.vec_b ? 1 : 0;
    let normAlpha = activeStep.show_norms ? 1 : 0;
    let angleAlpha = activeStep.show_angle ? 1 : 0;
    let halfAlpha = activeStep.show_halfplane ? 1 : 0;
    let projAlpha = activeStep.show_proj ? 1 : 0;
    let userMovedA = false;
    let animId = null;

    function paint() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth || 640;
      const H = canvas.clientHeight || 360;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const cx = W * 0.5;
      const cy = H * 0.52;
      const scale = Math.min(W, H) / 10.4;
      const toScreen = (x, y) => [cx + x * scale, cy - y * scale];

      const [ax, ay] = vecA;
      const [bx, by] = vecB;
      const b2 = bx * bx + by * by || 1;
      const P = [(bx * bx) / b2, (bx * by) / b2, (by * bx) / b2, (by * by) / b2];
      const gridProg = bAlpha > 0.5 ? p : 0;
      const M = [
        1 + gridProg * (P[0] - 1),
        gridProg * P[1],
        gridProg * P[2],
        1 + gridProg * (P[3] - 1),
      ];
      const applyM = (x, y) => [M[0] * x + M[1] * y, M[2] * x + M[3] * y];

      // 1. Background fixed reference grid
      ctx.save();
      ctx.lineWidth = 1;
      for (let k = -11; k <= 11; k++) {
        ctx.strokeStyle = k === 0 ? 'rgba(148, 163, 184, 0.30)' : 'rgba(148, 163, 184, 0.09)';
        const [x0, y0] = toScreen(k, -11);
        const [x1, y1] = toScreen(k, 11);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        const [hx0, hy0] = toScreen(-11, k);
        const [hx1, hy1] = toScreen(11, k);
        ctx.beginPath(); ctx.moveTo(hx0, hy0); ctx.lineTo(hx1, hy1); ctx.stroke();
      }
      ctx.restore();

      // 2. Deforming cyan grid when applying P = qqᵀ (or subtle cyan grid ready to project)
      if (projAlpha > 0.02) {
        ctx.save();
        ctx.globalAlpha = 0.35 + 0.65 * projAlpha;
        for (let k = -7; k <= 7; k++) {
          const major = k === 0;
          ctx.strokeStyle = major ? 'rgba(56, 189, 248, 0.50)' : 'rgba(34, 211, 238, 0.18)';
          ctx.lineWidth = major ? 1.4 : 0.95;
          let [u0, v0] = applyM(k, -7);
          let [u1, v1] = applyM(k, 7);
          let [sx0, sy0] = toScreen(u0, v0);
          let [sx1, sy1] = toScreen(u1, v1);
          ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();

          [u0, v0] = applyM(-7, k);
          [u1, v1] = applyM(7, k);
          [sx0, sy0] = toScreen(u0, v0);
          [sx1, sy1] = toScreen(u1, v1);
          ctx.beginPath(); ctx.moveTo(sx0, sy0); ctx.lineTo(sx1, sy1); ctx.stroke();
        }
        ctx.restore();
      }

      const maxR = Math.hypot(W, H);
      const bNorm = Math.hypot(bx, by) || 1;
      const aNorm = Math.hypot(ax, ay);

      // 3. Orthogonal half-planes & perpendicular dividing line bᵀx = 0
      if (halfAlpha > 0.01) {
        const ux = bx / bNorm;
        const uy = by / bNorm;
        const nx = -uy;
        const ny = ux;
        const big = 18;
        ctx.save();
        ctx.globalAlpha = halfAlpha;
        const q1 = toScreen(nx * big, ny * big);
        const q2 = toScreen(-nx * big, -ny * big);
        const q3 = toScreen(-nx * big + ux * big, -ny * big + uy * big);
        const q4 = toScreen(nx * big + ux * big, ny * big + uy * big);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.075)';
        ctx.beginPath();
        ctx.moveTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]);
        ctx.lineTo(q3[0], q3[1]); ctx.lineTo(q4[0], q4[1]);
        ctx.closePath(); ctx.fill();

        const r3 = toScreen(-nx * big - ux * big, -ny * big - uy * big);
        const r4 = toScreen(nx * big - ux * big, ny * big - uy * big);
        ctx.fillStyle = 'rgba(248, 113, 113, 0.065)';
        ctx.beginPath();
        ctx.moveTo(q1[0], q1[1]); ctx.lineTo(q2[0], q2[1]);
        ctx.lineTo(r3[0], r3[1]); ctx.lineTo(r4[0], r4[1]);
        ctx.closePath(); ctx.fill();
        ctx.restore();

        drawSpanLine(ctx, cx, cy, nx, ny, maxR, '#e2e8f0', 0.62 * halfAlpha);
        const posLbl = toScreen(ux * 3.1 + nx * 2.2, uy * 3.1 + ny * 2.2);
        const negLbl = toScreen(-ux * 3.1 - nx * 1.8, -uy * 3.1 - ny * 1.8);
        drawPillLabel(ctx, posLbl[0], posLbl[1], '锐角半平面 aᵀb > 0', '#93c5fd', 'center', halfAlpha * 0.9);
        drawPillLabel(ctx, negLbl[0], negLbl[1], '钝角半平面 aᵀb < 0', '#fca5a5', 'center', halfAlpha * 0.9);
      }

      // 4. Constant-norm contours (r = 3: L1 diamond, L2 circle, L∞ square) + unit circle & â
      if (normAlpha > 0.01) {
        const r = 3;
        ctx.save();
        ctx.globalAlpha = normAlpha;
        // L∞ square
        const sqA = toScreen(-r, -r), sqB = toScreen(r, r);
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.68)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(sqA[0], sqB[1], sqB[0] - sqA[0], sqA[1] - sqB[1]);

        // L2 circle
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(96, 165, 250, 0.78)';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
        ctx.stroke();

        // L1 diamond
        const dN = toScreen(0, r), dE = toScreen(r, 0), dS = toScreen(0, -r), dW = toScreen(-r, 0);
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.78)';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(dN[0], dN[1]); ctx.lineTo(dE[0], dE[1]);
        ctx.lineTo(dS[0], dS[1]); ctx.lineTo(dW[0], dW[1]);
        ctx.closePath();
        ctx.stroke();

        // Unit circle r = 1
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(cx, cy, scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        drawPillLabel(ctx, sqB[0] + 6, sqB[1] + 2, '‖x‖∞ = 3（正方形）', '#e9d5ff', 'left', normAlpha);
        const cPos = toScreen(-2.12, 2.12);
        drawPillLabel(ctx, cPos[0] - 6, cPos[1] - 8, '‖x‖₂ = 3（正圆）', '#93c5fd', 'right', normAlpha);
        drawPillLabel(ctx, dN[0] + 8, dN[1] - 4, '‖x‖₁ = 3（菱形）', '#6ee7b7', 'left', normAlpha);

        if (aNorm > 0.05) {
          const ux = ax / aNorm, uy = ay / aNorm;
          const [uhx, uhy] = toScreen(ux, uy);
          drawArrow2D(ctx, cx, cy, uhx, uhy, '#34d399', 2.6, 8.5, false, normAlpha);
          drawPillLabel(ctx, uhx + (ux >= 0 ? 8 : -8), uhy + (uy >= 0 ? -12 : 12),
            `â = [${fmt(ux)}, ${fmt(uy)}]ᵀ`, '#6ee7b7', ux >= 0 ? 'left' : 'right', normAlpha);
        }
      }

      // 5. Reference vector b & its span line
      if (bAlpha > 0.01) {
        if (projAlpha > 0.01) {
          drawSpanLine(ctx, cx, cy, bx, by, maxR, '#60a5fa', 0.55 * bAlpha * projAlpha);
        }
        const [bsx, bsy] = toScreen(bx, by);
        drawArrow2D(ctx, cx, cy, bsx, bsy, '#60a5fa', 2.9, 10, false, bAlpha);
        drawPillLabel(ctx, bsx + (bx >= 0 ? 9 : -9), bsy - (by >= 0 ? 12 : -12),
          `b = [${fmt(bx)}, ${fmt(by)}]ᵀ`, '#93c5fd', bx >= 0 ? 'left' : 'right', bAlpha);
      }

      // 6. Angle arc or right-angle marker at origin
      const dot = ax * bx + ay * by;
      const cos = aNorm > 1e-5 ? clamp(dot / (aNorm * bNorm), -1, 1) : 0;
      const deg = (Math.acos(cos) * 180) / Math.PI;
      if (angleAlpha > 0.01 && bAlpha > 0.01 && aNorm > 0.15) {
        if (Math.abs(cos) < 0.035) {
          const r = 0.34;
          const e1x = (bx / bNorm) * r, e1y = (by / bNorm) * r;
          const e2x = (ax / aNorm) * r, e2y = (ay / aNorm) * r;
          const pA = toScreen(e1x, e1y);
          const pB = toScreen(e1x + e2x, e1y + e2y);
          const pC = toScreen(e2x, e2y);
          ctx.save();
          ctx.globalAlpha = 0.9 * angleAlpha * bAlpha;
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(pA[0], pA[1]); ctx.lineTo(pB[0], pB[1]); ctx.lineTo(pC[0], pC[1]);
          ctx.stroke();
          ctx.restore();
        } else {
          const angB = Math.atan2(by, bx);
          const angA = Math.atan2(ay, ax);
          const dAng = Math.atan2(Math.sin(angA - angB), Math.cos(angA - angB));
          const rad = Math.min(1.05, 0.38 * Math.min(aNorm, bNorm));
          ctx.save();
          ctx.globalAlpha = 0.85 * angleAlpha * bAlpha;
          ctx.strokeStyle = '#fde68a';
          ctx.lineWidth = 1.7;
          ctx.beginPath();
          const stepsArc = 28;
          for (let i = 0; i <= stepsArc; i++) {
            const th = angB + (dAng * i) / stepsArc;
            const [sx, sy] = toScreen(Math.cos(th) * rad, Math.sin(th) * rad);
            if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
          const mid = angB + dAng * 0.5;
          const [lx, ly] = toScreen(Math.cos(mid) * (rad + 0.42), Math.sin(mid) * (rad + 0.42));
          ctx.font = '600 11.5px ui-monospace, SFMono-Regular, Menlo, sans-serif';
          ctx.fillStyle = '#fde68a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${fmt(deg)}°`, lx, ly);
          ctx.restore();
        }
      }

      // 7. Orthogonal projection p onto span(b) + perpendicular residual a - p + right-angle square at foot
      const cProj = dot / b2;
      const px = cProj * bx;
      const py = cProj * by;
      const rx = ax - px;
      const ry = ay - py;
      const rNorm = Math.hypot(rx, ry);
      if (projAlpha > 0.01 && bAlpha > 0.01) {
        const [psx, psy] = toScreen(px, py);
        const [asx, asy] = toScreen(ax, ay);
        if (rNorm > 0.2) {
          const sz = Math.min(0.32, 0.35 * rNorm);
          const sgnB = cProj >= 0 ? -1 : 1;
          const uBx = (sgnB * bx / bNorm) * sz;
          const uBy = (sgnB * by / bNorm) * sz;
          const uRx = (rx / rNorm) * sz;
          const uRy = (ry / rNorm) * sz;
          const cA = toScreen(px + uBx, py + uBy);
          const cB = toScreen(px + uBx + uRx, py + uBy + uRy);
          const cC = toScreen(px + uRx, py + uRy);
          ctx.save();
          ctx.globalAlpha = 0.88 * projAlpha;
          ctx.strokeStyle = '#f8fafc';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(cA[0], cA[1]); ctx.lineTo(cB[0], cB[1]); ctx.lineTo(cC[0], cC[1]);
          ctx.stroke();
          ctx.restore();
        }
        drawArrow2D(ctx, psx, psy, asx, asy, '#f87171', 2.2, 8, true, projAlpha * (1 - 0.55 * gridProg));
        drawArrow2D(ctx, cx, cy, psx, psy, '#34d399', 3.0, 9.5, false, projAlpha);
        drawPillLabel(ctx, psx + (ry >= 0 ? 8 : -8), psy + (ry >= 0 ? 15 : -15),
          `p = [${fmt(px)}, ${fmt(py)}]ᵀ`, '#6ee7b7', ry >= 0 ? 'left' : 'right', projAlpha);
      }

      // 8. Draggable vector a (and live transformed vector when scrubbing normalization or P = qqᵀ)
      const normScrub = (normAlpha > 0.5 && bAlpha < 0.5) ? p : 0;
      const curAx = normScrub > 0.01 && aNorm > 0.05
        ? lerp(ax, ax / aNorm, normScrub)
        : (gridProg > 0.01 ? lerp(ax, px, gridProg) : ax);
      const curAy = normScrub > 0.01 && aNorm > 0.05
        ? lerp(ay, ay / aNorm, normScrub)
        : (gridProg > 0.01 ? lerp(ay, py, gridProg) : ay);

      const [iax, iay] = toScreen(ax, ay);
      const [cax, cay] = toScreen(curAx, curAy);
      if (normScrub > 0.02 || gridProg > 0.02) {
        drawArrow2D(ctx, cx, cy, iax, iay, 'rgba(251, 191, 36, 0.48)', 1.8, 7, true);
      }
      drawArrow2D(ctx, cx, cy, cax, cay, '#fbbf24', 3.1, 10.5);

      ctx.save();
      ctx.beginPath();
      ctx.arc(iax, iay, 5.8, 0, Math.PI * 2);
      ctx.fillStyle = '#fbbf24';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0d1321';
      ctx.stroke();
      ctx.restore();

      const aLabel = gridProg > 0.94
        ? `Pa = [${fmt(curAx)}, ${fmt(curAy)}]ᵀ`
        : `a = [${fmt(curAx)}, ${fmt(curAy)}]ᵀ`;
      drawPillLabel(ctx, cax + (curAx >= 0 ? 10 : -10), cay - (curAy >= 0 ? 13 : -13),
        aLabel, '#fde68a', curAx >= 0 ? 'left' : 'right');

      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#f8fafc';
      ctx.fill();

      // 9. HUD badge
      const l1 = Math.abs(ax) + Math.abs(ay);
      const linf = Math.max(Math.abs(ax), Math.abs(ay));
      const isOrtho = bAlpha > 0.5 && projAlpha < 0.5 && aNorm > 0.1 && Math.abs(cos) < 0.025;
      badge.classList.toggle('m3b-hit', isOrtho || gridProg > 0.94);
      if (normAlpha > 0.5 && bAlpha < 0.5) {
        badge.textContent = `a = [${fmt(ax)}, ${fmt(ay)}]ᵀ | ‖a‖₁ = ${fmt(l1)}，‖a‖₂ = ${fmt(aNorm)}，‖a‖∞ = ${fmt(linf)}`;
      } else if (projAlpha > 0.5) {
        badge.textContent = `投影 p = [${fmt(px)}, ${fmt(py)}]ᵀ (c = ${fmt(cProj)}) | 误差 r = [${fmt(rx)}, ${fmt(ry)}]ᵀ，bᵀr = 0`;
      } else if (isOrtho) {
        badge.textContent = `严格正交（夹角 90°）：aᵀb = 0`;
      } else {
        badge.textContent = `点积 aᵀb = ${fmt(dot)} | ‖a‖₂ = ${fmt(aNorm)}，‖b‖₂ = ${fmt(bNorm)} | cos θ = ${fmt(cos)}（${fmt(deg)}°）`;
      }
      scrubInput.value = String(Math.round(p * 100));
      scrubVal.textContent = `t = ${p.toFixed(2)}`;
    }

    function animateTo(targetStep, speedMul, reduceMotion, onDone) {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      const sA = vecA.slice();
      const tA = (!userMovedA && targetStep.vec_a) ? targetStep.vec_a.slice() : vecA.slice();
      const sB = vecB.slice();
      const tB = (targetStep.vec_b || vecB).slice();
      const sBA = bAlpha, tBA = targetStep.vec_b ? 1 : 0;
      const sNA = normAlpha, tNA = targetStep.show_norms ? 1 : 0;
      const sAA = angleAlpha, tAA = targetStep.show_angle ? 1 : 0;
      const sHA = halfAlpha, tHA = targetStep.show_halfplane ? 1 : 0;
      const sPA = projAlpha, tPA = targetStep.show_proj ? 1 : 0;
      const sP = p, tP = targetStep.t != null ? targetStep.t : 0;

      activeStep = targetStep;
      if (reduceMotion) {
        vecA = tA; vecB = tB;
        bAlpha = tBA; normAlpha = tNA; angleAlpha = tAA; halfAlpha = tHA; projAlpha = tPA;
        p = tP;
        paint();
        if (onDone) onDone();
        return;
      }

      const dur = 1000 / speedMul;
      const t0 = performance.now();
      const frame = (now) => {
        const u = clamp((now - t0) / dur, 0, 1);
        const e = easeInOut(u);
        vecA = [lerp(sA[0], tA[0], e), lerp(sA[1], tA[1], e)];
        vecB = [lerp(sB[0], tB[0], e), lerp(sB[1], tB[1], e)];
        bAlpha = lerp(sBA, tBA, e);
        normAlpha = lerp(sNA, tNA, e);
        angleAlpha = lerp(sAA, tAA, e);
        halfAlpha = lerp(sHA, tHA, e);
        projAlpha = lerp(sPA, tPA, e);
        p = lerp(sP, tP, e);
        paint();
        if (u < 1) animId = requestAnimationFrame(frame);
        else { animId = null; if (onDone) onDone(); }
      };
      animId = requestAnimationFrame(frame);
    }

    let dragging = false;
    const updateAFromEvent = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width || 640, rect.height || 360) / 10.4;
      let mx = clamp((e.clientX - rect.left - rect.width * 0.5) / scale, -6.5, 6.5);
      let my = clamp(-(e.clientY - rect.top - rect.height * 0.52) / scale, -4.6, 4.6);
      const rx = Math.round(mx);
      const ry = Math.round(my);
      if (Math.hypot(mx - rx, my - ry) < 0.16) { mx = rx; my = ry; }
      else if (bAlpha > 0.5 && Math.hypot(mx, my) > 0.35) {
        const [bx, by] = vecB;
        const bNorm = Math.hypot(bx, by) || 1;
        const nLen = Math.hypot(mx, my);
        const cos = (mx * bx + my * by) / (nLen * bNorm);
        if (Math.abs(cos) < 0.04) {
          const sgn = (-by * mx + bx * my) >= 0 ? 1 : -1;
          mx = sgn * (-by / bNorm) * nLen;
          my = sgn * (bx / bNorm) * nLen;
        }
      }
      vecA = [mx, my];
      paint();
    };
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      userMovedA = true;
      if (onUserCustomize) onUserCustomize(true);
      canvas.setPointerCapture(e.pointerId);
      onManual();
      updateAFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (dragging) updateAFromEvent(e); });
    const endDrag = () => { dragging = false; };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    scrubInput.addEventListener('input', () => {
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      onManual();
      p = parseFloat(scrubInput.value) / 100;
      paint();
    });

    return {
      paint,
      animateTo,
      resetCustom: () => {
        userMovedA = false;
        vecA = (activeStep.vec_a || [3, -4]).slice();
        paint();
      },
      stopAnim: () => { if (animId) { cancelAnimationFrame(animId); animId = null; } },
    };
  }

  function init(root) {
    if (root.classList.contains('kvd-ready')) return;
    const src = root.querySelector('.m3b-demo-data');
    if (!src) return;
    let demo;
    try { demo = JSON.parse(src.textContent); } catch (e) { return; }
    const steps = demo.steps || [];
    const cfg = demo.config || {};
    if (!steps.length) return;

    const stage = el('div', 'kvd-stage');
    const viewport = el('div', 'm3b-viewport');
    const canvas = el('canvas', 'm3b-canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', demo.title || '线性变换几何动画');
    const hud = el('div', 'm3b-hud');
    const badge = el('span', 'm3b-badge');
    const hint = el('span', 'm3b-hint', cfg.hint || '');
    hud.append(badge);
    if (cfg.hint) hud.append(hint);
    viewport.append(canvas, hud);

    const bar = el('div', 'm3b-bar');
    const scrubWrap = el('div', 'm3b-scrub');
    const scrubVal = el('label', '', '');
    const scrubInput = document.createElement('input');
    scrubInput.type = 'range';
    scrubInput.min = '0';
    scrubInput.max = cfg.mode === 'svd3d' ? '400' : '100';
    scrubInput.value = '0';
    scrubInput.setAttribute('aria-label', cfg.scrub_label || '动画进度');
    scrubWrap.append(scrubVal, scrubInput);
    bar.append(scrubWrap);

    (cfg.legend || []).forEach((item) => {
      const sp = el('span', 'kvd-legend-item');
      if (item.dashed) {
        const ln = el('span', 'm3b-line-sw');
        ln.style.color = item.hex || '#fbbf24';
        sp.append(ln, document.createTextNode(item.text));
      } else {
        const dot = el('span', 'm3b-dot');
        dot.style.background = item.hex || '#60a5fa';
        sp.append(dot, document.createTextNode(item.text));
      }
      bar.append(sp);
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
    const restoreBtn = el('button', 'kvd-btn', cfg.reset_label || (cfg.mode === 'svd3d' ? '重置视角' : '重置 x'));
    restoreBtn.hidden = true;
    [prev, next, play, reset, speed, restoreBtn].forEach((b) => { b.type = 'button'; });
    controls.append(prev, counter, next, play, reset, speed, restoreBtn);

    stage.append(viewport, bar, text, controls);
    const fallback = root.querySelector('.kv-demo-fallback');
    if (fallback) fallback.hidden = true;
    root.insertBefore(stage, src);
    root.classList.add('kvd-ready');

    let cur = 0;
    let playTimer = null;
    let playing = false;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function stopPlay() {
      playing = false;
      if (playTimer) { clearTimeout(playTimer); playTimer = null; }
      play.textContent = '自动播放';
      play.setAttribute('aria-pressed', 'false');
    }

    function syncMeta() {
      text.textContent = steps[cur].text;
      counter.textContent = `${cur + 1} / ${steps.length}`;
      prev.disabled = cur === 0;
      next.disabled = cur === steps.length - 1;
    }

    const onCustomize = (dirty) => { restoreBtn.hidden = !dirty; };

    const engine = cfg.mode === 'svd3d'
      ? createSVD3D(canvas, badge, scrubInput, scrubVal, cfg, steps, stopPlay, (idx) => {
          const nextIdx = clamp(idx, 0, steps.length - 1);
          if (nextIdx !== cur) { cur = nextIdx; syncMeta(); }
        }, onCustomize)
      : cfg.mode === 'basis2d'
      ? createBasis2D(canvas, badge, scrubInput, scrubVal, cfg, steps, stopPlay, onCustomize)
      : cfg.mode === 'dotproj2d'
      ? createDotProj2D(canvas, badge, scrubInput, scrubVal, cfg, steps, stopPlay, onCustomize)
      : createEigen2D(canvas, badge, scrubInput, scrubVal, cfg, steps, stopPlay, onCustomize);

    restoreBtn.addEventListener('click', () => {
      restoreBtn.hidden = true;
      engine.resetCustom();
    });

    function go(idx, afterAnim) {
      cur = clamp(idx, 0, steps.length - 1);
      syncMeta();
      engine.animateTo(steps[cur], speeds[speedIdx], reduce, afterAnim);
    }

    function scheduleNext() {
      if (!playing) return;
      if (cur >= steps.length - 1) { stopPlay(); return; }
      playTimer = setTimeout(() => {
        if (!playing) return;
        go(cur + 1, scheduleNext);
      }, 1350 / speeds[speedIdx]);
    }

    prev.addEventListener('click', () => { stopPlay(); go(cur - 1); });
    next.addEventListener('click', () => { stopPlay(); go(cur + 1); });
    reset.addEventListener('click', () => { stopPlay(); go(0); });
    play.addEventListener('click', () => {
      if (playing) { stopPlay(); engine.stopAnim(); return; }
      playing = true;
      play.textContent = '暂停';
      play.setAttribute('aria-pressed', 'true');
      if (cur === steps.length - 1) go(0, scheduleNext);
      else go(cur + 1, scheduleNext);
    });
    speed.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      const v = speeds[speedIdx];
      speed.textContent = `速度 ${v}×`;
      speed.setAttribute('aria-label', `切换自动播放速度，当前 ${v}×`);
    });

    syncMeta();
    engine.paint();
    window.addEventListener('resize', () => engine.paint());
  }

  const run = () => document.querySelectorAll('.m3b-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
