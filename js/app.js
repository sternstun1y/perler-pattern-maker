/* ============================================================
 * 拼豆图纸生成器 - 主逻辑
 * 流程：上传图片 → 降采样到板型网格 →（可选）中位切分降色 →
 *       Lab 色彩空间最近邻匹配 Perler 色号 → 杂点清理 → 渲染/导出
 * ============================================================ */

"use strict";

/* ---------- 全局状态 ---------- */
let srcImage = null;        // 用户上传的原始 Image 对象
let grid = [];              // 生成结果：grid[y][x] = 色库对象 或 null(透明)
let gridW = 0, gridH = 0;   // 网格尺寸（豆数）

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone"), fileInput = $("fileInput");
const previewCanvas = $("previewCanvas"), patternCanvas = $("patternCanvas");

/* ---------- 颜色科学：sRGB → CIELAB ----------
 * 拼豆匹配在 Lab 空间做欧氏距离，比直接 RGB 距离更符合人眼感知
 * （RGB 里数值相近不代表看起来相近，Lab 是为感知均匀设计的） */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToLab(r, g, b) {
  // 1) gamma 展开为线性光
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [lr, lg, lb] = [f(r), f(g), f(b)];
  // 2) 线性 RGB → XYZ（D65 白点）
  const X = lr * 0.4124 + lg * 0.3576 + lb * 0.1805;
  const Y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const Z = lr * 0.0193 + lg * 0.1192 + lb * 0.9505;
  // 3) XYZ → Lab（以 D65 白点归一）
  const xn = 0.95047, yn = 1.0, zn = 1.08883;
  const g2 = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = g2(X / xn), fy = g2(Y / yn), fz = g2(Z / zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// 启动时预计算整个色库的 Lab 值，匹配时只算一次待匹配色
const PALETTE = PERLER_COLORS.map((c) => {
  const [r, g, b] = hexToRgb(c.hex);
  return { ...c, rgb: [r, g, b], lab: rgbToLab(r, g, b) };
});

function nearestBead(r, g, b) {
  const [L, A, B] = rgbToLab(r, g, b);
  let best = null, bestD = Infinity;
  for (const p of PALETTE) {
    const d = (p.lab[0] - L) ** 2 + (p.lab[1] - A) ** 2 + (p.lab[2] - B) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/* ---------- 中位切分降色（照片 → K 色）----------
 * 把照片颜色收敛到 K 个代表色，再映射实体豆。
 * 不做这步的话照片渐变会被附近多个相近豆色拆碎，图纸杂乱。 */
function medianCut(pixels, k) {
  let buckets = [pixels];
  while (buckets.length < k) {
    // 找出颜色跨度最大的桶来切
    let bi = -1, bch = -1, brange = -1;
    buckets.forEach((bkt, i) => {
      if (bkt.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255, hi = 0;
        for (const p of bkt) {
          if (p[ch] < lo) lo = p[ch];
          if (p[ch] > hi) hi = p[ch];
        }
        if (hi - lo > brange) { brange = hi - lo; bi = i; bch = ch; }
      }
    });
    if (bi < 0 || brange <= 0) break;
    const bkt = buckets[bi].slice().sort((a, b) => a[bch] - b[bch]);
    const mid = bkt.length >> 1;
    buckets.splice(bi, 1, bkt.slice(0, mid), bkt.slice(mid));
  }
  // 每个桶取平均色作为代表色
  return buckets
    .filter((b) => b.length)
    .map((bkt) => {
      let r = 0, g = 0, bl = 0;
      for (const p of bkt) { r += p[0]; g += p[1]; bl += p[2]; }
      const n = bkt.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
    });
}

/* ---------- 图片 → 网格 ---------- */
function imageToPixels(img, cols, rows) {
  // 逐级减半降采样，避免一次缩太小导致细节糊掉
  let w = img.width, h = img.height, cur = img;
  while (w / 2 >= cols && h / 2 >= rows) {
    const c = document.createElement("canvas");
    c.width = Math.max(cols, Math.floor(w / 2));
    c.height = Math.max(rows, Math.floor(h / 2));
    c.getContext("2d", { willReadFrequently: true }).drawImage(cur, 0, 0, c.width, c.height);
    cur = c; w = c.width; h = c.height;
  }
  const c = document.createElement("canvas");
  c.width = cols; c.height = rows;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, cols, rows);
  return ctx.getImageData(0, 0, cols, rows);
}

function generateGrid() {
  const cols = parseInt($("cols").value), rows = parseInt($("rows").value);
  if (!srcImage || !(cols >= 5 && rows >= 5)) { alert("请先上传图片并设置 5~200 的宽高"); return; }
  gridW = cols; gridH = rows;

  const imgData = imageToPixels(srcImage, cols, rows);
  const d = imgData.data;

  // 收集不透明像素做降色
  const opaque = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] >= 128) opaque.push([d[i], d[i + 1], d[i + 2]]);
  }

  const k = parseInt($("kColors").value);
  const useQuant = $("kColors").value !== "6" || k >= 6; // 滑块最左=6 即最小，仍开启
  let reps = null;
  if (opaque.length && k <= 48) {
    // 像素图本身颜色少，降色不亏；照片必须降色
    reps = medianCut(opaque, Math.min(k, Math.max(2, opaque.length)));
  }
  // 每个代表色 → 最近的实体豆（缓存，避免重复计算 Lab）
  const repCache = new Map();
  const toBead = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    if (!repCache.has(key)) repCache.set(key, nearestBead(r, g, b));
    return repCache.get(key);
  };

  grid = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      if (d[i + 3] < 128) { row.push(null); continue; }   // 半透明视为空格
      let rgb = [d[i], d[i + 1], d[i + 2]];
      if (reps) {
        // 找像素所属的代表色（最近代表色）
        let best = 0, bd = Infinity;
        for (let j = 0; j < reps.length; j++) {
          const dr = reps[j][0] - rgb[0], dg = reps[j][1] - rgb[1], db = reps[j][2] - rgb[2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bd) { bd = dist; best = j; }
        }
        rgb = reps[best];
      }
      row.push(toBead(rgb[0], rgb[1], rgb[2]));
    }
    grid.push(row);
  }

  if ($("denoise").checked) denoise();

  renderPreview();
  renderPattern();
  renderBeadList();
  $("dlPattern").disabled = false;
  $("dlCsv").disabled = false;
}

