// Colormap lookup tables (256 entries of [r, g, b])
const colormaps = {};

function buildLUT(name, fn) {
  const lut = new Array(256);
  for (let i = 0; i < 256; i++) lut[i] = fn(i / 255);
  colormaps[name] = lut;
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function piecewise(stops, t) {
  if (t <= 0) return stops[0][1];
  if (t >= 1) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      const f = (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      return lerp3(stops[i][1], stops[i + 1][1], f);
    }
  }
  return stops[stops.length - 1][1];
}

buildLUT('grayscale', t => [t * 255, t * 255, t * 255]);

buildLUT('hot', t => piecewise([
  [0, [0, 0, 0]], [0.375, [255, 0, 0]], [0.75, [255, 255, 0]], [1, [255, 255, 255]]
], t));

buildLUT('cool', t => [t * 255, (1 - t) * 255, 255]);

buildLUT('bone', t => {
  // Blue-gray tinted: mostly grayscale with slight blue shift in darks, slight yellow in brights
  const g = t * 255;
  return piecewise([
    [0, [0, 0, 0]], [0.375, [84, 84, 116]], [0.75, [168, 200, 200]], [1, [255, 255, 255]]
  ], t);
});

buildLUT('jet', t => piecewise([
  [0, [0, 0, 128]], [0.125, [0, 0, 255]], [0.375, [0, 255, 255]], [0.5, [0, 255, 0]],
  [0.625, [255, 255, 0]], [0.875, [255, 0, 0]], [1, [128, 0, 0]]
], t));

buildLUT('viridis', t => piecewise([
  [0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]],
  [0.75, [94, 201, 98]], [1, [253, 231, 37]]
], t));

buildLUT('inferno', t => piecewise([
  [0, [0, 0, 4]], [0.25, [87, 16, 110]], [0.5, [188, 55, 84]],
  [0.75, [249, 142, 9]], [1, [252, 255, 164]]
], t));

buildLUT('xray-neon', t => piecewise([
  [0, [0, 0, 0]],        // black background
  [0.1, [10, 20, 30]],   // very dark teal
  [0.25, [0, 60, 70]],   // deep teal
  [0.4, [0, 130, 140]],  // teal/cyan
  [0.55, [0, 190, 200]], // bright cyan
  [0.7, [200, 80, 20]],  // orange transition
  [0.82, [230, 50, 10]], // red-orange
  [0.9, [255, 140, 0]],  // orange
  [0.95, [255, 220, 60]],// yellow-orange
  [1, [255, 255, 200]]   // bright warm white
], t));

buildLUT('human', t => piecewise([
  [0, [0, 0, 0]],           // black background
  [0.08, [30, 5, 5]],       // very dark
  [0.15, [80, 20, 20]],     // deep dark red
  [0.25, [120, 40, 35]],    // dark muscle red
  [0.35, [150, 55, 50]],    // muscle red-pink
  [0.45, [165, 75, 65]],    // pinkish tissue
  [0.55, [175, 110, 85]],   // brownish connective
  [0.65, [190, 145, 110]],  // tan
  [0.75, [210, 180, 145]],  // light tan/bone edge
  [0.85, [230, 210, 180]],  // pale bone
  [0.92, [240, 230, 210]],  // cream
  [1, [250, 245, 230]],     // ivory white
], t));

let currentColormap = 'xray-neon';

// MRI Viewer - Client-side application
let seriesData = [];
let currentSeries = null;
let volume = null; // 3D array: volume[slice][row][col]
let volumeMeta = { rows: 0, cols: 0, numSlices: 0, windowCenter: 400, windowWidth: 1500, pixelSpacing: 0.3125, sliceThickness: 4.0 };

// MIP state
let mipEnabled = false;
let mipSlab = 5;

// Crosshair state
let crosshairsEnabled = false;

// Histogram cache
let histogramData = null;

const axialCanvas = document.getElementById('axial-canvas');
const sagittalCanvas = document.getElementById('sagittal-canvas');
const coronalCanvas = document.getElementById('coronal-canvas');
const axialSlider = document.getElementById('axial-slider');
const sagittalSlider = document.getElementById('sagittal-slider');
const coronalSlider = document.getElementById('coronal-slider');
const wcSlider = document.getElementById('wc-slider');
const wwSlider = document.getElementById('ww-slider');

async function init() {
  const res = await fetch('/api/series');
  seriesData = await res.json();
  renderSeriesList();
  if (seriesData.length > 0) {
    // Pick series with most files
    const best = seriesData.reduce((a, b) => a.fileCount > b.fileCount ? a : b);
    selectSeries(best.id);
  }
}

function renderSeriesList() {
  const el = document.getElementById('series-list');
  el.innerHTML = seriesData.map(s =>
    `<div class="series-item" data-id="${s.id}" onclick="selectSeries('${s.id}')">
      ${s.seriesDescription || s.id}
      <div class="count">${s.fileCount} slices · ${s.modality || '?'}</div>
    </div>`
  ).join('');
}

