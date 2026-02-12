// Marching Cubes Web Worker — processes slices and posts triangle batches
// Uses classic Marching Cubes lookup tables

// Edge table and triangle table (standard MC tables)
const EDGE_TABLE = [0x0,0x109,0x203,0x30a,0x406,0x50f,0x605,0x70c,0x80c,0x905,0xa0f,0xb06,0xc0a,0xd03,0xe09,0xf00,0x190,0x99,0x393,0x29a,0x596,0x49f,0x795,0x69c,0x99c,0x895,0xb9f,0xa96,0xd9a,0xc93,0xf99,0xe90,0x230,0x339,0x33,0x13a,0x636,0x73f,0x435,0x53c,0xa3c,0xb35,0x83f,0x936,0xe3a,0xf33,0xc39,0xd30,0x3a0,0x2a9,0x1a3,0xaa,0x7a6,0x6af,0x5a5,0x4ac,0xbac,0xaa5,0x9af,0x8a6,0xfaa,0xea3,0xda9,0xca0,0x460,0x569,0x663,0x76a,0x66,0x16f,0x265,0x36c,0xc6c,0xd65,0xe6f,0xf66,0x86a,0x963,0xa69,0xb60,0x5f0,0x4f9,0x7f3,0x6fa,0x1f6,0xff,0x3f5,0x2fc,0xdfc,0xcf5,0xfff,0xef6,0x9fa,0x8f3,0xbf9,0xaf0,0x650,0x759,0x453,0x55a,0x256,0x35f,0x55,0x15c,0xe5c,0xf55,0xc5f,0xd56,0xa5a,0xb53,0x859,0x950,0x7c0,0x6c9,0x5c3,0x4ca,0x3c6,0x2cf,0x1c5,0xcc,0xfcc,0xec5,0xdcf,0xcc6,0xbca,0xac3,0x9c9,0x8c0,0x8c0,0x9c9,0xac3,0xbca,0xcc6,0xdcf,0xec5,0xfcc,0xcc,0x1c5,0x2cf,0x3c6,0x4ca,0x5c3,0x6c9,0x7c0,0x950,0x859,0xb53,0xa5a,0xd56,0xc5f,0xf55,0xe5c,0x15c,0x55,0x35f,0x256,0x55a,0x453,0x759,0x650,0xaf0,0xbf9,0x8f3,0x9fa,0xef6,0xfff,0xcf5,0xdfc,0x2fc,0x3f5,0xff,0x1f6,0x6fa,0x7f3,0x4f9,0x5f0,0xb60,0xa69,0x963,0x86a,0xf66,0xe6f,0xd65,0xc6c,0x36c,0x265,0x16f,0x66,0x76a,0x663,0x569,0x460,0xca0,0xda9,0xea3,0xfaa,0x8a6,0x9af,0xaa5,0xbac,0x4ac,0x5a5,0x6af,0x7a6,0xaa,0x1a3,0x2a9,0x3a0,0xd30,0xc39,0xf33,0xe3a,0x936,0x83f,0xb35,0xa3c,0x53c,0x435,0x73f,0x636,0x13a,0x33,0x339,0x230,0xe90,0xf99,0xc93,0xd9a,0xa96,0xb9f,0x895,0x99c,0x69c,0x795,0x49f,0x596,0x29a,0x393,0x99,0x190,0xf00,0xe09,0xd03,0xc0a,0xb06,0xa0f,0x905,0x80c,0x70c,0x605,0x50f,0x406,0x30a,0x203,0x109,0x0];