/* ---------- 杂点清理：孤豆并入四周主流色 ----------
 * 照片经匹配后常出现单颗"钉子"豆（周围全是别的色），
 * 实体拼豆里这种格子最难拼，删掉观感更干净。 */
function denoise() {
  const changed = [];
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const cur = grid[y][x];
      if (!cur) continue;
      const nb = [];
      if (y > 0 && grid[y - 1][x]) nb.push(grid[y - 1][x].code);
      if (y < gridH - 1 && grid[y + 1][x]) nb.push(grid[y + 1][x].code);
      if (x > 0 && grid[y][x - 1]) nb.push(grid[y][x - 1].code);
      if (x < gridW - 1 && grid[y][x + 1]) nb.push(grid[y][x + 1].code);
      if (nb.length >= 3 && !nb.includes(cur.code)) {
        // 四邻里出现次数最多的颜色
        const cnt = {};
        nb.forEach((c) => (cnt[c] = (cnt[c] || 0) + 1));
        const dom = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
        changed.push([x, y, dom]);
      }
    }
  }
  for (const [x, y, code] of changed) grid[y][x] = PALETTE.find((p) => p.code === code);
}

/* ---------- 渲染：效果预览（圆形豆+高光） ---------- */
function renderPreview() {
  const cell = Math.max(8, Math.min(24, Math.floor(640 / Math.max(gridW, gridH))));
  previewCanvas.width = gridW * cell;
  previewCanvas.height = gridH * cell;
  const ctx = previewCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  const r = cell * 0.46;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const b = grid[y][x];
      if (!b) continue;
      const cx = x * cell + cell / 2, cy = y * cell + cell / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = b.hex;
      ctx.fill();
      // 左上高光，模拟豆子的塑料反光
      ctx.beginPath();
      ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,.45)";
      ctx.fill();
    }
  }
  previewCanvas.hidden = false;
  patternCanvas.hidden = true;
}