async function selectSeries(id) {
  document.querySelectorAll('.series-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  currentSeries = seriesData.find(s => s.id === id);
  showMetadata(currentSeries);
  await loadVolume(id);
}

function showMetadata(s) {
  if (!s) return;
  const info = document.getElementById('patient-info');
  info.textContent = `${s.patientName || 'Unknown'} · ${s.studyDescription || ''} · ${s.modality || ''}`;

  const md = document.getElementById('metadata-content');
  md.innerHTML = [
    ['Series', s.seriesDescription],
    ['Series #', s.seriesNumber],
    ['Modality', s.modality],
    ['Dimensions', `${s.rows}×${s.columns}`],
    ['Slice Thickness', s.sliceThickness ? s.sliceThickness + ' mm' : ''],
    ['Slices', s.fileCount],
    ['Patient ID', s.patientId],
  ].filter(([,v]) => v).map(([l,v]) => `<div><span class="label">${l}:</span> ${v}</div>`).join('');
}

async function loadVolume(seriesId) {
  const loading = document.getElementById('loading');
  const progress = document.getElementById('load-progress');
  loading.classList.remove('hidden');

  // Get sorted slice list
  const slicesRes = await fetch(`/api/series/${seriesId}/slices`);
  const slicesMeta = await slicesRes.json();

  volume = [];
  let meta = null;

  for (let i = 0; i < slicesMeta.length; i++) {
    progress.textContent = `${i + 1} / ${slicesMeta.length}`;
    const res = await fetch(`/api/parsed/${seriesId}/${slicesMeta[i].file}`);
    const data = await res.json();

    if (i === 0) {
      meta = data;
      volumeMeta.rows = data.rows;
      volumeMeta.cols = data.cols;
      volumeMeta.windowCenter = data.windowCenter || 400;
      volumeMeta.windowWidth = data.windowWidth || 1500;
      // Parse pixel spacing (row\col format)
      if (data.pixelSpacing) {
        const parts = data.pixelSpacing.split('\\');
        if (parts.length >= 2) volumeMeta.pixelSpacing = parseFloat(parts[0]);
      }
      if (data.sliceThickness) {
        volumeMeta.sliceThickness = data.sliceThickness;
      }
    }

    // Store as 2D array
    const slice = [];
    for (let r = 0; r < data.rows; r++) {
      const row = new Float32Array(data.cols);
      for (let c = 0; c < data.cols; c++) {
        const raw = data.pixels[r * data.cols + c];
        row[c] = raw * (data.rescaleSlope || 1) + (data.rescaleIntercept || 0);
      }
      slice.push(row);
    }
    volume.push(slice);
  }

  volumeMeta.numSlices = volume.length;
  loading.classList.add('hidden');

  // Set up sliders — axial uses interpolated slice count for smooth scrolling
  const ratio = volumeMeta.sliceThickness / volumeMeta.pixelSpacing;
  const interpSlicesZ = Math.round((volumeMeta.numSlices - 1) * ratio) + 1;
  volumeMeta.interpSlicesZ = interpSlicesZ;
  volumeMeta.zRatio = ratio;
  axialSlider.max = interpSlicesZ - 1;
  axialSlider.value = Math.floor(interpSlicesZ / 2);
  sagittalSlider.max = volumeMeta.cols - 1;
  sagittalSlider.value = Math.floor(volumeMeta.cols / 2);
  coronalSlider.max = volumeMeta.rows - 1;
  coronalSlider.value = Math.floor(volumeMeta.rows / 2);

  wcSlider.value = volumeMeta.windowCenter;
  wwSlider.value = volumeMeta.windowWidth;
  document.getElementById('wc-val').textContent = Math.round(volumeMeta.windowCenter);
  document.getElementById('ww-val').textContent = Math.round(volumeMeta.windowWidth);

  const interpSlices = Math.round((volumeMeta.numSlices - 1) * ratio) + 1;

  // Compute histogram for this volume
  computeHistogram();
  renderHistogram();

  renderAll();

  // Reinit 3D volume if available
  if (window._reinit3D) window._reinit3D();
}

function applyColormap(imgData, p, grayVal) {
  const idx = Math.round(Math.max(0, Math.min(255, grayVal)));
  const rgb = colormaps[currentColormap][idx];
  imgData.data[p] = rgb[0];
  imgData.data[p + 1] = rgb[1];
  imgData.data[p + 2] = rgb[2];
  imgData.data[p + 3] = 255;
}

function applyWindow(value, wc, ww) {
  const lower = wc - ww / 2;
  const upper = wc + ww / 2;
  if (value <= lower) return 0;
  if (value >= upper) return 255;
  return ((value - lower) / ww) * 255;
}

function mipValue(centerSlice, r, c, halfSlab, axis) {
  // axis: 'axial' = iterate z, 'sagittal' = iterate c (col), 'coronal' = iterate r (row)
  if (!mipEnabled) {
    if (axis === 'axial') return volume[centerSlice][r][c];
    if (axis === 'sagittal') return volume[centerSlice][r][c];
    return volume[centerSlice][r][c];
  }
  let maxVal = -Infinity;
  if (axis === 'axial') {
    const lo = Math.max(0, centerSlice - halfSlab);
    const hi = Math.min(volumeMeta.numSlices - 1, centerSlice + halfSlab);
    for (let z = lo; z <= hi; z++) { const v = volume[z][r][c]; if (v > maxVal) maxVal = v; }
  } else if (axis === 'sagittal') {
    const lo = Math.max(0, c - halfSlab);
    const hi = Math.min(volumeMeta.cols - 1, c + halfSlab);
    for (let cc = lo; cc <= hi; cc++) { const v = volume[centerSlice][r][cc]; if (v > maxVal) maxVal = v; }
  } else { // coronal
    const lo = Math.max(0, r - halfSlab);
    const hi = Math.min(volumeMeta.rows - 1, r + halfSlab);
    for (let rr = lo; rr <= hi; rr++) { const v = volume[centerSlice][rr][c]; if (v > maxVal) maxVal = v; }
  }
  return maxVal;
}

function renderAxial() {
  if (!volume) return;
  const interpIdx = parseInt(axialSlider.value);
  const { rows, cols, numSlices, zRatio } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = mipEnabled ? Math.floor(mipSlab / 2) : 0;

  // Map interpolated index back to original slice space
  const origPos = interpIdx / zRatio;
  const s0 = Math.floor(origPos);
  const s1 = Math.min(s0 + 1, numSlices - 1);
  const frac = origPos - s0;

  axialCanvas.width = cols;
  axialCanvas.height = rows;
  const ctx = axialCanvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let raw;
      if (mipEnabled) {
        // MIP in original slice space
        const centerSlice = Math.round(origPos);
        raw = mipValue(centerSlice, r, c, halfSlab, 'axial');
      } else {
        // Linear interpolation between adjacent slices
        raw = volume[s0][r][c] * (1 - frac) + volume[s1][r][c] * frac;
      }
      const v = applyWindow(raw, wc, ww);
      const p = (r * cols + c) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  const realSlice = Math.round(origPos);
  document.getElementById('axial-info').textContent = `${realSlice + 1}/${numSlices} (${interpIdx + 1}/${volumeMeta.interpSlicesZ})`;
  drawCrosshairs();
}

function renderSagittal() {
  if (!volume) return;
  const col = parseInt(sagittalSlider.value);
  const { rows, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = mipEnabled ? Math.floor(mipSlab / 2) : 0;

  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  sagittalCanvas.width = interpSlices;
  sagittalCanvas.height = rows;
  const ctx = sagittalCanvas.getContext('2d');
  const imgData = ctx.createImageData(interpSlices, rows);

  for (let r = 0; r < rows; r++) {
    for (let si = 0; si < interpSlices; si++) {
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      let val;
      if (mipEnabled) {
        // MIP across column axis
        let maxVal = -Infinity;
        const lo = Math.max(0, col - halfSlab);
        const hi = Math.min(volumeMeta.cols - 1, col + halfSlab);
        for (let cc = lo; cc <= hi; cc++) {
          const v0 = volume[s0][r][cc] * (1 - frac) + volume[s1][r][cc] * frac;
          if (v0 > maxVal) maxVal = v0;
        }
        val = maxVal;
      } else {
        val = volume[s0][r][col] * (1 - frac) + volume[s1][r][col] * frac;
      }
      const v = applyWindow(val, wc, ww);
      const p = (r * interpSlices + si) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('sagittal-info').textContent = `${col + 1}/${volumeMeta.cols}`;
  drawCrosshairs();
}

function renderCoronal() {
  if (!volume) return;
  const row = parseInt(coronalSlider.value);
  const { cols, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const halfSlab = mipEnabled ? Math.floor(mipSlab / 2) : 0;

  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  coronalCanvas.width = cols;
  coronalCanvas.height = interpSlices;
  const ctx = coronalCanvas.getContext('2d');
  const imgData = ctx.createImageData(cols, interpSlices);

  for (let si = 0; si < interpSlices; si++) {
    const origPos = si / ratio;
    const s0 = Math.floor(origPos);
    const s1 = Math.min(s0 + 1, numSlices - 1);
    const frac = origPos - s0;
    for (let c = 0; c < cols; c++) {
      let val;
      if (mipEnabled) {
        let maxVal = -Infinity;
        const lo = Math.max(0, row - halfSlab);
        const hi = Math.min(volumeMeta.rows - 1, row + halfSlab);
        for (let rr = lo; rr <= hi; rr++) {
          const v0 = volume[s0][rr][c] * (1 - frac) + volume[s1][rr][c] * frac;
          if (v0 > maxVal) maxVal = v0;
        }
        val = maxVal;
      } else {
        val = volume[s0][row][c] * (1 - frac) + volume[s1][row][c] * frac;
      }
      const v = applyWindow(val, wc, ww);
      const p = (si * cols + c) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('coronal-info').textContent = `${row + 1}/${volumeMeta.rows}`;
  drawCrosshairs();
}

function renderAll() {
  renderAxial();
  renderSagittal();
  renderCoronal();
  if (window._updateSlicePlanePositions) window._updateSlicePlanePositions();
}

// ==================== CROSSHAIRS ====================

function drawCrosshairs() {
  if (!crosshairsEnabled || !volume) return;
  const sagCol = parseInt(sagittalSlider.value);
  const corRow = parseInt(coronalSlider.value);
  const axSlice = parseInt(axialSlider.value);
  const { rows, cols, numSlices, sliceThickness, pixelSpacing } = volumeMeta;
  const ratio = sliceThickness / pixelSpacing;
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  // Axial: x=col, y=row — cyan vertical for sagittal, orange horizontal for coronal
  {
    const ctx = axialCanvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = 'rgba(0,200,255,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sagCol + 0.5, 0); ctx.lineTo(sagCol + 0.5, rows); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,100,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, corRow + 0.5); ctx.lineTo(cols, corRow + 0.5); ctx.stroke();
    ctx.restore();
  }

  // Sagittal: x=interpSlice, y=row — yellow vertical for axial, orange horizontal for coronal
  {
    const ctx = sagittalCanvas.getContext('2d');
    const interpX = axSlice; // axSlice is already in interpolated space
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,0,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(interpX + 0.5, 0); ctx.lineTo(interpX + 0.5, rows); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,100,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, corRow + 0.5); ctx.lineTo(interpSlices, corRow + 0.5); ctx.stroke();
    ctx.restore();
  }

  // Coronal: x=col, y=interpSlice — cyan vertical for sagittal, yellow horizontal for axial
  {
    const ctx = coronalCanvas.getContext('2d');
    const interpY = axSlice; // already in interpolated space
    ctx.save();
    ctx.strokeStyle = 'rgba(0,200,255,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sagCol + 0.5, 0); ctx.lineTo(sagCol + 0.5, interpSlices); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,0,0.7)';
    ctx.beginPath(); ctx.moveTo(0, interpY + 0.5); ctx.lineTo(cols, interpY + 0.5); ctx.stroke();
    ctx.restore();
  }
}

function canvasClickToVoxel(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const cx = (e.clientX - rect.left) / rect.width * canvas.width;
  const cy = (e.clientY - rect.top) / rect.height * canvas.height;
  return { cx, cy };
}

axialCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(axialCanvas, e);
  sagittalSlider.value = Math.round(Math.max(0, Math.min(volumeMeta.cols - 1, cx)));
  coronalSlider.value = Math.round(Math.max(0, Math.min(volumeMeta.rows - 1, cy)));
  renderAll();
});

sagittalCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(sagittalCanvas, e);
  axialSlider.value = Math.round(Math.max(0, Math.min(axialSlider.max, cx)));
  coronalSlider.value = Math.round(Math.max(0, Math.min(volumeMeta.rows - 1, cy)));
  renderAll();
});

coronalCanvas.addEventListener('click', (e) => {
  if (!volume) return;
  const { cx, cy } = canvasClickToVoxel(coronalCanvas, e);
  sagittalSlider.value = Math.round(Math.max(0, Math.min(volumeMeta.cols - 1, cx)));
  axialSlider.value = Math.round(Math.max(0, Math.min(axialSlider.max, cy)));
  renderAll();
});

document.getElementById('crosshair-checkbox').addEventListener('change', (e) => {
  crosshairsEnabled = e.target.checked;
  renderAll();
  // Sync 3D crosshairs
  const sp = document.getElementById('show-slice-planes');
  if (sp && sp.checked !== e.target.checked) {
    sp.checked = e.target.checked;
    sp.dispatchEvent(new Event('change'));
  }
});

// ==================== HISTOGRAM ====================

function computeHistogram() {
  if (!volume) return;
  const bins = new Float64Array(256);
  const { rows, cols, numSlices } = volumeMeta;
  let minVal = Infinity, maxVal = -Infinity;
  // First pass: find range (sampled)
  for (let z = 0; z < numSlices; z += 2) {
    for (let r = 0; r < rows; r += 2) {
      for (let c = 0; c < cols; c += 2) {
        const v = volume[z][r][c];
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }
  }
  volumeMeta._histMin = minVal;
  volumeMeta._histMax = maxVal;
  const range = maxVal - minVal || 1;
  // Second pass: bin
  for (let z = 0; z < numSlices; z += 2) {
    for (let r = 0; r < rows; r += 2) {
      for (let c = 0; c < cols; c += 2) {
        const bin = Math.max(0, Math.min(255, Math.round(((volume[z][r][c] - minVal) / range) * 255)));
        bins[bin]++;
      }
    }
  }
  histogramData = bins;
}

function renderHistogram() {
  const canvas = document.getElementById('histogram-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);

  if (!histogramData) return;
  const hMin = volumeMeta._histMin || 0;
  const hMax = volumeMeta._histMax || 1;
  const range = hMax - hMin || 1;

  // Find max count (skip bin 0 which is often background)
  let maxCount = 0;
  for (let i = 1; i < 256; i++) if (histogramData[i] > maxCount) maxCount = histogramData[i];
  if (maxCount === 0) return;

  // Draw window range highlight
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);
  const lo = ((wc - ww / 2 - hMin) / range) * w;
  const hi = ((wc + ww / 2 - hMin) / range) * w;
  ctx.fillStyle = 'rgba(233, 69, 96, 0.25)';
  ctx.fillRect(Math.max(0, lo), 0, Math.min(w, hi) - Math.max(0, lo), h);

  // Draw bars (log scale for better visibility), colored by colormap
  const barW = w / 256;
  const logMax = Math.log(maxCount + 1);
  const winLo = wc - ww / 2;
  const winHi = wc + ww / 2;
  const lut = colormaps[currentColormap];
  for (let i = 0; i < 256; i++) {
    const barH = (Math.log(histogramData[i] + 1) / logMax) * h * 0.9;
    // Map this bin's intensity to the window range, then to colormap
    const rawIntensity = hMin + (i / 255) * range;
    const windowed = Math.max(0, Math.min(255, ((rawIntensity - winLo) / (winHi - winLo)) * 255));
    const ci = Math.round(windowed);
    const rgb = lut[Math.min(255, Math.max(0, ci))];
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(i * barW, h - barH, Math.max(barW - 0.5, 1), barH);
  }

  // Draw window edges as draggable handles
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  if (lo >= 0 && lo <= w) { ctx.beginPath(); ctx.moveTo(lo, 0); ctx.lineTo(lo, h); ctx.stroke(); }
  if (hi >= 0 && hi <= w) { ctx.beginPath(); ctx.moveTo(hi, 0); ctx.lineTo(hi, h); ctx.stroke(); }

  // Draw small triangles at top of edges as grab indicators
  ctx.fillStyle = '#fff';
  if (lo >= 0 && lo <= w) { ctx.beginPath(); ctx.moveTo(lo - 5, 0); ctx.lineTo(lo + 5, 0); ctx.lineTo(lo, 8); ctx.fill(); }
  if (hi >= 0 && hi <= w) { ctx.beginPath(); ctx.moveTo(hi - 5, 0); ctx.lineTo(hi + 5, 0); ctx.lineTo(hi, 8); ctx.fill(); }
}

// Interactive histogram — drag edges to control window
(function() {
  const hCanvas = document.getElementById('histogram-canvas');
  if (!hCanvas) return;
  let dragMode = null; // 'lo', 'hi', 'center'
  let dragStartX = 0, dragStartWC = 0, dragStartWW = 0;

  function getCSSWidth() { return hCanvas.getBoundingClientRect().width; }

  function xToIntensity(x) {
    const hMin = volumeMeta._histMin || 0;
    const hMax = volumeMeta._histMax || 1;
    return hMin + (x / getCSSWidth()) * (hMax - hMin);
  }

  function getEdgePositions() {
    const hMin = volumeMeta._histMin || 0;
    const hMax = volumeMeta._histMax || 1;
    const range = hMax - hMin || 1;
    const cw = getCSSWidth();
    const wc = parseFloat(wcSlider.value);
    const ww = parseFloat(wwSlider.value);
    const lo = ((wc - ww / 2 - hMin) / range) * cw;
    const hi = ((wc + ww / 2 - hMin) / range) * cw;
    return { lo, hi };
  }

  hCanvas.addEventListener('mousedown', (e) => {
    const rect = hCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { lo, hi } = getEdgePositions();
    const tolerance = 8;

    if (Math.abs(x - lo) < tolerance) dragMode = 'lo';
    else if (Math.abs(x - hi) < tolerance) dragMode = 'hi';
    else if (x > lo && x < hi) dragMode = 'center';
    else return;

    dragStartX = x;
    dragStartWC = parseFloat(wcSlider.value);
    dragStartWW = parseFloat(wwSlider.value);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragMode) {
      // Update cursor
      const rect = hCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const { lo, hi } = getEdgePositions();
      if (Math.abs(x - lo) < 8 || Math.abs(x - hi) < 8) hCanvas.style.cursor = 'ew-resize';
      else if (x > lo && x < hi) hCanvas.style.cursor = 'grab';
      else hCanvas.style.cursor = 'default';
      return;
    }

    const rect = hCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const deltaIntensity = xToIntensity(x) - xToIntensity(dragStartX);

    const hMin = volumeMeta._histMin || 0;
    const hMax = volumeMeta._histMax || 1;

    if (dragMode === 'lo') {
      // Move low edge: adjust center and width, clamp to left edge
      const newLo = Math.max(hMin, (dragStartWC - dragStartWW / 2) + deltaIntensity);
      const hi = dragStartWC + dragStartWW / 2;
      const newWW = Math.max(10, hi - newLo);
      const newWC = newLo + newWW / 2;
      wcSlider.value = Math.round(newWC);
      wwSlider.value = Math.round(newWW);
    } else if (dragMode === 'hi') {
      // Move high edge, clamp to right edge
      const lo = dragStartWC - dragStartWW / 2;
      const newHi = Math.min(hMax, (dragStartWC + dragStartWW / 2) + deltaIntensity);
      const newWW = Math.max(10, newHi - lo);
      const newWC = lo + newWW / 2;
      wcSlider.value = Math.round(newWC);
      wwSlider.value = Math.round(newWW);
    } else if (dragMode === 'center') {
      // Shift entire window
      const newWC = dragStartWC + deltaIntensity;
      wcSlider.value = Math.round(newWC);
    }

    document.getElementById('wc-val').textContent = wcSlider.value;
    document.getElementById('ww-val').textContent = wwSlider.value;
    wcSlider.dispatchEvent(new Event('input'));
    renderAll();
    renderHistogram();
  });

  window.addEventListener('mouseup', () => { dragMode = null; });
})();

// ==================== MIP ====================

document.getElementById('mip-checkbox').addEventListener('change', (e) => {
  mipEnabled = e.target.checked;
  const slabSlider = document.getElementById('mip-slab');
  slabSlider.disabled = !mipEnabled;
  if (mipEnabled && volume) {
    const maxSlab = Math.min(volumeMeta.numSlices, volumeMeta.rows, volumeMeta.cols);
    slabSlider.max = maxSlab;
    if (mipSlab < 3) { mipSlab = 5; slabSlider.value = 5; document.getElementById('mip-slab-val').textContent = '5'; }
  }
  console.log('MIP toggled:', mipEnabled, 'slab:', mipSlab);
  renderAll();
});

document.getElementById('mip-slab').addEventListener('input', (e) => {
  mipSlab = parseInt(e.target.value);
  document.getElementById('mip-slab-val').textContent = mipSlab;
  renderAll();
});

// ==================== EVENT LISTENERS ====================

axialSlider.addEventListener('input', renderAll);
sagittalSlider.addEventListener('input', renderAll);
coronalSlider.addEventListener('input', renderAll);

wcSlider.addEventListener('input', () => {
  document.getElementById('wc-val').textContent = wcSlider.value;
  renderAll();
  renderHistogram();
});
wwSlider.addEventListener('input', () => {
  document.getElementById('ww-val').textContent = wwSlider.value;
  renderAll();
  renderHistogram();
});

document.getElementById('colormap-select').addEventListener('change', (e) => {
  currentColormap = e.target.value;
  renderAll();
  renderHistogram();
});

// Window/Level presets
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    wcSlider.value = btn.dataset.wc;
    wwSlider.value = btn.dataset.ww;
    document.getElementById('wc-val').textContent = btn.dataset.wc;
    document.getElementById('ww-val').textContent = btn.dataset.ww;
    renderAll();
    renderHistogram();
  });
});