const TRI_TABLE = [
[-1],
[0,8,3],
[0,1,9],
[1,8,3,9,8,1],
[1,2,10],
[0,8,3,1,2,10],
[9,2,10,0,2,9],
[2,8,3,2,10,8,10,9,8],
[3,11,2],
[0,11,2,8,11,0],
[1,9,0,2,3,11],
[1,11,2,1,9,11,9,8,11],
[3,10,1,11,10,3],
[0,10,1,0,8,10,8,11,10],
[3,9,0,3,11,9,11,10,9],
[9,8,10,10,8,11],
[4,7,8],
[4,3,0,7,3,4],
[0,1,9,8,4,7],
[4,1,9,4,7,1,7,3,1],
[1,2,10,8,4,7],
[3,4,7,3,0,4,1,2,10],
[9,2,10,9,0,2,8,4,7],
[2,10,9,2,9,7,2,7,3,7,9,4],
[8,4,7,3,11,2],
[11,4,7,11,2,4,2,0,4],
[9,0,1,8,4,7,2,3,11],
[4,7,11,9,4,11,9,11,2,9,2,1],
[3,10,1,3,11,10,7,8,4],
[1,11,10,1,4,11,1,0,4,7,11,4],
[4,7,8,9,0,11,9,11,10,11,0,3],
[4,7,11,4,11,9,9,11,10],
[9,5,4],
[9,5,4,0,8,3],
[0,5,4,1,5,0],
[8,5,4,8,3,5,3,1,5],
[1,2,10,9,5,4],
[3,0,8,1,2,10,4,9,5],
[5,2,10,5,4,2,4,0,2],
[2,10,5,3,2,5,3,5,4,3,4,8],
[9,5,4,2,3,11],
[0,11,2,0,8,11,4,9,5],
[0,5,4,0,1,5,2,3,11],
[2,1,5,2,5,8,2,8,11,4,8,5],
[10,3,11,10,1,3,9,5,4],
[4,9,5,0,8,1,8,10,1,8,11,10],
[5,4,0,5,0,11,5,11,10,11,0,3],
[5,4,8,5,8,10,10,8,11],
[9,7,8,5,7,9],
[9,3,0,9,5,3,5,7,3],
[0,7,8,0,1,7,1,5,7],
[1,5,3,3,5,7],
[9,7,8,9,5,7,10,1,2],
[10,1,2,9,5,0,5,3,0,5,7,3],
[8,0,2,8,2,5,8,5,7,10,5,2],
[2,10,5,2,5,3,3,5,7],
[7,9,5,7,8,9,3,11,2],
[9,5,7,9,7,2,9,2,0,2,7,11],
[2,3,11,0,1,8,1,7,8,1,5,7],
[11,2,1,11,1,7,7,1,5],
[9,5,8,8,5,7,10,1,3,10,3,11],
[5,7,0,5,0,9,7,11,0,1,0,10,11,10,0],
[11,10,0,11,0,3,10,5,0,8,0,7,5,7,0],
[11,10,5,7,11,5],
[10,6,5],
[0,8,3,5,10,6],
[9,0,1,5,10,6],
[1,8,3,1,9,8,5,10,6],
[1,6,5,2,6,1],
[1,6,5,1,2,6,3,0,8],
[9,6,5,9,0,6,0,2,6],
[5,9,8,5,8,2,5,2,6,3,2,8],
[2,3,11,10,6,5],
[11,0,8,11,2,0,10,6,5],
[0,1,9,2,3,11,5,10,6],
[5,10,6,1,9,2,9,11,2,9,8,11],
[6,3,11,6,5,3,5,1,3],
[0,8,11,0,11,5,0,5,1,5,11,6],
[3,11,6,0,3,6,0,6,5,0,5,9],
[6,5,9,6,9,11,11,9,8],
[5,10,6,4,7,8],
[4,3,0,4,7,3,6,5,10],
[1,9,0,5,10,6,8,4,7],
[10,6,5,1,9,7,1,7,3,7,9,4],
[6,1,2,6,5,1,4,7,8],
[1,2,5,5,2,6,3,0,4,3,4,7],
[8,4,7,9,0,5,0,6,5,0,2,6],
[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9],
[3,11,2,7,8,4,10,6,5],
[5,10,6,4,7,2,4,2,0,2,7,11],
[0,1,9,4,7,8,2,3,11,5,10,6],
[9,2,1,9,11,2,9,4,11,7,11,4,5,10,6],
[8,4,7,3,11,5,3,5,1,5,11,6],
[5,1,11,5,11,6,1,0,11,7,11,4,0,4,11],
[0,5,9,0,6,5,0,3,6,11,6,3,8,4,7],
[6,5,9,6,9,11,4,7,9,7,11,9],
[10,4,9,6,4,10],
[4,10,6,4,9,10,0,8,3],
[10,0,1,10,6,0,6,4,0],
[8,3,1,8,1,6,8,6,4,6,1,10],
[1,4,9,1,2,4,2,6,4],
[3,0,8,1,2,9,2,4,9,2,6,4],
[0,2,4,4,2,6],
[8,3,2,8,2,4,4,2,6],
[10,4,9,10,6,4,11,2,3],
[0,8,2,2,8,11,4,9,10,4,10,6],
[3,11,2,0,1,6,0,6,4,6,1,10],
[6,4,1,6,1,10,4,8,1,2,1,11,8,11,1],
[9,6,4,9,3,6,9,1,3,11,6,3],
[8,11,1,8,1,0,11,6,1,9,1,4,6,4,1],
[3,11,6,3,6,0,0,6,4],
[6,4,8,11,6,8],
[7,10,6,7,8,10,8,9,10],
[0,7,3,0,10,7,0,9,10,6,7,10],
[10,6,7,1,10,7,1,7,8,1,8,0],
[10,6,7,10,7,1,1,7,3],
[1,2,6,1,6,8,1,8,9,8,6,7],
[2,6,9,2,9,1,6,7,9,0,9,3,7,3,9],
[7,8,0,7,0,6,6,0,2],
[7,3,2,6,7,2],
[2,3,11,10,6,8,10,8,9,8,6,7],
[2,0,7,2,7,11,0,9,7,6,7,10,9,10,7],
[1,8,0,1,7,8,1,10,7,6,7,10,2,3,11],
[11,2,1,11,1,7,10,6,1,6,7,1],
[8,9,6,8,6,7,9,1,6,11,6,3,1,3,6],
[0,9,1,11,6,7],
[7,8,0,7,0,6,3,11,0,11,6,0],
[7,11,6],
[7,6,11],
[3,0,8,11,7,6],
[0,1,9,11,7,6],
[8,1,9,8,3,1,11,7,6],
[10,1,2,6,11,7],
[1,2,10,3,0,8,6,11,7],
[2,9,0,2,10,9,6,11,7],
[6,11,7,2,10,3,10,8,3,10,9,8],
[7,2,3,6,2,7],
[7,0,8,7,6,0,6,2,0],
[2,7,6,2,3,7,0,1,9],
[1,6,2,1,8,6,1,9,8,8,7,6],
[10,7,6,10,1,7,1,3,7],
[10,7,6,1,7,10,1,8,7,1,0,8],
[0,3,7,0,7,10,0,10,9,6,10,7],
[7,6,10,7,10,8,8,10,9],
[6,8,4,11,8,6],
[3,6,11,3,0,6,0,4,6],
[8,6,11,8,4,6,9,0,1],
[9,4,6,9,6,3,9,3,1,11,3,6],
[6,8,4,6,11,8,2,10,1],
[1,2,10,3,0,11,0,6,11,0,4,6],
[4,11,8,4,6,11,0,2,9,2,10,9],
[10,9,3,10,3,2,9,4,3,11,3,6,4,6,3],
[8,2,3,8,4,2,4,6,2],
[0,4,2,4,6,2],
[1,9,0,2,3,4,2,4,6,4,3,8],
[1,9,4,1,4,2,2,4,6],
[8,1,3,8,6,1,8,4,6,6,10,1],
[10,1,0,10,0,6,6,0,4],
[4,6,3,4,3,8,6,10,3,0,3,9,10,9,3],
[10,9,4,6,10,4],
[4,9,5,7,6,11],
[0,8,3,4,9,5,11,7,6],
[5,0,1,5,4,0,7,6,11],
[11,7,6,8,3,4,3,5,4,3,1,5],
[9,5,4,10,1,2,7,6,11],
[6,11,7,1,2,10,0,8,3,4,9,5],
[7,6,11,5,4,10,4,2,10,4,0,2],
[3,4,8,3,5,4,3,2,5,10,5,2,11,7,6],
[7,2,3,7,6,2,5,4,9],
[9,5,4,0,8,6,0,6,2,6,8,7],
[3,6,2,3,7,6,1,5,0,5,4,0],
[6,2,8,6,8,7,2,1,8,4,8,5,1,5,8],
[9,5,4,10,1,6,1,7,6,1,3,7],
[1,6,10,1,7,6,1,0,7,8,7,0,9,5,4],
[4,0,10,4,10,5,0,3,10,6,10,7,3,7,10],
[7,6,10,7,10,8,5,4,10,4,8,10],
[6,9,5,6,11,9,11,8,9],
[3,6,11,0,6,3,0,5,6,0,9,5],
[0,11,8,0,5,11,0,1,5,5,6,11],
[6,11,3,6,3,5,5,3,1],
[1,2,10,9,5,11,9,11,8,11,5,6],
[0,11,3,0,6,11,0,9,6,5,6,9,1,2,10],
[11,8,5,11,5,6,8,0,5,10,5,2,0,2,5],
[6,11,3,6,3,5,2,10,3,10,5,3],
[5,8,9,5,2,8,5,6,2,3,8,2],
[9,5,6,9,6,0,0,6,2],
[1,5,8,1,8,0,5,6,8,3,8,2,6,2,8],
[1,5,6,2,1,6],
[1,3,6,1,6,10,3,8,6,5,6,9,8,9,6],
[10,1,0,10,0,6,9,5,0,5,6,0],
[0,3,8,5,6,10],
[10,5,6],
[11,5,10,7,5,11],
[11,5,10,11,7,5,8,3,0],
[5,11,7,5,10,11,1,9,0],
[10,7,5,10,11,7,9,8,1,8,3,1],
[11,1,2,11,7,1,7,5,1],
[0,8,3,1,2,7,1,7,5,7,2,11],
[9,7,5,9,2,7,9,0,2,2,11,7],
[7,5,2,7,2,11,5,9,2,3,2,8,9,8,2],
[2,5,10,2,3,5,3,7,5],
[8,2,0,8,5,2,8,7,5,10,2,5],
[9,0,1,5,10,3,5,3,7,3,10,2],
[9,8,2,9,2,1,8,7,2,10,2,5,7,5,2],
[1,3,5,3,7,5],
[0,8,7,0,7,1,1,7,5],
[9,0,3,9,3,5,5,3,7],
[9,8,7,5,9,7],
[5,8,4,5,10,8,10,11,8],
[5,0,4,5,11,0,5,10,11,11,3,0],
[0,1,9,8,4,10,8,10,11,10,4,5],
[10,11,4,10,4,5,11,3,4,9,4,1,3,1,4],
[2,5,1,2,8,5,2,11,8,4,5,8],
[0,4,11,0,11,3,4,5,11,2,11,1,5,1,11],
[0,2,5,0,5,9,2,11,5,4,5,8,11,8,5],
[9,4,5,2,11,3],
[2,5,10,3,5,2,3,4,5,3,8,4],
[5,10,2,5,2,4,4,2,0],
[3,10,2,3,5,10,3,8,5,4,5,8,0,1,9],
[5,10,2,5,2,4,1,9,2,9,4,2],
[8,4,5,8,5,3,3,5,1],
[0,4,5,1,0,5],
[8,4,5,8,5,3,9,0,5,0,3,5],
[9,4,5],
[4,11,7,4,9,11,9,10,11],
[0,8,3,4,9,7,9,11,7,9,10,11],
[1,10,11,1,11,4,1,4,0,7,4,11],
[3,1,4,3,4,8,1,10,4,7,4,11,10,11,4],
[4,11,7,9,11,4,9,2,11,9,1,2],
[9,7,4,9,11,7,9,1,11,2,11,1,0,8,3],
[11,7,4,11,4,2,2,4,0],
[11,7,4,11,4,2,8,3,4,3,2,4],
[2,9,10,2,7,9,2,3,7,7,4,9],
[9,10,7,9,7,4,10,2,7,8,7,0,2,0,7],
[3,7,10,3,10,2,7,4,10,1,10,0,4,0,10],
[1,10,2,8,7,4],
[4,9,1,4,1,7,7,1,3],
[4,9,1,4,1,7,0,8,1,8,7,1],
[4,0,3,7,4,3],
[4,8,7],
[9,10,8,10,11,8],
[3,0,9,3,9,11,11,9,10],
[0,1,10,0,10,8,8,10,11],
[3,1,10,11,3,10],
[1,2,11,1,11,9,9,11,8],
[3,0,9,3,9,11,1,2,9,2,11,9],
[0,2,11,8,0,11],
[3,2,11],
[2,3,8,2,8,10,10,8,9],
[9,10,2,0,9,2],
[2,3,8,2,8,10,0,1,8,1,10,8],
[1,10,2],
[1,3,8,9,1,8],
[0,9,1],
[0,3,8],
[-1]
];

