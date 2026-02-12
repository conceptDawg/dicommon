// 3D Volume Renderer using Three.js raycasting
(function() {
  let renderer, scene, camera, mesh;
  let volumeTexture, colormapTexture;
  let isInitialized = false;
  let animFrameId = null;
  let slicePlanes = { axial: null, sagittal: null, coronal: null };
  let sliceHandles = []; // interactive drag handles
  let clipPlaneObjects = []; // 6 clip planes with handles
  let clipHandles = []; // handles for clip planes
  let volSize = null; // stored for slice plane positioning
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let dragHandle = null; // { handle, axis, plane }
  let dragPlane = null; // THREE.Plane for constraining drag

  const container = document.getElementById('volume3d-container');
  const canvas3d = document.getElementById('volume3d-canvas');
  const thresholdSlider = document.getElementById('vol-threshold');
  const opacitySlider = document.getElementById('vol-opacity');
  const stepsSlider = document.getElementById('vol-steps');

  // Toggle 2D/3D views
  // 3D is always visible in quad view — auto-init when volume loads

  // Vertex shader (GLSL3)
  // Transform ray origin and direction into the volume's local (object) space
  // so the raycaster works correctly when the mesh is rotated
  const vertexShader = `
    out vec3 vOrigin;
    out vec3 vDirection;

    uniform mat4 volumeInverseModel;

    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      // Transform camera position into object space
      vOrigin = (volumeInverseModel * vec4(cameraPosition, 1.0)).xyz;
      // Direction in object space
      vDirection = position - vOrigin;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  // Fragment shader - raycasting through 3D texture (GLSL3)
  const fragmentShader = `
    precision highp float;
    precision highp sampler3D;

    in vec3 vOrigin;
    in vec3 vDirection;

    out vec4 fragColor;

    uniform sampler3D volumeTex;
    uniform sampler2D colormapTex;
    uniform float threshold;
    uniform float opacityScale;
    uniform int numSteps;
    uniform vec3 volumeSize;
    uniform vec3 clipMin;
    uniform vec3 clipMax;
    uniform bool mipMode;
    uniform float mipSlabFrac;

    vec2 intersectBox(vec3 orig, vec3 dir) {
      vec3 boxMin = vec3(-0.5) * volumeSize;
      vec3 boxMax = vec3(0.5) * volumeSize;
      vec3 invDir = 1.0 / dir;
      vec3 t0 = (boxMin - orig) * invDir;
      vec3 t1 = (boxMax - orig) * invDir;
      vec3 tmin = min(t0, t1);
      vec3 tmax = max(t0, t1);
      float tNear = max(max(tmin.x, tmin.y), tmin.z);
      float tFar = min(min(tmax.x, tmax.y), tmax.z);
      return vec2(tNear, tFar);
    }

    void main() {
      vec3 rayDir = normalize(vDirection);
      vec2 t = intersectBox(vOrigin, rayDir);

      if (t.x > t.y) discard;
      t.x = max(t.x, 0.0);

      if (mipMode && mipSlabFrac < 1.0) {
        float rayLen = t.y - t.x;
        t.y = t.x + rayLen * mipSlabFrac;
      }

      float stepSize = (t.y - t.x) / float(numSteps);
      vec4 accum = vec4(0.0);
      vec3 pos = vOrigin + rayDir * t.x;
      vec3 step = rayDir * stepSize;

      for (int i = 0; i < 512; i++) {
        if (i >= numSteps) break;

        vec3 texCoord = pos / volumeSize + 0.5;

        if (texCoord.x < clipMin.x || texCoord.x > clipMax.x ||
            texCoord.y < clipMin.y || texCoord.y > clipMax.y ||
            texCoord.z < clipMin.z || texCoord.z > clipMax.z) {
          pos += step;
          continue;
        }

        float intensity = texture(volumeTex, texCoord).r;

        if (mipMode) {
          // Maximum Intensity Projection: track max intensity along ray
          if (intensity > accum.a) {
            accum.a = intensity;
            accum.rgb = texture(colormapTex, vec2(intensity, 0.5)).rgb;
          }
        } else {
          // Standard alpha compositing
          if (intensity > threshold) {
            vec3 color = texture(colormapTex, vec2(intensity, 0.5)).rgb;
            float alpha = (intensity - threshold) / (1.0 - threshold + 0.001);
            alpha = clamp(alpha * alpha * opacityScale * stepSize * 10.0, 0.0, 1.0);

            accum.rgb += (1.0 - accum.a) * alpha * color;
            accum.a += (1.0 - accum.a) * alpha;

            if (accum.a > 0.95) break;
          }
        }

        pos += step;
      }

      if (mipMode) {
        fragColor = vec4(accum.rgb, 1.0);
      } else {
        fragColor = vec4(accum.rgb, accum.a);
      }
    }
  `;

  function buildColormapTexture() {
    const data = new Uint8Array(256 * 4);
    const lut = colormaps[currentColormap];
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut[i][0];
      data[i * 4 + 1] = lut[i][1];
      data[i * 4 + 2] = lut[i][2];
      data[i * 4 + 3] = 255;
    }

    if (colormapTexture) {
      colormapTexture.image.data = data;
      colormapTexture.needsUpdate = true;
    } else {
      colormapTexture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
      colormapTexture.minFilter = THREE.LinearFilter;
      colormapTexture.magFilter = THREE.LinearFilter;
      colormapTexture.needsUpdate = true;
    }
    return colormapTexture;
  }

  let upsampledNumSlices = 0;
  let upsampledSliceThickness = 0;

  function initVolume3D() {
    if (!volume || !volumeMeta.rows) return;

    const { rows, cols, numSlices, pixelSpacing, sliceThickness, windowCenter, windowWidth } = volumeMeta;

    // Compute upsampling factor for Z axis (cap at 8x to limit memory)
    const rawFactor = Math.round(sliceThickness / pixelSpacing);
    const upsampleFactor = Math.min(rawFactor, 8);
    upsampledNumSlices = (numSlices - 1) * upsampleFactor + 1;
    upsampledSliceThickness = sliceThickness / upsampleFactor;

    console.log(`3D volume: upsampling Z by ${upsampleFactor}x (${numSlices} → ${upsampledNumSlices} slices)`);

    // Create renderer, scene, camera only once
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas: canvas3d, alpha: true, antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
      camera.position.set(0, 0, 2.5);
      setupControls();
    }

    // Flatten volume for Web Worker (once per series load)
    const flatVolume = [];
    for (let s = 0; s < numSlices; s++) {
      const flat = new Float32Array(rows * cols);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          flat[y * cols + x] = volume[s][y][x];
        }
      }
      flatVolume.push(flat);
    }

    // Web Worker for off-thread texture rebuild
    let volumeWorker = null;
    let workerBusy = false;
    let pendingRebuild = false;
    try {
      volumeWorker = new Worker('volume-worker.js');
      volumeWorker.onmessage = function(e) {
        const { texData } = e.data;
        applyVolumeTexture(new Uint8Array(texData));
        workerBusy = false;
        if (pendingRebuild) {
          pendingRebuild = false;
          rebuildVolumeTexture();
        }
      };
    } catch(err) {
      console.warn('Web Worker not available, falling back to sync rebuild', err);
    }

    // Build 3D texture from volume data with Z interpolation
    rebuildVolumeTexture();

    function rebuildVolumeTexture() {
      // Skip if 3D panel is hidden (e.g. 3+1 layout)
      const panel3d = document.getElementById('volume3d-panel');
      if (panel3d && getComputedStyle(panel3d).display === 'none') return;

      const wc = parseInt(document.getElementById('wc-slider').value);
      const ww = parseInt(document.getElementById('ww-slider').value);

      if (volumeWorker) {
        if (workerBusy) { pendingRebuild = true; return; }
        workerBusy = true;
        volumeWorker.postMessage({
          volume: flatVolume,
          cols, rows, numSlices, upsampledNumSlices, upsampleFactor, wc, ww
        });
        return;
      }

      // Fallback: synchronous rebuild
      const lower = wc - ww / 2;
      const texData = new Uint8Array(cols * rows * upsampledNumSlices);
      for (let uz = 0; uz < upsampledNumSlices; uz++) {
        const origPos = uz / upsampleFactor;
        const s0 = Math.floor(origPos);
        const s1 = Math.min(s0 + 1, numSlices - 1);
        const frac = origPos - s0;
        const oneMinusFrac = 1 - frac;
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            const val = volume[s0][y][x] * oneMinusFrac + volume[s1][y][x] * frac;
            const norm = Math.max(0, Math.min(255, ((val - lower) / ww) * 255));
            texData[uz * rows * cols + y * cols + x] = norm;
          }
        }
      }
      applyVolumeTexture(texData);
    }

    function applyVolumeTexture(texData) {
      if (volumeTexture) { volumeTexture.dispose(); volumeTexture = null; }
      volumeTexture = new THREE.Data3DTexture(texData, cols, rows, upsampledNumSlices);
      volumeTexture.format = THREE.RedFormat;
      volumeTexture.type = THREE.UnsignedByteType;
      volumeTexture.minFilter = THREE.LinearFilter;
      volumeTexture.magFilter = THREE.LinearFilter;
      volumeTexture.unpackAlignment = 1;
      volumeTexture.needsUpdate = true;
      if (mesh) { mesh.material.uniforms.volumeTex.value = volumeTexture; }
    }

    // Debounced rebuild — offloaded to worker but still debounce rapid changes
    let rebuildTimer = null;
    function debouncedRebuild() {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuildVolumeTexture, 100);
    }

    // Listen for window/level changes to update 3D texture
    document.getElementById('wc-slider').addEventListener('input', debouncedRebuild);
    document.getElementById('ww-slider').addEventListener('input', debouncedRebuild);
    // Also catch preset button clicks
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setTimeout(rebuildVolumeTexture, 10));
    });

    buildColormapTexture();

    // Compute volume physical size ratio
    // X = cols * pixelSpacing, Y = rows * pixelSpacing, Z = upsampled slices * new thickness
    const sizeX = cols * pixelSpacing;
    const sizeY = rows * pixelSpacing;
    const sizeZ = upsampledNumSlices * upsampledSliceThickness;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    volSize = new THREE.Vector3(sizeX / maxDim, sizeY / maxDim, sizeZ / maxDim);

    // Create box geometry matching volume proportions
    const geometry = new THREE.BoxGeometry(volSize.x, volSize.y, volSize.z);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        volumeTex: { value: volumeTexture },
        colormapTex: { value: colormapTexture },
        threshold: { value: parseFloat(thresholdSlider.value) },
        opacityScale: { value: parseFloat(opacitySlider.value) },
        numSteps: { value: parseInt(stepsSlider.value) },
        volumeSize: { value: volSize },
        clipMin: { value: new THREE.Vector3(0, 0, 0) },
        clipMax: { value: new THREE.Vector3(1, 1, 1) },
        mipMode: { value: false },
        mipSlabFrac: { value: 1.0 },
        volumeInverseModel: { value: new THREE.Matrix4() },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      transparent: true,
      glslVersion: THREE.GLSL3,
    });

    mesh = new THREE.Mesh(geometry, material);
    mesh.scale.y = -1; // Flip upside down — DICOM data loads inverted
    scene.add(mesh);

    // Faint bounding cube wireframe
    const wireGeo = new THREE.EdgesGeometry(geometry);
    const wireMat = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.5, linewidth: 2 });
    const wireframe = new THREE.LineSegments(wireGeo, wireMat);
    mesh.add(wireframe); // child of mesh so it rotates with it

    // --- Slice overlay planes ---
    volSize = volSize; // already set above
    createSlicePlanes(volSize);
    updateSlicePlanePositions();
    createClipPlanes(volSize);

    isInitialized = true;
    resize();
    startRender();
  }

  function setupControls() {
    let isDragging = false;
    let isPanning = false;
    let prevX, prevY;

    function getMouseNDC(e) {
      const rect = canvas3d.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
    }

    function hitTestHandles(e) {
      if (!mesh) return null;
      const ndc = getMouseNDC(e);
      raycaster.setFromCamera(ndc, camera);
      const allHandles = [...sliceHandles, ...clipHandles].filter(h => h.visible);
      if (!allHandles.length) return null;
      const hits = raycaster.intersectObjects(allHandles);
      return hits.length > 0 ? hits[0].object : null;
    }

    canvas3d.addEventListener('mousedown', e => {
      if (e.button === 2) { isPanning = true; prevX = e.clientX; prevY = e.clientY; e.preventDefault(); return; }

      // Check for handle hit first
      const handle = hitTestHandles(e);
      if (handle && (handle.userData.isSliceHandle || handle.userData.isClipHandle)) {
        dragHandle = handle;
        // Create a drag plane perpendicular to the camera through the handle's world position
        const handleWorldPos = new THREE.Vector3();
        handle.getWorldPosition(handleWorldPos);
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, handleWorldPos);
        canvas3d.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }

      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
      e.preventDefault();
    });

    canvas3d.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('mousemove', e => {
      // Handle dragging
      if (dragHandle) {
        const ndc = getMouseNDC(e);
        raycaster.setFromCamera(ndc, camera);
        const intersect = new THREE.Vector3();
        raycaster.ray.intersectPlane(dragPlane, intersect);
        if (!intersect || !volSize) return;

        // Transform world position back to mesh local space
        const localPos = mesh.worldToLocal(intersect.clone());
        const axis = dragHandle.userData.axis;

        let frac;
        if (axis === 'z') frac = (localPos.z / volSize.z) + 0.5;
        else if (axis === 'x') frac = (localPos.x / volSize.x) + 0.5;
        else if (axis === 'y') frac = (localPos.y / volSize.y) + 0.5;
        frac = Math.max(0, Math.min(1, frac));

        if (dragHandle.userData.isClipHandle) {
          // Clip plane handle
          clipValues[dragHandle.userData.clipKey] = frac;
          updateClipPlanePositions();
        } else {
          // Slice handle
          const slider = document.getElementById(dragHandle.userData.sliderName);
          slider.value = Math.round(frac * parseInt(slider.max));
          slider.dispatchEvent(new Event('input'));
          updateSlicePlanePositions();
          if (window.renderAll) window.renderAll();
        }
        return;
      }

      if (!isDragging && !isPanning) {
        // Hover cursor for handles
        const handle = hitTestHandles(e);
        canvas3d.style.cursor = handle ? 'grab' : 'default';
        return;
      }

      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX;
      prevY = e.clientY;

      if (isPanning) {
        camera.position.x -= dx * 0.005;
        camera.position.y += dy * 0.005;
      } else {
        // Rotate mesh
        mesh.rotation.y += dx * 0.01;
        mesh.rotation.x += dy * 0.01;
      }
    });

    window.addEventListener('mouseup', () => {
      if (dragHandle) {
        canvas3d.style.cursor = 'default';
        dragHandle = null;
        dragPlane = null;
      }
      isDragging = false;
      isPanning = false;
    });

    canvas3d.addEventListener('wheel', e => {
      e.preventDefault();
      camera.position.z = Math.max(0.5, Math.min(10, camera.position.z + e.deltaY * 0.003));
    });
  }

  function resize() {
    if (!renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight - 40; // leave room for controls
    if (w <= 0 || h <= 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  window._resize3D = resize;

  // Auto-resize when container size changes (quad view expand/collapse)
  let resizeTimer = null;
  let lastW = 0, lastH = 0;
  new ResizeObserver((entries) => {
    const entry = entries[0];
    const w = entry.contentRect.width;
    const h = entry.contentRect.height;
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    if (resizeTimer) clearTimeout(resizeTimer);
    // Use requestAnimationFrame to avoid blocking the layout transition
    resizeTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        resize();
        resizeTimer = null;
      });
    }, 16);
  }).observe(container);

  function startRender() {
    if (animFrameId) return;
    function loop() {
      animFrameId = requestAnimationFrame(loop);
      // Update inverse model matrix so raycasting works in object space
      if (mesh) {
        mesh.updateMatrixWorld();
        mesh.material.uniforms.volumeInverseModel.value.copy(mesh.matrixWorld).invert();
      }
      renderer.render(scene, camera);
    }
    loop();
  }

  function stopRender() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  // Slider events
  thresholdSlider.addEventListener('input', () => {
    document.getElementById('vol-threshold-val').textContent = thresholdSlider.value;
    if (mesh) mesh.material.uniforms.threshold.value = parseFloat(thresholdSlider.value);
  });

  opacitySlider.addEventListener('input', () => {
    document.getElementById('vol-opacity-val').textContent = opacitySlider.value;
    if (mesh) mesh.material.uniforms.opacityScale.value = parseFloat(opacitySlider.value);
  });

  stepsSlider.addEventListener('input', () => {
    document.getElementById('vol-steps-val').textContent = stepsSlider.value;
    if (mesh) mesh.material.uniforms.numSteps.value = parseInt(stepsSlider.value);
  });

  // --- Interactive Clip Planes ---
  let clipValues = { xMin: 0, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zMax: 1 };

  function createClipPlanes(vs) {
    clipPlaneObjects.forEach(p => { if (p && mesh) mesh.remove(p); });
    clipHandles.forEach(h => { if (h && mesh) mesh.remove(h); });
    clipPlaneObjects = [];
    clipHandles = [];

    const handleSize = Math.min(vs.x, vs.y, vs.z) * 0.05;
    const clipColor = 0xffaa00; // orange for clip planes

    const makePlane = (w, h) => {
      // Wireframe outline only — no filled plane
      const shape = new THREE.BufferGeometry();
      const hw = w / 2, hh = h / 2;
      const verts = new Float32Array([
        -hw, -hh, 0,  hw, -hh, 0,
         hw, -hh, 0,  hw,  hh, 0,
         hw,  hh, 0, -hw,  hh, 0,
        -hw,  hh, 0, -hw, -hh, 0,
      ]);
      shape.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      const mat = new THREE.LineBasicMaterial({ color: clipColor, transparent: true, opacity: 0.5 });
      const p = new THREE.LineSegments(shape, mat);
      p.renderOrder = 998;
      mesh.add(p);
      return p;
    };

    const makeHandle = (axis, clipKey) => {
      const geo = new THREE.SphereGeometry(handleSize, 10, 10);
      const mat = new THREE.MeshBasicMaterial({ color: clipColor, depthTest: false });
      const h = new THREE.Mesh(geo, mat);
      h.renderOrder = 1001;
      h.userData = { isClipHandle: true, axis, clipKey };
      mesh.add(h);
      clipHandles.push(h);
      return h;
    };

    // X-min (left): YZ plane at left edge
    const xMinPlane = makePlane(vs.z, vs.y);
    xMinPlane.rotation.y = Math.PI / 2;
    xMinPlane.position.x = -vs.x * 0.5;
    xMinPlane._clipKey = 'xMin';
    xMinPlane._axis = 'x';
    xMinPlane._handles = [makeHandle('x', 'xMin'), makeHandle('x', 'xMin')];
    clipPlaneObjects.push(xMinPlane);

    // X-max (right)
    const xMaxPlane = makePlane(vs.z, vs.y);
    xMaxPlane.rotation.y = Math.PI / 2;
    xMaxPlane.position.x = vs.x * 0.5;
    xMaxPlane._clipKey = 'xMax';
    xMaxPlane._axis = 'x';
    xMaxPlane._handles = [makeHandle('x', 'xMax'), makeHandle('x', 'xMax')];
    clipPlaneObjects.push(xMaxPlane);

    // Y-min (front)
    const yMinPlane = makePlane(vs.x, vs.z);
    yMinPlane.rotation.x = Math.PI / 2;
    yMinPlane.position.y = -vs.y * 0.5;
    yMinPlane._clipKey = 'yMin';
    yMinPlane._axis = 'y';
    yMinPlane._handles = [makeHandle('y', 'yMin'), makeHandle('y', 'yMin')];
    clipPlaneObjects.push(yMinPlane);

    // Y-max (back)
    const yMaxPlane = makePlane(vs.x, vs.z);
    yMaxPlane.rotation.x = Math.PI / 2;
    yMaxPlane.position.y = vs.y * 0.5;
    yMaxPlane._clipKey = 'yMax';
    yMaxPlane._axis = 'y';
    yMaxPlane._handles = [makeHandle('y', 'yMax'), makeHandle('y', 'yMax')];
    clipPlaneObjects.push(yMaxPlane);

    // Z-min (top)
    const zMinPlane = makePlane(vs.x, vs.y);
    zMinPlane.position.z = -vs.z * 0.5;
    zMinPlane._clipKey = 'zMin';
    zMinPlane._axis = 'z';
    zMinPlane._handles = [makeHandle('z', 'zMin'), makeHandle('z', 'zMin')];
    clipPlaneObjects.push(zMinPlane);

    // Z-max (bottom)
    const zMaxPlane = makePlane(vs.x, vs.y);
    zMaxPlane.position.z = vs.z * 0.5;
    zMaxPlane._clipKey = 'zMax';
    zMaxPlane._axis = 'z';
    zMaxPlane._handles = [makeHandle('z', 'zMax'), makeHandle('z', 'zMax')];
    clipPlaneObjects.push(zMaxPlane);

    updateClipPlanePositions();
    const show = document.getElementById('show-clip-planes').checked;
    setClipPlanesVisible(show);
  }

  function updateClipPlanePositions() {
    if (!mesh || !volSize) return;
    clipPlaneObjects.forEach(p => {
      const key = p._clipKey;
      const axis = p._axis;
      const frac = clipValues[key];
      const size = axis === 'x' ? volSize.x : axis === 'y' ? volSize.y : volSize.z;
      const pos = (frac - 0.5) * size;

      if (axis === 'x') {
        p.position.x = pos;
        if (p._handles) {
          p._handles[0].position.set(pos, volSize.y * 0.5, 0);
          p._handles[1].position.set(pos, -volSize.y * 0.5, 0);
        }
      } else if (axis === 'y') {
        p.position.y = pos;
        if (p._handles) {
          p._handles[0].position.set(0, pos, volSize.z * 0.5);
          p._handles[1].position.set(0, pos, -volSize.z * 0.5);
        }
      } else {
        p.position.z = pos;
        if (p._handles) {
          p._handles[0].position.set(volSize.x * 0.5, 0, pos);
          p._handles[1].position.set(-volSize.x * 0.5, 0, pos);
        }
      }
    });

    // Update shader uniforms
    if (mesh) {
      mesh.material.uniforms.clipMin.value.set(clipValues.xMin, clipValues.yMin, clipValues.zMin);
      mesh.material.uniforms.clipMax.value.set(clipValues.xMax, clipValues.yMax, clipValues.zMax);
    }
  }

  function setClipPlanesVisible(show) {
    clipPlaneObjects.forEach(p => {
      p.visible = show;
      if (p._handles) p._handles.forEach(h => h.visible = show);
    });
  }

  document.getElementById('show-clip-planes').addEventListener('change', (e) => {
    setClipPlanesVisible(e.target.checked);
  });

  document.getElementById('reset-clip-planes').addEventListener('click', () => {
    clipValues = { xMin: 0, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zMax: 1 };
    updateClipPlanePositions();
  });

  // Update colormap when changed
  const origColormapHandler = document.getElementById('colormap-select').onchange;
  document.getElementById('colormap-select').addEventListener('change', () => {
    if (colormapTexture) {
      buildColormapTexture();
    }
    // Update solid mesh vertex colors with new colormap
    if (solidMesh && solidIntensities.length > 0) {
      updateSolidGeometry();
    }
  });

  // Sync MIP mode and slab to 3D shader
  document.getElementById('mip-checkbox').addEventListener('change', (e) => {
    if (mesh) {
      mesh.material.uniforms.mipMode.value = e.target.checked;
      // Sync slab value when MIP is toggled on
      if (e.target.checked) {
        const slabEl = document.getElementById('mip-slab');
        const frac = parseInt(slabEl.value) / parseInt(slabEl.max || 1);
        mesh.material.uniforms.mipSlabFrac.value = Math.min(1.0, frac);
      }
    }
  });

  document.getElementById('mip-slab').addEventListener('input', () => {
    if (!mesh) return;
    const slabEl = document.getElementById('mip-slab');
    const frac = parseInt(slabEl.value) / parseInt(slabEl.max || 1);
    mesh.material.uniforms.mipSlabFrac.value = Math.min(1.0, frac);
  });

  // Re-init when volume changes (hook into loadVolume)
  const origLoadVolume = window.loadVolume;
  // Watch for volume changes by patching renderAll
  const origRenderAll = window.renderAll || renderAll;

  // Expose re-init for when new volume loads
  window._reinit3D = function() {
    // Clean up solid mesh
    if (solidWorker) { solidWorker.terminate(); solidWorker = null; solidBuildInProgress = false; }
    if (solidMesh && mesh) { mesh.remove(solidMesh); }
    if (solidGeometry) { solidGeometry.dispose(); }
    solidMesh = null;
    solidGeometry = null;
    solidPositions = [];
    solidNormals = [];
    solidIntensities = [];

    if (isInitialized) {
      // Dispose old volume resources but keep renderer/scene/camera
      if (volumeTexture) { volumeTexture.dispose(); volumeTexture = null; }
      if (mesh) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh = null;
      }
      isInitialized = false;
    }
    if (volume) {
      initVolume3D();
      // Force a re-render
      if (renderer && scene && camera) {
        renderer.render(scene, camera);
      }
      // If in solid mode, rebuild solid and keep volume hidden
      if (currentSolidMode === 'solid') {
        if (mesh) mesh.material.visible = false;
        buildSolid();
      }
    }
  };

  // Patch the global loadVolume to reinit 3D after loading
  const _origSelectSeries = window.selectSeries;

  // --- Slice Overlay Planes with Interactive Handles ---
  function createSlicePlanes(vs) {
    // Remove old planes and handles
    Object.values(slicePlanes).forEach(p => { if (p && mesh) mesh.remove(p); });
    sliceHandles.forEach(h => { if (h && mesh) mesh.remove(h); });
    sliceHandles = [];

    const makeplane = (w, h, color) => {
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.15,
        side: THREE.DoubleSide, depthWrite: false
      });
      const p = new THREE.Mesh(geo, mat);
      p.renderOrder = 999;
      mesh.add(p);
      return p;
    };

    const handleSize = Math.min(vs.x, vs.y, vs.z) * 0.06;
    const makeHandle = (color, axis, sliderName) => {
      const geo = new THREE.SphereGeometry(handleSize, 12, 12);
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const h = new THREE.Mesh(geo, mat);
      h.renderOrder = 1000;
      h.userData = { isSliceHandle: true, axis, sliderName };
      mesh.add(h);
      sliceHandles.push(h);
      return h;
    };

    // Axial (XY plane) — blue — handle on +X and -X edges
    slicePlanes.axial = makeplane(vs.x, vs.y, 0x4488ff);
    slicePlanes.axial._handles = [
      makeHandle(0x4488ff, 'z', 'axial-slider'),
      makeHandle(0x4488ff, 'z', 'axial-slider'),
    ];

    // Sagittal (YZ plane) — red — handle on +Z and -Z edges
    slicePlanes.sagittal = makeplane(vs.z, vs.y, 0xff4444);
    slicePlanes.sagittal.rotation.y = Math.PI / 2;
    slicePlanes.sagittal._handles = [
      makeHandle(0xff4444, 'x', 'sagittal-slider'),
      makeHandle(0xff4444, 'x', 'sagittal-slider'),
    ];

    // Coronal (XZ plane) — green — handle on +X and -X edges
    slicePlanes.coronal = makeplane(vs.x, vs.z, 0x44ff44);
    slicePlanes.coronal.rotation.x = Math.PI / 2;
    slicePlanes.coronal._handles = [
      makeHandle(0x44ff44, 'y', 'coronal-slider'),
      makeHandle(0x44ff44, 'y', 'coronal-slider'),
    ];

    const show = document.getElementById('show-slice-planes').checked;
    Object.values(slicePlanes).forEach(p => {
      p.visible = show;
      if (p._handles) p._handles.forEach(h => h.visible = show);
    });
  }

  function updateSlicePlanePositions() {
    if (!mesh || !volSize || !slicePlanes.axial) return;

    const { numSlices, cols, rows } = volumeMeta;

    // Axial: Z position
    const axialSliderEl = document.getElementById('axial-slider');
    const axialFrac = parseInt(axialSliderEl.value) / Math.max(1, parseInt(axialSliderEl.max));
    const axZ = (axialFrac - 0.5) * volSize.z;
    slicePlanes.axial.position.z = axZ;
    if (slicePlanes.axial._handles) {
      slicePlanes.axial._handles[0].position.set(volSize.x * 0.5, 0, axZ);
      slicePlanes.axial._handles[1].position.set(-volSize.x * 0.5, 0, axZ);
    }

    // Sagittal: X position
    const sagFrac = parseInt(document.getElementById('sagittal-slider').value) / Math.max(1, cols - 1);
    const sagX = (sagFrac - 0.5) * volSize.x;
    slicePlanes.sagittal.position.x = sagX;
    if (slicePlanes.sagittal._handles) {
      slicePlanes.sagittal._handles[0].position.set(sagX, 0, volSize.z * 0.5);
      slicePlanes.sagittal._handles[1].position.set(sagX, 0, -volSize.z * 0.5);
    }

    // Coronal: Y position
    const corFrac = parseInt(document.getElementById('coronal-slider').value) / Math.max(1, rows - 1);
    const corY = (corFrac - 0.5) * volSize.y;
    slicePlanes.coronal.position.y = corY;
    if (slicePlanes.coronal._handles) {
      slicePlanes.coronal._handles[0].position.set(0, corY, volSize.z * 0.5);
      slicePlanes.coronal._handles[1].position.set(0, corY, -volSize.z * 0.5);
    }
  }

  // Listen for slider changes to update plane positions
  ['axial-slider', 'sagittal-slider', 'coronal-slider'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateSlicePlanePositions);
  });

  // Expose globally so renderAll can sync 3D crosshairs
  window._updateSlicePlanePositions = updateSlicePlanePositions;
  window._rebuild3DColormap = buildColormapTexture;

  // Toggle visibility (planes + handles) — syncs with 2D crosshairs
  document.getElementById('show-slice-planes').addEventListener('change', (e) => {
    Object.values(slicePlanes).forEach(p => {
      if (p) p.visible = e.target.checked;
      if (p && p._handles) p._handles.forEach(h => h.visible = e.target.checked);
    });
    // Sync 2D crosshairs
    const cb = document.getElementById('crosshair-checkbox');
    if (cb.checked !== e.target.checked) {
      cb.checked = e.target.checked;
      cb.dispatchEvent(new Event('change'));
    }
  });

  // --- Screenshot Export (3D) ---
  window._export3DScreenshot = function(multiplier) {
    if (!renderer || !scene || !camera) return null;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight - 40;
    const exportW = cssW * multiplier;
    const exportH = cssH * multiplier;
    // Temporarily set pixel ratio to 1 so setSize gives exact buffer dimensions
    const oldDpr = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(exportW, exportH, false);
    camera.aspect = exportW / exportH;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    // Restore
    renderer.setPixelRatio(oldDpr);
    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return dataUrl;
  };

  // Expose 3D state for bookmarks
  window._get3DState = function() {
    if (!camera || !mesh) return null;
    return {
      cameraX: camera.position.x, cameraY: camera.position.y, cameraZ: camera.position.z,
      rotX: mesh.rotation.x, rotY: mesh.rotation.y, rotZ: mesh.rotation.z,
      threshold: parseFloat(thresholdSlider.value),
      opacity: parseFloat(opacitySlider.value),
      steps: parseInt(stepsSlider.value),
      clipXMin: clipValues.xMin, clipXMax: clipValues.xMax,
      clipYMin: clipValues.yMin, clipYMax: clipValues.yMax,
      clipZMin: clipValues.zMin, clipZMax: clipValues.zMax,
      showSlicePlanes: document.getElementById('show-slice-planes').checked
    };
  };

  window._set3DState = function(s) {
    if (!s) {
      // Reset to defaults
      if (camera) camera.position.set(0, 0, 2.5);
      if (mesh) mesh.rotation.set(0, 0, 0);
      thresholdSlider.value = 0; document.getElementById('vol-threshold-val').textContent = '0';
      opacitySlider.value = 5; document.getElementById('vol-opacity-val').textContent = '5';
      stepsSlider.value = 256; document.getElementById('vol-steps-val').textContent = '256';
      if (mesh) {
        mesh.material.uniforms.threshold.value = 0;
        mesh.material.uniforms.opacityScale.value = 5;
        mesh.material.uniforms.numSteps.value = 256;
      }
      clipValues = { xMin: 0, xMax: 1, yMin: 0, yMax: 1, zMin: 0, zMax: 1 };
      updateClipPlanePositions();
      buildColormapTexture();
      return;
    }
    if (camera) { camera.position.set(s.cameraX, s.cameraY, s.cameraZ); }
    if (mesh) { mesh.rotation.set(s.rotX, s.rotY, s.rotZ); }

    thresholdSlider.value = s.threshold;
    document.getElementById('vol-threshold-val').textContent = s.threshold;
    opacitySlider.value = s.opacity;
    document.getElementById('vol-opacity-val').textContent = s.opacity;
    stepsSlider.value = s.steps;
    document.getElementById('vol-steps-val').textContent = s.steps;

    if (mesh) {
      mesh.material.uniforms.threshold.value = s.threshold;
      mesh.material.uniforms.opacityScale.value = s.opacity;
      mesh.material.uniforms.numSteps.value = s.steps;
    }

    clipValues.xMin = s.clipXMin; clipValues.xMax = s.clipXMax;
    clipValues.yMin = s.clipYMin; clipValues.yMax = s.clipYMax;
    clipValues.zMin = s.clipZMin; clipValues.zMax = s.clipZMax;
    updateClipPlanePositions();

    document.getElementById('show-slice-planes').checked = s.showSlicePlanes;
    Object.values(slicePlanes).forEach(p => {
      if (p) p.visible = s.showSlicePlanes;
      if (p && p._handles) p._handles.forEach(h => h.visible = s.showSlicePlanes);
    });

    // Rebuild colormap and MIP state
    buildColormapTexture();
    if (mesh) {
      mesh.material.uniforms.mipMode.value = document.getElementById('mip-checkbox').checked;
      const slabEl = document.getElementById('mip-slab');
      mesh.material.uniforms.mipSlabFrac.value = parseInt(slabEl.value) / parseInt(slabEl.max || 1);
    }
  };

  window.addEventListener('resize', resize);

  // ==================== SOLID RENDERER (Marching Cubes) ====================
  let solidMesh = null;
  let solidGeometry = null;
  let solidWorker = null;
  let solidBuildInProgress = false;
  let solidPositions = [];
  let solidNormals = [];
  let solidIntensities = [];
  let solidLight1 = null, solidLight2 = null;
  let currentSolidMode = 'volume'; // 'volume' or 'solid'

  const generateBtn = document.getElementById('solid-generate'); // may not exist
  const modeSelect = document.getElementById('3d-mode-select');
  const solidControlsHeader = document.getElementById('solid-controls');
  const volumeControlsBar = document.getElementById('volume3d-controls');
  const solidControlsBar = document.getElementById('solid3d-controls');
  let solidAutoRebuildTimer = null;

  // Mode switching
  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      currentSolidMode = modeSelect.value;
      if (currentSolidMode === 'solid') {
        // Show solid controls, hide volume controls
        if (solidControlsHeader) solidControlsHeader.style.display = 'inline';
        if (volumeControlsBar) volumeControlsBar.style.display = 'none';
        if (solidControlsBar) solidControlsBar.style.display = 'flex';
        // Hide raycaster, show solid — auto-build if no mesh yet
        if (mesh) mesh.material.visible = false;
        if (solidMesh) {
          solidMesh.visible = true;
        } else if (volume && volumeMeta.rows && renderer) {
          buildSolid();
        }
      } else {
        // Show volume controls, hide solid controls
        if (solidControlsHeader) solidControlsHeader.style.display = 'none';
        if (volumeControlsBar) volumeControlsBar.style.display = 'flex';
        if (solidControlsBar) solidControlsBar.style.display = 'none';
        // Show raycaster, hide solid
        if (mesh) mesh.material.visible = true;
        if (solidMesh) solidMesh.visible = false;
      }
    });
  }

  // Generate button
  if (generateBtn) {
    generateBtn.addEventListener('click', () => {
      if (!volume || !volumeMeta.rows || !renderer) return;
      buildSolid();
    });
  }

  function buildSolid() {
    const { rows, cols, numSlices, pixelSpacing, sliceThickness } = volumeMeta;

    // Kill previous build
    if (solidWorker) { solidWorker.terminate(); solidWorker = null; }
    solidBuildInProgress = false;

    // Remove old solid mesh
    if (solidMesh && mesh) { mesh.remove(solidMesh); solidMesh = null; }
    if (solidGeometry) { solidGeometry.dispose(); solidGeometry = null; }
    solidPositions = [];
    solidNormals = [];
    solidIntensities = [];

    // Flatten volume for worker
    const flatVol = [];
    for (let s = 0; s < numSlices; s++) {
      const flat = new Float32Array(rows * cols);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          flat[y * cols + x] = volume[s][y][x];
        }
      }
      flatVol.push(flat);
    }

    const wc = parseInt(document.getElementById('wc-slider').value);
    const ww = parseInt(document.getElementById('ww-slider').value);
    const isoCtrl = document.getElementById('solid-iso-ctrl');
    const isoValue = isoCtrl ? parseFloat(isoCtrl.value) : 0.3;

    // Physical step sizes normalized to volSize
    const maxDim = Math.max(cols * pixelSpacing, rows * pixelSpacing, numSlices * sliceThickness);
    const stepX = pixelSpacing / maxDim;
    const stepY = pixelSpacing / maxDim;
    const stepZ = sliceThickness / maxDim;

    // Create empty geometry and mesh — child of volume mesh so it rotates together
    solidGeometry = new THREE.BufferGeometry();
    solidMesh = new THREE.Mesh(solidGeometry, createSolidMaterial());
    // Position so (0,0,0) maps to volume corner, centered on the volume cube
    solidMesh.position.set(-volSize.x / 2, -volSize.y / 2, -volSize.z / 2);
    mesh.add(solidMesh);

    // Add lights if not yet
    if (!solidLight1) {
      solidLight1 = new THREE.DirectionalLight(0xffffff, 3.0);
      solidLight1.position.set(1, 1, 2);
      scene.add(solidLight1);
      solidLight2 = new THREE.DirectionalLight(0x8888ff, 0.4);
      solidLight2.position.set(-1, -0.5, -1);
      scene.add(solidLight2);
      scene.add(new THREE.AmbientLight(0x404040, 0.6));
    }

    // Hide volume raycaster mesh to show solid
    if (mesh) mesh.material.visible = false;

    // Show progress
    updateSolidProgress(0, numSlices - 1);

    // Start worker
    solidBuildInProgress = true;
    solidWorker = new Worker('marching-cubes-worker.js');
    solidWorker.onmessage = function(e) {
      const msg = e.data;
      if (msg.type === 'batch') {
        solidPositions.push(msg.positions);
        solidNormals.push(msg.normals);
        if (msg.intensities) solidIntensities.push(msg.intensities);
        updateSolidGeometry();
        updateSolidProgress(msg.slicesDone, msg.totalSlices);
      } else if (msg.type === 'progress') {
        updateSolidProgress(msg.slicesDone, msg.totalSlices);
      } else if (msg.type === 'done') {
        solidBuildInProgress = false;
        updateSolidProgress(-1, 0);
        if (generateBtn) generateBtn.textContent = 'Regenerate';
      }
    };

    solidWorker.postMessage({
      volume: flatVol,
      cols, rows, numSlices,
      isoValue, wc, ww,
      stepX, stepY, stepZ
    });

    if (generateBtn) generateBtn.textContent = 'Building...';
  }

  function createSolidMaterial() {
    const materialType = document.getElementById('solid-material').value;
    const opacity = parseFloat(document.getElementById('solid-opacity').value);
    const wireframe = document.getElementById('solid-wireframe').checked;
    const lightIntensity = parseFloat(document.getElementById('solid-light').value);

    // Update light intensity
    if (solidLight1) solidLight1.intensity = lightIntensity;

    const lut = colormaps[currentColormap];
    const mid = lut[180];
    const baseColor = new THREE.Color(mid[0] / 255, mid[1] / 255, mid[2] / 255);

    let mat;
    switch (materialType) {
      case 'bone':
        mat = new THREE.MeshPhongMaterial({
          color: 0xffffff,
          vertexColors: true,
          specular: 0x444444,
          shininess: 30,
          side: THREE.DoubleSide,
          flatShading: false,
        });
        break;
      case 'metallic':
        mat = new THREE.MeshPhongMaterial({
          color: 0xffffff,
          vertexColors: true,
          specular: 0xffffff,
          shininess: 100,
          side: THREE.DoubleSide,
          flatShading: false,
        });
        break;
      case 'flat':
        mat = new THREE.MeshPhongMaterial({
          color: 0xffffff,
          vertexColors: true,
          side: THREE.DoubleSide,
          flatShading: true,
        });
        break;
      default: // phong/smooth
        mat = new THREE.MeshPhongMaterial({
          color: 0xffffff,
          vertexColors: true,
          specular: 0x222222,
          shininess: 40,
          side: THREE.DoubleSide,
          flatShading: false,
        });
    }

    mat.transparent = opacity < 1;
    mat.opacity = opacity;
    mat.wireframe = wireframe;
    return mat;
  }

  // --- Solid control event listeners ---
  const solidIsoCtrl = document.getElementById('solid-iso-ctrl');
  if (solidIsoCtrl) {
    solidIsoCtrl.addEventListener('input', () => {
      document.getElementById('solid-iso-ctrl-val').textContent = solidIsoCtrl.value;
      // Auto-rebuild with debounce
      if (solidAutoRebuildTimer) clearTimeout(solidAutoRebuildTimer);
      solidAutoRebuildTimer = setTimeout(() => {
        if (currentSolidMode === 'solid' && volume && volumeMeta.rows && renderer) buildSolid();
      }, 300);
    });
  }

  // Opacity
  const solidOpacity = document.getElementById('solid-opacity');
  if (solidOpacity) {
    solidOpacity.addEventListener('input', () => {
      document.getElementById('solid-opacity-val').textContent = solidOpacity.value;
      if (solidMesh) {
        solidMesh.material.opacity = parseFloat(solidOpacity.value);
        solidMesh.material.transparent = parseFloat(solidOpacity.value) < 1;
      }
    });
  }

  // Wireframe
  const solidWireframe = document.getElementById('solid-wireframe');
  if (solidWireframe) {
    solidWireframe.addEventListener('change', () => {
      if (solidMesh) solidMesh.material.wireframe = solidWireframe.checked;
    });
  }

  // Material preset
  const solidMaterial = document.getElementById('solid-material');
  if (solidMaterial) {
    solidMaterial.addEventListener('change', () => {
      if (solidMesh) {
        const oldWireframe = solidMesh.material.wireframe;
        solidMesh.material.dispose();
        solidMesh.material = createSolidMaterial();
        solidMesh.material.wireframe = oldWireframe;
      }
    });
  }

  // Lighting
  const solidLightCtrl = document.getElementById('solid-light');
  if (solidLightCtrl) {
    solidLightCtrl.addEventListener('input', () => {
      document.getElementById('solid-light-val').textContent = solidLightCtrl.value;
      if (solidLight1) solidLight1.intensity = parseFloat(solidLightCtrl.value);
    });
  }

  function updateSolidGeometry() {
    if (!solidGeometry) return;
    let totalVerts = 0;
    for (const arr of solidPositions) totalVerts += arr.length;
    const pos = new Float32Array(totalVerts);
    const norm = new Float32Array(totalVerts);
    let offset = 0;
    for (let i = 0; i < solidPositions.length; i++) {
      pos.set(solidPositions[i], offset);
      norm.set(solidNormals[i], offset);
      offset += solidPositions[i].length;
    }

    // Apply colormap as vertex colors
    const numVerts = totalVerts / 3;
    const colors = new Float32Array(totalVerts);
    const lut = colormaps[currentColormap];
    let intOffset = 0;
    for (let i = 0; i < solidIntensities.length; i++) {
      const intArr = solidIntensities[i];
      for (let j = 0; j < intArr.length; j++) {
        const ci = Math.max(0, Math.min(255, Math.round(intArr[j] * 255)));
        const rgb = lut[ci];
        const vIdx = (intOffset + j) * 3;
        colors[vIdx] = rgb[0] / 255;
        colors[vIdx + 1] = rgb[1] / 255;
        colors[vIdx + 2] = rgb[2] / 255;
      }
      intOffset += intArr.length;
    }

    solidGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    solidGeometry.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
    solidGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    solidGeometry.computeBoundingSphere();
  }

  function updateSolidProgress(done, total) {
    let el = document.getElementById('mc-build-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mc-build-progress';
      el.style.cssText = 'position:absolute;top:8px;left:8px;color:#e94560;font-size:0.75em;background:rgba(0,0,0,0.7);padding:2px 8px;border-radius:4px;z-index:10;pointer-events:none;';
      container.appendChild(el);
    }
    if (done < 0) {
      el.style.display = 'none';
      return;
    }
    const pct = Math.round((done / total) * 100);
    const triCount = solidPositions.reduce((s, a) => s + a.length / 9, 0);
    el.style.display = 'block';
    el.textContent = `Building: ${pct}% — ${Math.round(triCount).toLocaleString()} triangles`;
  }
})();