// Mouse wheel scrolling on canvases
axialCanvas.addEventListener('wheel', e => { e.preventDefault(); axialSlider.value = Math.max(0, Math.min(axialSlider.max, parseInt(axialSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });
sagittalCanvas.addEventListener('wheel', e => { e.preventDefault(); sagittalSlider.value = Math.max(0, Math.min(sagittalSlider.max, parseInt(sagittalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });
coronalCanvas.addEventListener('wheel', e => { e.preventDefault(); coronalSlider.value = Math.max(0, Math.min(coronalSlider.max, parseInt(coronalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAll(); });

// --- Screenshot Export ---
document.getElementById('export-png').addEventListener('click', () => {
  const multiplier = parseInt(document.getElementById('export-res').value);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const seriesName = (currentSeries && (currentSeries.seriesDescription || currentSeries.id)) || 'unknown';
  const safeName = seriesName.replace(/[^a-zA-Z0-9_-]/g, '_');

  const panelCanvasMap = {
    'axial-panel': 'axial-canvas',
    'sagittal-panel': 'sagittal-canvas',
    'coronal-panel': 'coronal-canvas',
  };

  if (activePanel === 'volume3d-panel') {
    const dataUrl = window._export3DScreenshot && window._export3DScreenshot(multiplier);
    if (!dataUrl) return alert('3D view not initialized');
    downloadDataUrl(dataUrl, `dicommon-${safeName}-3d-${timestamp}.png`);
  } else {
    const canvasId = panelCanvasMap[activePanel];
    if (!canvasId) return;
    const srcCanvas = document.getElementById(canvasId);
    const w = srcCanvas.width * multiplier;
    const h = srcCanvas.height * multiplier;
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const ctx = offscreen.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const viewName = activePanel.replace('-panel', '');
    downloadDataUrl(offscreen.toDataURL('image/png'), `dicommon-${safeName}-${viewName}-${timestamp}.png`);
  }
});

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==================== BOOKMARKS ====================

const BOOKMARK_KEY = 'dicommon-bookmarks';

function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARK_KEY)) || {}; } catch { return {}; }
}

function saveBookmarks(all) {
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(all));
}

function getSeriesBookmarks() {
  if (!currentSeries) return [];
  const all = getBookmarks();
  return all[currentSeries.id] || [];
}

function setSeriesBookmarks(list) {
  if (!currentSeries) return;
  const all = getBookmarks();
  all[currentSeries.id] = list;
  saveBookmarks(all);
}

function captureViewState(name) {
  const ep2 = document.querySelector('#quad-view .expanded-panel');
  const is3D = ep2 && ep2.id === 'volume3d-panel';
  const state = {
    name,
    ts: Date.now(),
    seriesId: currentSeries ? currentSeries.id : null,
    mode: is3D ? '3d' : '2d',
    axial: parseInt(axialSlider.value),
    sagittal: parseInt(sagittalSlider.value),
    coronal: parseInt(coronalSlider.value),
    wc: parseFloat(wcSlider.value),
    ww: parseFloat(wwSlider.value),
    colormap: currentColormap,
    mipEnabled,
    mipSlab,
    crosshairsEnabled,
  };
  if (window._get3DState) {
    state.vol3d = window._get3DState();
  }
  return state;
}

function restoreViewState(state) {
  // Slice positions
  axialSlider.value = state.axial;
  sagittalSlider.value = state.sagittal;
  coronalSlider.value = state.coronal;

  // Window/level
  wcSlider.value = state.wc;
  wwSlider.value = state.ww;
  document.getElementById('wc-val').textContent = Math.round(state.wc);
  document.getElementById('ww-val').textContent = Math.round(state.ww);

  // Colormap
  currentColormap = state.colormap;
  document.getElementById('colormap-select').value = state.colormap;

  // MIP
  mipEnabled = state.mipEnabled;
  document.getElementById('mip-checkbox').checked = mipEnabled;
  document.getElementById('mip-slab').disabled = !mipEnabled;
  mipSlab = state.mipSlab;
  document.getElementById('mip-slab').value = mipSlab;
  document.getElementById('mip-slab-val').textContent = mipSlab;

  // Crosshairs
  crosshairsEnabled = state.crosshairsEnabled;
  document.getElementById('crosshair-checkbox').checked = crosshairsEnabled;

  // Restore 3D state if saved, otherwise reset to defaults
  if (window._set3DState) {
    setTimeout(() => window._set3DState(state.vol3d || null), 100);
  }

  // Trigger 3D texture rebuild for W/L changes
  wcSlider.dispatchEvent(new Event('input'));

  // Rebuild 3D colormap texture (always, even without vol3d state)
  if (window._rebuild3DColormap) window._rebuild3DColormap();

  renderAll();
  renderHistogram();
}

function renderBookmarkList() {
  const list = getSeriesBookmarks();
  const el = document.getElementById('bookmark-list');
  el.innerHTML = list.map((bk, i) =>
    `<div class="bookmark-chip" data-idx="${i}">
      <span class="bk-name" title="${bk.name}">${bk.mode === '3d' ? '🧊' : '🔲'} ${bk.name}</span>
      <button class="bk-delete" data-idx="${i}" title="Delete">×</button>
    </div>`
  ).join('');

  // Click to restore
  el.querySelectorAll('.bookmark-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('bk-delete')) return;
      const idx = parseInt(chip.dataset.idx);
      restoreViewState(list[idx]);
    });
  });

  // Delete
  el.querySelectorAll('.bk-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      list.splice(idx, 1);
      setSeriesBookmarks(list);
      renderBookmarkList();
    });
  });
}