self.onmessage = function(e) {
  const { volume, cols, rows, numSlices, isoValue, wc, ww, stepX, stepY, stepZ } = e.data;
  
  console.log('[MC Worker] received:', { cols, rows, numSlices, isoValue, wc, ww, volumeLength: volume ? volume.length : 'null', firstSliceType: volume && volume[0] ? volume[0].constructor.name : 'null', firstSliceLength: volume && volume[0] ? volume[0].length : 'null' });
  
  const lower = wc - ww / 2;
  
  // Get windowed value
  function getVal(z, y, x) {
    if (z < 0 || z >= numSlices || y < 0 || y >= rows || x < 0 || x >= cols) return 0;
    const slice = volume[z];
    if (!slice) return 0;
    const raw = slice[y * cols + x];
    if (raw === undefined) return 0;
    return Math.max(0, Math.min(1, (raw - lower) / ww));
  }
  
  // Process cubes radiating from center in expanding shells
  const BATCH_SIZE = 20000; // triangles per batch for smooth progressive display
  let positions = [];
  let normals = [];
  let intensities = []; // per-vertex intensity for colormap
  let triCount = 0;
  let cubesDone = 0;
  
  // Expand from center using shells of increasing radius
  const cxf = (cols - 2) / 2, cyf = (rows - 2) / 2, czf = (numSlices - 2) / 2;
  const maxR = Math.sqrt(cxf*cxf + cyf*cyf + czf*czf) + 1;
  const totalCubes = (cols - 1) * (rows - 1) * (numSlices - 1);
  const processed = new Uint8Array(totalCubes); // track processed cubes
  const shellStep = Math.max(1, Math.min(cols, rows, numSlices) / 8); // shell thickness
  
  for (let r = 0; r <= maxR; r += shellStep) {
    const r2max = (r + shellStep) * (r + shellStep);
    const r2min = r * r;
    // Iterate cubes within this shell
    const zLo = Math.max(0, Math.floor(czf - r - shellStep));
    const zHi = Math.min(numSlices - 2, Math.ceil(czf + r + shellStep));
    const yLo = Math.max(0, Math.floor(cyf - r - shellStep));
    const yHi = Math.min(rows - 2, Math.ceil(cyf + r + shellStep));
    const xLo = Math.max(0, Math.floor(cxf - r - shellStep));
    const xHi = Math.min(cols - 2, Math.ceil(cxf + r + shellStep));
    
    for (let z = zLo; z <= zHi; z++) {
      for (let y = yLo; y <= yHi; y++) {
        for (let x = xLo; x <= xHi; x++) {
          const idx = z * (rows - 1) * (cols - 1) + y * (cols - 1) + x;
          if (processed[idx]) continue;
          const dx = x - cxf, dy = y - cyf, dz = z - czf;
          const d2 = dx*dx + dy*dy + dz*dz;
          if (d2 < r2min || d2 >= r2max) continue;
          processed[idx] = 1;
          cubesDone++;
        // Get 8 corner values
        const v0 = getVal(z, y, x);
        const v1 = getVal(z, y, x + 1);
        const v2 = getVal(z, y + 1, x + 1);
        const v3 = getVal(z, y + 1, x);
        const v4 = getVal(z + 1, y, x);
        const v5 = getVal(z + 1, y, x + 1);
        const v6 = getVal(z + 1, y + 1, x + 1);
        const v7 = getVal(z + 1, y + 1, x);
        
        // Calculate cube index
        let cubeIndex = 0;
        if (v0 > isoValue) cubeIndex |= 1;
        if (v1 > isoValue) cubeIndex |= 2;
        if (v2 > isoValue) cubeIndex |= 4;
        if (v3 > isoValue) cubeIndex |= 8;
        if (v4 > isoValue) cubeIndex |= 16;
        if (v5 > isoValue) cubeIndex |= 32;
        if (v6 > isoValue) cubeIndex |= 64;
        if (v7 > isoValue) cubeIndex |= 128;
        
        if (EDGE_TABLE[cubeIndex] === 0) continue;
        
        // Vertex positions for the 8 corners (in volume space)
        const px = x * stepX, py = y * stepY, pz = z * stepZ;
        const px1 = (x + 1) * stepX, py1 = (y + 1) * stepY, pz1 = (z + 1) * stepZ;
        
        // Interpolate edge vertices
        const vertList = new Array(12);
        const edges = EDGE_TABLE[cubeIndex];
        
        function interp(va, vb, pa, pb) {
          let mu;
          if (Math.abs(isoValue - va) < 0.00001) mu = 0;
          else if (Math.abs(isoValue - vb) < 0.00001) mu = 1;
          else if (Math.abs(va - vb) < 0.00001) mu = 0;
          else mu = (isoValue - va) / (vb - va);
          return [
            pa[0] + mu * (pb[0] - pa[0]),
            pa[1] + mu * (pb[1] - pa[1]),
            pa[2] + mu * (pb[2] - pa[2]),
            va + mu * (vb - va) // interpolated intensity (0-1)
          ];
        }
        
        const c0 = [px, py, pz], c1 = [px1, py, pz], c2 = [px1, py1, pz], c3 = [px, py1, pz];
        const c4 = [px, py, pz1], c5 = [px1, py, pz1], c6 = [px1, py1, pz1], c7 = [px, py1, pz1];
        
        if (edges & 1) vertList[0] = interp(v0, v1, c0, c1);
        if (edges & 2) vertList[1] = interp(v1, v2, c1, c2);
        if (edges & 4) vertList[2] = interp(v2, v3, c2, c3);
        if (edges & 8) vertList[3] = interp(v3, v0, c3, c0);
        if (edges & 16) vertList[4] = interp(v4, v5, c4, c5);
        if (edges & 32) vertList[5] = interp(v5, v6, c5, c6);
        if (edges & 64) vertList[6] = interp(v6, v7, c6, c7);
        if (edges & 128) vertList[7] = interp(v7, v4, c7, c4);
        if (edges & 256) vertList[8] = interp(v0, v4, c0, c4);
        if (edges & 512) vertList[9] = interp(v1, v5, c1, c5);
        if (edges & 1024) vertList[10] = interp(v2, v6, c2, c6);
        if (edges & 2048) vertList[11] = interp(v3, v7, c3, c7);
        
        // Generate triangles
        const triRow = TRI_TABLE[cubeIndex];
        for (let i = 0; i < triRow.length && triRow[i] !== -1; i += 3) {
          const a = vertList[triRow[i]];
          const b = vertList[triRow[i + 1]];
          const c = vertList[triRow[i + 2]];
          if (!a || !b || !c) continue; // skip degenerate
          
          // Calculate face normal
          const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
          const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
          const nx = uy * wz - uz * wy;
          const ny = uz * wx - ux * wz;
          const nz = ux * wy - uy * wx;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          
          positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
          normals.push(nx/len, ny/len, nz/len, nx/len, ny/len, nz/len, nx/len, ny/len, nz/len);
          intensities.push(a[3], b[3], c[3]); // per-vertex intensity
          triCount++;
        }
        }
      }
    }
    
    // Post batch after each shell
    if (positions.length > 0) {
      const posArr = new Float32Array(positions);
      const normArr = new Float32Array(normals);
      const intArr = new Float32Array(intensities);
      self.postMessage({
        type: 'batch',
        positions: posArr,
        normals: normArr,
        intensities: intArr,
        slicesDone: cubesDone,
        totalSlices: totalCubes
      }, [posArr.buffer, normArr.buffer, intArr.buffer]);
      positions = [];
      normals = [];
      intensities = [];
      triCount = 0;
    }
  }
  
  self.postMessage({ type: 'done' });
};