/* ---------- 渲染：图纸（网格线+色号标注） ---------- */
function renderPattern() {
  const cell = 30, margin = 30, infoH = 46;
  patternCanvas.width = gridW * cell + margin + 4;
  patternCanvas.height = gridH * cell + margin + infoH + 4;
  const ctx = patternCanvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, patternCanvas.width, patternCanvas.height);

  // 格子底色
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const b = grid[y][x];
      ctx.fillStyle = b ? b.hex : "#f2f2f2";
      ctx.fillRect(margin + x * cell, margin + y * cell, cell, cell);
    }
  }

  // 网格线：细线每格，粗线每 10 格
  ctx.strokeStyle = "#cccccc";
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridW; i++) {
    ctx.beginPath();
    ctx.moveTo(margin + i * cell + 0.5, margin);
    ctx.lineTo(margin + i * cell + 0.5, margin + gridH * cell);
    ctx.stroke();
  }
  for (let j = 0; j <= gridH; j++) {
    ctx.beginPath();
    ctx.moveTo(margin, margin + j * cell + 0.5);
    ctx.lineTo(margin + gridW * cell, margin + j * cell + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = "#555555";
  ctx.lineWidth = 2;
  for (let i = 0; i <= gridW; i += 10) {
    ctx.beginPath();
    ctx.moveTo(margin + i * cell, margin);
    ctx.lineTo(margin + i * cell, margin + gridH * cell);
    ctx.stroke();
  }
  for (let j = 0; j <= gridH; j += 10) {
    ctx.beginPath();
    ctx.moveTo(margin, margin + j * cell);
    ctx.lineTo(margin + gridW * cell, margin + j * cell);
    ctx.stroke();
  }

  // 行列坐标（每 5 格标一个）
  ctx.fillStyle = "#888888";
  ctx.font = "11px Consolas, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < gridW; i += 5) ctx.fillText(i + 1, margin + i * cell + cell / 2, margin / 2);
  ctx.textAlign = "right";
  for (let j = 0; j < gridH; j += 5) ctx.fillText(j + 1, margin - 6, margin + j * cell + cell / 2);

  // 色号标注（黑豆白字 / 浅豆黑字，按亮度自动选）
  ctx.font = "bold 11px Consolas, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const b = grid[y][x];
      if (!b) continue;
      const [r, g, bl] = b.rgb;
      const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
      ctx.fillStyle = lum < 140 ? "#ffffff" : "#222222";
      ctx.fillText(b.code.slice(1), margin + x * cell + cell / 2, margin + y * cell + cell / 2);
    }
  }

  // 图纸信息栏：打印后图纸自解释（尺寸/颗数/色数/日期）
  const list = countBeads();
  const total = list.reduce((s, i) => s + i.n, 0);
  const infoY = margin + gridH * cell + 28;
  ctx.fillStyle = "#333333";
  ctx.font = "bold 16px 'Microsoft YaHei', sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(
    `拼豆图纸  ${gridW}×${gridH}豆  共 ${total} 颗  ${list.length} 色  生成日期 ${new Date().toLocaleDateString("zh-CN")}`,
    margin, infoY
  );
  patternCanvas.hidden = false;
  previewCanvas.hidden = true;
}

/* ---------- 用豆量清单 ---------- */
function countBeads() {
  const cnt = new Map();
  for (const row of grid) {
    for (const b of row) {
      if (!b) continue;
      if (!cnt.has(b.code)) cnt.set(b.code, { bead: b, n: 0 });
      cnt.get(b.code).n++;
    }
  }
  return [...cnt.values()].sort((a, b) => b.n - a.n);
}

function renderBeadList() {
  const list = countBeads();
  const total = list.reduce((s, i) => s + i.n, 0);
  const buy = (n) => Math.ceil(n * 1.1);   // 含 10% 备损
  const totalBuy = list.reduce((s, i) => s + buy(i.n), 0);
  let html = `<tr><th></th><th>色号</th><th>颜色</th><th>数量（颗）</th><th>建议购买（含10%备损）</th></tr>`;
  for (const { bead, n } of list) {
    html += `<tr>
      <td style="background:${bead.hex}"></td>
      <td>${bead.code}</td><td>${bead.name}</td><td>${n}</td><td>${buy(n)}</td></tr>`;
  }
  html += `<tr><td></td><td colspan="2"><strong>合计</strong></td><td><strong>${total}</strong></td><td><strong>${totalBuy}</strong></td></tr>`;
  $("beadTable").innerHTML = html;
  $("beadList").classList.remove("hidden");
}

/* ---------- 导出 ---------- */
function download(canvas, filename) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  a.click();
}

function downloadCsv() {
  const list = countBeads();
  const buy = (n) => Math.ceil(n * 1.1);
  let csv = "\uFEFF色号,颜色,数量,建议购买\n";   // BOM 保证 Excel/WPS 中文不乱码
  for (const { bead, n } of list) csv += `${bead.code},${bead.name},${n},${buy(n)}\n`;
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "用豆量清单.csv";
  a.click();
}

/* ---------- 事件绑定 ---------- */
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => fileInput.files[0] && loadFile(fileInput.files[0]));

function loadFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    srcImage = img;
    $("generate").disabled = false;
    dropzone.querySelector("p").innerHTML = `<strong>已选择：${file.name}</strong><br><span class="hint">${img.width}×${img.height}px，点击可更换</span>`;
    // 上传后自动把高度按比例适配到当前宽度
    fitAspect();
  };
  img.src = url;
}

function fitAspect() {
  if (!srcImage) return;
  const cols = parseInt($("cols").value);
  $("rows").value = Math.max(5, Math.round((cols * srcImage.height) / srcImage.width));
}

$("fitAspect").addEventListener("click", fitAspect);
document.querySelectorAll(".presets button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [c, r] = btn.dataset.size.split(",").map(Number);
    $("cols").value = c; $("rows").value = r;
    if (srcImage) fitAspect();
  });
});
$("kColors").addEventListener("input", (e) => ($("kVal").textContent = e.target.value));
$("generate").addEventListener("click", generateGrid);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const showPattern = tab.dataset.tab === "pattern";
    patternCanvas.hidden = !showPattern || !gridW;
    previewCanvas.hidden = showPattern || !gridW;
  });
});

$("dlPattern").addEventListener("click", () => download(patternCanvas, "拼豆图纸.png"));
$("dlCsv").addEventListener("click", downloadCsv);