// Save button -> modal
document.getElementById('save-bookmark-btn').addEventListener('click', () => {
  if (!currentSeries || !volume) return;
  const modal = document.getElementById('bookmark-modal');
  const input = document.getElementById('bookmark-name-input');
  modal.classList.add('visible');
  input.value = '';
  input.focus();
});

document.getElementById('bookmark-cancel').addEventListener('click', () => {
  document.getElementById('bookmark-modal').classList.remove('visible');
});

document.getElementById('bookmark-save').addEventListener('click', () => {
  const input = document.getElementById('bookmark-name-input');
  const name = input.value.trim() || `View ${getSeriesBookmarks().length + 1}`;
  const state = captureViewState(name);
  const list = getSeriesBookmarks();
  list.push(state);
  setSeriesBookmarks(list);
  renderBookmarkList();
  document.getElementById('bookmark-modal').classList.remove('visible');
});

document.getElementById('bookmark-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('bookmark-save').click();
  if (e.key === 'Escape') document.getElementById('bookmark-cancel').click();
});

// Refresh bookmark list when series changes
const _origSelectSeriesForBookmarks = selectSeries;
// We can't easily override, so hook into renderAll to refresh bookmarks
const _origRenderAllForBookmarks = renderAll;
// Just call renderBookmarkList after loadVolume completes — hook via MutationObserver on loading
const _loadingEl = document.getElementById('loading');
new MutationObserver(() => {
  if (_loadingEl.classList.contains('hidden') && currentSeries) {
    renderBookmarkList();
  }
}).observe(_loadingEl, { attributes: true, attributeFilter: ['class'] });

