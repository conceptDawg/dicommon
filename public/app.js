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

let currentColormap = 'jet';

// MRI Viewer - Client-side application
let seriesData = [];
let currentSeries = null;
let volume = null; // 3D array: volume[slice][row][col]
let volumeMeta = { rows: 0, cols: 0, numSlices: 0, windowCenter: 400, windowWidth: 1500, pixelSpacing: 0.3125, sliceThickness: 4.0 };

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

  // Set up sliders
  axialSlider.max = volumeMeta.numSlices - 1;
  axialSlider.value = Math.floor(volumeMeta.numSlices / 2);
  sagittalSlider.max = volumeMeta.cols - 1;
  sagittalSlider.value = Math.floor(volumeMeta.cols / 2);
  coronalSlider.max = volumeMeta.rows - 1;
  coronalSlider.value = Math.floor(volumeMeta.rows / 2);

  wcSlider.value = volumeMeta.windowCenter;
  wwSlider.value = volumeMeta.windowWidth;
  document.getElementById('wc-val').textContent = Math.round(volumeMeta.windowCenter);
  document.getElementById('ww-val').textContent = Math.round(volumeMeta.windowWidth);

  // Set aspect ratios for sagittal/coronal wraps based on actual data dimensions
  const ratio = volumeMeta.sliceThickness / volumeMeta.pixelSpacing;
  const interpSlices = Math.round((volumeMeta.numSlices - 1) * ratio) + 1;
  // Sagittal: width=interpSlices, height=rows
  document.getElementById('sagittal-wrap').style.aspectRatio = `${interpSlices} / ${volumeMeta.rows}`;
  // Coronal: width=cols, height=interpSlices
  document.getElementById('coronal-wrap').style.aspectRatio = `${volumeMeta.cols} / ${interpSlices}`;

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

function renderAxial() {
  if (!volume) return;
  const idx = parseInt(axialSlider.value);
  const { rows, cols } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);

  axialCanvas.width = cols;
  axialCanvas.height = rows;
  const ctx = axialCanvas.getContext('2d');
  const imgData = ctx.createImageData(cols, rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = applyWindow(volume[idx][r][c], wc, ww);
      const p = (r * cols + c) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('axial-info').textContent = `${idx + 1}/${volumeMeta.numSlices}`;
}

function renderSagittal() {
  if (!volume) return;
  const col = parseInt(sagittalSlider.value);
  const { rows, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);

  // Upsample slice axis to match in-plane resolution
  const ratio = sliceThickness / pixelSpacing; // ~12.8
  const interpSlices = Math.round((numSlices - 1) * ratio) + 1;

  sagittalCanvas.width = interpSlices;
  sagittalCanvas.height = rows;
  const ctx = sagittalCanvas.getContext('2d');
  const imgData = ctx.createImageData(interpSlices, rows);

  for (let r = 0; r < rows; r++) {
    for (let si = 0; si < interpSlices; si++) {
      // Map interpolated index back to original slice space
      const origPos = si / ratio;
      const s0 = Math.floor(origPos);
      const s1 = Math.min(s0 + 1, numSlices - 1);
      const frac = origPos - s0;
      const val = volume[s0][r][col] * (1 - frac) + volume[s1][r][col] * frac;
      const v = applyWindow(val, wc, ww);
      const p = (r * interpSlices + si) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('sagittal-info').textContent = `${col + 1}/${volumeMeta.cols}`;
}

function renderCoronal() {
  if (!volume) return;
  const row = parseInt(coronalSlider.value);
  const { cols, numSlices, pixelSpacing, sliceThickness } = volumeMeta;
  const wc = parseFloat(wcSlider.value);
  const ww = parseFloat(wwSlider.value);

  // Upsample slice axis to match in-plane resolution
  const ratio = sliceThickness / pixelSpacing; // ~12.8
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
      const val = volume[s0][row][c] * (1 - frac) + volume[s1][row][c] * frac;
      const v = applyWindow(val, wc, ww);
      const p = (si * cols + c) * 4;
      applyColormap(imgData, p, v);
    }
  }
  ctx.putImageData(imgData, 0, 0);
  document.getElementById('coronal-info').textContent = `${row + 1}/${volumeMeta.rows}`;
}

function renderAll() {
  renderAxial();
  renderSagittal();
  renderCoronal();
}

// Event listeners
axialSlider.addEventListener('input', renderAxial);
sagittalSlider.addEventListener('input', renderSagittal);
coronalSlider.addEventListener('input', renderCoronal);

wcSlider.addEventListener('input', () => {
  document.getElementById('wc-val').textContent = wcSlider.value;
  renderAll();
});
wwSlider.addEventListener('input', () => {
  document.getElementById('ww-val').textContent = wwSlider.value;
  renderAll();
});

document.getElementById('reset-wl').addEventListener('click', () => {
  wcSlider.value = volumeMeta.windowCenter;
  wwSlider.value = volumeMeta.windowWidth;
  document.getElementById('wc-val').textContent = Math.round(volumeMeta.windowCenter);
  document.getElementById('ww-val').textContent = Math.round(volumeMeta.windowWidth);
  renderAll();
});

document.getElementById('colormap-select').addEventListener('change', (e) => {
  currentColormap = e.target.value;
  renderAll();
});

// Window/Level presets
document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    wcSlider.value = btn.dataset.wc;
    wwSlider.value = btn.dataset.ww;
    document.getElementById('wc-val').textContent = btn.dataset.wc;
    document.getElementById('ww-val').textContent = btn.dataset.ww;
    renderAll();
  });
});

// Mouse wheel scrolling on canvases
axialCanvas.addEventListener('wheel', e => { e.preventDefault(); axialSlider.value = Math.max(0, Math.min(axialSlider.max, parseInt(axialSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderAxial(); });
sagittalCanvas.addEventListener('wheel', e => { e.preventDefault(); sagittalSlider.value = Math.max(0, Math.min(sagittalSlider.max, parseInt(sagittalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderSagittal(); });
coronalCanvas.addEventListener('wheel', e => { e.preventDefault(); coronalSlider.value = Math.max(0, Math.min(coronalSlider.max, parseInt(coronalSlider.value) + (e.deltaY > 0 ? 1 : -1))); renderCoronal(); });

init();
