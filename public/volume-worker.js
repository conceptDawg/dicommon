// Web Worker for volume texture rebuild (off main thread)
self.onmessage = function(e) {
  const { volume, cols, rows, numSlices, upsampledNumSlices, upsampleFactor, wc, ww } = e.data;
  const lower = wc - ww / 2;
  const texData = new Uint8Array(cols * rows * upsampledNumSlices);

  for (let uz = 0; uz < upsampledNumSlices; uz++) {
    const origPos = uz / upsampleFactor;
    const s0 = Math.floor(origPos);
    const s1 = Math.min(s0 + 1, numSlices - 1);
    const frac = origPos - s0;
    const oneMinusFrac = 1 - frac;

    const slice0 = volume[s0];
    const slice1 = volume[s1];
    const offset = uz * rows * cols;

    for (let y = 0; y < rows; y++) {
      const rowOffset = offset + y * cols;
      const srcOffset = y * cols;
      for (let x = 0; x < cols; x++) {
        const val = slice0[srcOffset + x] * oneMinusFrac + slice1[srcOffset + x] * frac;
        const norm = Math.max(0, Math.min(255, ((val - lower) / ww) * 255));
        texData[rowOffset + x] = norm;
      }
    }
  }

  self.postMessage({ texData }, [texData.buffer]);
};