// --- Layout Selector ---
document.querySelectorAll('.layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const quadView = document.getElementById('quad-view');
    const layout = btn.dataset.layout;

    // Remove all layout classes and expanded state
    quadView.classList.remove('layout-3plus1', 'layout-ax3d', 'expanded');
    quadView.style.gridTemplateColumns = ''; // reset custom divider position
    quadView.style.gridTemplateRows = '';
    document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('expanded-panel'));

    if (layout === '3plus1') quadView.classList.add('layout-3plus1');
    else if (layout === 'ax3d') quadView.classList.add('layout-ax3d');

    // Resize 3D after layout change
    if (window._resize3D) setTimeout(window._resize3D, 50);
  });
});

// --- Draggable View Dividers ---
(function() {
  const quadView = document.getElementById('quad-view');
  const divV = document.getElementById('view-divider');
  const divH = document.getElementById('view-divider-h');
  const divV2 = document.getElementById('view-divider-v2');
  let activeDivider = null;
  let dividerType = null; // 'col' or 'row'

  // Track current split percentages for 3+1
  let splitV = 50;   // vertical: left vs 3D
  let splitH = 66;   // horizontal: axial vs bottom
  let splitV2 = 33;  // vertical: sagittal vs coronal (within left)

  function startDrag(el, type, e) {
    activeDivider = el;
    dividerType = type;
    el.classList.add('dragging');
    document.body.style.cursor = type === 'col' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  divV.addEventListener('mousedown', (e) => startDrag(divV, 'col', e));
  divH.addEventListener('mousedown', (e) => startDrag(divH, 'row', e));
  divV2.addEventListener('mousedown', (e) => startDrag(divV2, 'col', e));

  window.addEventListener('mousemove', (e) => {
    if (!activeDivider) return;
    const rect = quadView.getBoundingClientRect();
    const is3plus1 = quadView.classList.contains('layout-3plus1');
    const isAx3d = quadView.classList.contains('layout-ax3d');

    if (isAx3d && activeDivider === divV) {
      const pct = Math.max(15, Math.min(85, ((e.clientX - rect.left) / rect.width) * 100));
      quadView.style.gridTemplateColumns = `${pct}% 4px 1fr`;
      if (window._resize3D) window._resize3D();
    }

    if (is3plus1) {
      if (activeDivider === divV) {
        // Main vertical: left section vs 3D
        splitV = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
        apply3plus1Grid();
      } else if (activeDivider === divH) {
        // Horizontal: axial height vs bottom
        splitH = Math.max(20, Math.min(85, ((e.clientY - rect.top) / rect.height) * 100));
        apply3plus1Grid();
      } else if (activeDivider === divV2) {
        // Sub-vertical: sagittal vs coronal within left section
        // Need to calculate relative to the left section width
        const leftPx = (splitV / 100) * rect.width;
        const relX = e.clientX - rect.left;
        splitV2 = Math.max(15, Math.min(85, (relX / leftPx) * 100));
        apply3plus1Grid();
      }
      if (window._resize3D) window._resize3D();
    }
  });

  function apply3plus1Grid() {
    const leftFr = splitV;
    const rightFr = 100 - splitV;
    const sagPct = splitV2;
    const corPct = 100 - splitV2;
    // Columns: sag | 4px | cor | 4px | 3D
    quadView.style.gridTemplateColumns = `${sagPct * leftFr / 100}fr 4px ${corPct * leftFr / 100}fr 4px ${rightFr}fr`;
    quadView.style.gridTemplateRows = `${splitH}fr 4px ${100 - splitH}fr`;
  }

  window.addEventListener('mouseup', () => {
    if (!activeDivider) return;
    activeDivider.classList.remove('dragging');
    activeDivider = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// --- Collapsible Metadata ---
document.getElementById('metadata-toggle').addEventListener('click', function() {
  const content = document.getElementById('metadata-content');
  this.classList.toggle('collapsed');
  content.style.display = this.classList.contains('collapsed') ? 'none' : 'block';
});

// --- Active Panel Selection ---
let activePanel = 'axial-panel';
document.querySelectorAll('#quad-view .view-panel').forEach(panel => {
  panel.addEventListener('mousedown', () => {
    document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('active-panel'));
    panel.classList.add('active-panel');
    activePanel = panel.id;
  });
});
// Default active
document.getElementById('axial-panel').classList.add('active-panel');

// --- Quad View Expand/Collapse ---
document.querySelectorAll('.expand-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const quadView = document.getElementById('quad-view');
    const panelId = btn.dataset.panel;
    const panel = document.getElementById(panelId);

    const crosshair3dToggle = document.querySelector('.crosshair-3d-toggle');
    if (quadView.classList.contains('expanded')) {
      // Collapse back to quad view
      quadView.classList.remove('expanded');
      document.querySelectorAll('#quad-view .view-panel').forEach(p => p.classList.remove('expanded-panel'));
      document.querySelectorAll('.expand-btn').forEach(b => b.textContent = '⛶');
      if (crosshair3dToggle) crosshair3dToggle.style.display = 'none';
      // Resize 3D after layout change
      if (window._resize3D) setTimeout(window._resize3D, 50);
    } else {
      // Expand this panel
      quadView.classList.add('expanded');
      panel.classList.add('expanded-panel');
      btn.textContent = '⛶'; // same icon, acts as collapse
      // Show crosshair toggle only when 3D is expanded
      if (crosshair3dToggle) crosshair3dToggle.style.display = (panelId === 'volume3d-panel') ? '' : 'none';
      // Resize 3D after layout change
      if (window._resize3D) setTimeout(window._resize3D, 50);
    }
  });
});

init();
