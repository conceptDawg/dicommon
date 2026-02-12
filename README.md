# Dicommon

A radiology-style DICOM MRI viewer with multi-planar 2D views, interactive 3D volume raycasting, and real-time Marching Cubes isosurface generation — all running in the browser.

![Stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Three.js-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

### Multi-Planar 2D Views
- **Axial, Sagittal, and Coronal** views with linear interpolation between slices
- **Click-to-navigate**: click any pixel in a 2D view to update the other two views' slice positions
- **MIP (Maximum Intensity Projection)**: toggle MIP with adjustable slab thickness
- **Crosshairs**: optional crosshair overlay synced between 2D and 3D views

### Window/Level Controls
- **Interactive histogram** with draggable window edges and center drag
- **Presets**: Soft Tissue, Bone, Fat, Brain, Full Range
- **Click-to-probe**: click a pixel in any 2D view to see its intensity value on the histogram and automatically set the 3D iso level

### Colormaps
9 built-in colormaps:
- Grayscale, Hot, Cool, Bone, Jet, Viridis, Inferno
- **X-Ray Neon** (default) — high-contrast neon palette
- **Human** — tissue-like warm tones

### 3D Volume Rendering
- **GPU raycasting** via custom GLSL shaders (Three.js)
- Threshold, opacity, and step count controls
- **MIP mode** in 3D with slab fraction control
- **Interactive clip planes**: 6 draggable wireframe clip planes with orange sphere handles
- **Slice plane overlays**: colored planes showing current 2D slice positions with draggable handles
- Mouse controls: drag to rotate, right-drag to pan, scroll to zoom

### 3D Solid Rendering (Marching Cubes)
- **Real-time isosurface extraction** using Marching Cubes algorithm
- **Progressive build**: watch the mesh assemble from the center outward in expanding spherical shells
- **Web Worker**: all computation runs off the main thread — UI stays responsive
- **Per-vertex colormap coloring**: mesh vertices colored by tissue intensity through the active colormap
- **Material presets**: Smooth (Phong), Flat, Bone (ivory), Metallic
- **Adjustable lighting** and opacity
- **Auto-rebuild**: changing the iso level automatically regenerates the mesh
- **2D click → iso level**: click a tissue type in any 2D view to set the isosurface threshold

### Layout Options
Three layout modes accessible from the header:
- **⊞ 4-Up**: 2×2 grid with all four panels
- **◫ 3+1**: Three orthogonal views on the left, 3D on the right (draggable dividers)
- **◧ Axial+3D**: Side-by-side axial and 3D views

Each panel can be **expanded** to full screen via the ⛶ button. Click a panel to make it the active panel (red border) for targeted PNG export.

### Additional Features
- **Bookmarks**: save and restore complete view states (slices, W/L, colormap, 3D camera/rotation/settings)
- **PNG Export**: export any panel at 1×, 2×, or 3× resolution
- **Series browser**: sidebar lists all DICOM series with slice counts; click to load
- **Patient metadata**: collapsible panel showing patient name, study date, modality, etc.
- **DPI-aware rendering**: all canvases and histogram scale correctly on Retina displays

## Tech Stack

- **Server**: Node.js + Express (serves DICOM files and static assets)
- **DICOM parsing**: [dicom-parser](https://github.com/cornerstonejs/dicomParser)
- **3D rendering**: [Three.js](https://threejs.org/) r160
- **Frontend**: Vanilla JavaScript — no frameworks, no build step
- **Web Workers**: volume texture rebuild and Marching Cubes run off-thread

## Getting Started

### Prerequisites
- Node.js 18+
- DICOM files in a directory

### Installation

```bash
git clone https://github.com/conceptDawg/dicommon.git
cd dicommon
npm install
```

### Adding DICOM Data

Place your DICOM files in a subdirectory. The server scans for directories containing `.dcm` files:

```
dicommon/
├── server.js
├── public/
└── YOUR_DICOM_DIR/     # e.g., 1000022B/
    ├── series1/
    │   ├── slice001.dcm
    │   ├── slice002.dcm
    │   └── ...
    └── series2/
        └── ...
```

### Running

```bash
npm start
```

Open [http://localhost:3080](http://localhost:3080) in your browser.

## Architecture

```
server.js              Express server, DICOM file scanning & serving
public/
  index.html           Main layout (sidebar, quad view, controls)
  style.css            Full styling (dark theme, grid layouts, responsive)
  app.js               Core app: series loading, 2D rendering, histogram,
                       colormaps, window/level, MIP, crosshairs, bookmarks,
                       layout management, export
  volume3d.js          3D volume raycaster (GLSL shaders) + Marching Cubes
                       solid renderer, slice planes, clip planes, controls
  volume-worker.js     Web Worker for volume texture rebuild (raycaster)
  marching-cubes-worker.js  Web Worker for progressive MC isosurface extraction
  marching-cubes.js    Standalone MC library (synchronous, used as fallback)
```

### Key Design Decisions

- **No build step**: everything runs directly in the browser. No webpack, no bundler.
- **Web Workers for heavy computation**: the 78M+ voxel texture rebuild and Marching Cubes extraction both run off-thread to keep the UI responsive.
- **Progressive MC rendering**: cubes are sorted by distance from center and processed in expanding shells, so the core anatomy appears first.
- **Per-vertex coloring**: MC mesh vertices carry their interpolated intensity value, enabling real-time colormap application without regeneration.
- **Dual 3D modes**: volume raycasting for translucent volumetric views, Marching Cubes for solid isosurface inspection — switchable via dropdown.

## Controls Quick Reference

| Action | Control |
|--------|---------|
| Navigate slices | Scroll on 2D panel or drag slider |
| Click-navigate | Click pixel in any 2D view |
| Window/Level | Drag histogram edges or center |
| Rotate 3D | Left-drag on 3D panel |
| Pan 3D | Right-drag on 3D panel |
| Zoom 3D | Scroll on 3D panel |
| Drag clip plane | Grab orange sphere handles |
| Drag slice plane | Grab colored sphere handles |
| Set iso from 2D | Click tissue in any 2D view |
| Expand panel | Click ⛶ button |
| Switch layout | Click ⊞ / ◫ / ◧ in header |

## License

MIT

## Author

Christopher Holland ([@conceptDawg](https://github.com/conceptDawg))
