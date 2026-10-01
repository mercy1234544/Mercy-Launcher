// Imperative Three.js viewer for the real vehicle GLB.
// Handles orbit/zoom/pan, studio HDR lighting (procedural, no asset), wireframe,
// per-material live CanvasTexture override, raycast click->material, and highlight.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { LoadedVehicle, VehicleMaterialSlot } from './glbVehicle';

export type ViewMode = 'material' | 'wireframe' | 'uv';

export class VehicleViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private animId = 0;
  private container: HTMLElement;
  private resizeObs: ResizeObserver;

  private vehicle: LoadedVehicle | null = null;
  private overrideTex = new Map<string, THREE.CanvasTexture>();
  private forcedTex: THREE.CanvasTexture | null = null;
  /** Per-slot material.map snapshotted right before forceTextureOnAll(canvas)
   *  turns on, so turning it back off restores exactly what was really
   *  showing — independent of overrideTex's keying. */
  private preForceMap = new Map<string, THREE.Texture | null>();
  private uvDebugMat: THREE.ShaderMaterial | null = null;
  private savedMats = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private savedSection = new Map<string, { color: THREE.Color; map: THREE.Texture | null }>();
  private highlightKey: string | null = null;
  private wireframe = false;
  private pointerDownAt: { x: number; y: number } | null = null;

  onPickSlot: ((slotId: string, meshName: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12141c);

    // Procedural studio environment for nice PBR reflections (no external HDR file).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.05, 500);
    this.camera.position.set(5, 2.4, 6);

    // Key + fill + ground.
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(6, 10, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 50;
    const s = 8;
    key.shadow.camera.left = -s; key.shadow.camera.right = s;
    key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
    this.scene.add(key);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(14, 64),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(28, 28, 0x2a2d3a, 0x1c1e28);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(grid);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI / 2 + 0.15;

    // REAL FIX for "mesh switching is glitchy": a plain 'click' listener also
    // fires after OrbitControls drags the camera (mousedown → drag-orbit →
    // mouseup still dispatches 'click'), so a small orbit nudge could pick
    // the wrong mesh or re-pick the one under the cursor after the camera
    // moved. Tracking pointerdown/up ourselves and only treating it as a
    // pick when the pointer barely moved makes selection only ever fire for
    // a genuine click, never a drag-orbit.
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    this.animate();
  }

  private animate = () => {
    this.animId = requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
  };

  /** A "click" only counts as a mesh pick if the pointer moved less than
   *  this many CSS pixels between down and up — anything more is a
   *  camera-orbit drag, not a selection gesture. */
  private static readonly CLICK_MOVE_TOLERANCE_PX = 4;

  private handlePointerUp = (e: PointerEvent) => {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down || !this.vehicle || !this.onPickSlot) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (Math.hypot(dx, dy) > VehicleViewer.CLICK_MOVE_TOLERANCE_PX) return; // was a drag/orbit, not a pick

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.vehicle.meshes, false);
    if (!hits.length) return;
    const mesh = hits[0].object as THREE.Mesh;
    const slot = this.vehicle.slots.find((sl) => sl.meshes.includes(mesh));
    if (slot) this.onPickSlot(slot.id, mesh.name || '');
  };

  setVehicle(vehicle: LoadedVehicle) {
    if (this.vehicle) this.scene.remove(this.vehicle.root);
    this.overrideTex.forEach((t) => t.dispose());
    this.overrideTex.clear();
    this.vehicle = vehicle;
    this.scene.add(vehicle.root);
    this.frame(vehicle);
  }

  private frame(vehicle: LoadedVehicle) {
    const radius = Math.max(vehicle.size.x, vehicle.size.y, vehicle.size.z) || 4;
    const dist = radius * 1.6;
    this.camera.position.set(dist, radius * 0.55, dist);
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = radius * 0.4;
    this.controls.maxDistance = radius * 8;
    this.controls.update();
  }

  /** Push the edited canvas onto a specific material's map — live, no reload. */
  setSlotTexture(slot: VehicleMaterialSlot, canvas: HTMLCanvasElement, flipY = false) {
    this.setTextureOnSlots(slot.id, [slot], canvas, flipY);
  }

  /**
   * REAL FIX for the painting freeze: push ONE canvas onto MANY material
   * slots using a SINGLE shared THREE.CanvasTexture, keyed by `textureKey`
   * (the edit target's own id — stable across repeated calls for the same
   * texture) instead of one new CanvasTexture PER SLOT.
   *
   * The old setSlotTexture(), called once per slot in a loop, created a
   * SEPARATE CanvasTexture object per slot even though they all wrapped
   * the exact same canvas — each one is its own real GPU texture, so
   * marking all of them needsUpdate=true forced N full-resolution texture
   * uploads (a multi-megabyte GPU copy each) on every single throttled
   * composite, instead of one. For a texture used by many materials (a
   * shared livery texture across body panels, or the Auto Sync fallback
   * applying to every material), that is the actual multi-second-to-a-
   * minute freeze the user hit — not the lack of frame-throttling (that
   * part was already correct). Now exactly one GPU upload happens
   * regardless of how many materials reference the texture.
   */
  setTextureOnSlots(textureKey: string, slots: VehicleMaterialSlot[], canvas: HTMLCanvasElement, flipY = false) {
    let tex = this.overrideTex.get(textureKey);
    if (!tex) {
      tex = new THREE.CanvasTexture(canvas);
      tex.flipY = flipY;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.overrideTex.set(textureKey, tex);
    }
    tex.image = canvas;
    tex.needsUpdate = true; // ONE flag -> ONE GPU upload, shared by every slot below
    for (const slot of slots) {
      slot.material.map = tex;
      slot.material.color.set(0xffffff);
      slot.material.needsUpdate = true; // cheap: a material-state flag, not a texture re-upload
    }
  }

  /**
   * DEBUG: apply one canvas as the diffuse map of EVERY material (or pass null to
   * restore each material's original/override map). Returns the number of
   * materials affected. Used by the "Force Selected Texture" test button to
   * prove the live-texture pipeline independently of material→texture mapping.
   */
  forceTextureOnAll(canvas: HTMLCanvasElement | null, flipY = false): number {
    if (!this.vehicle) return 0;
    if (!canvas) {
      // Restore whatever each slot's material was ACTUALLY showing right
      // before the force (snapshotted below) — never guess by re-deriving
      // from overrideTex, which is now keyed by texture id (shared across
      // many slots, see setTextureOnSlots), not by slot id.
      for (const slot of this.vehicle.slots) {
        const restore = this.preForceMap.get(slot.id);
        const map = restore !== undefined ? restore : slot.originalMap;
        slot.material.map = map;
        slot.material.color.set(map ? 0xffffff : 0xc0c0c0);
        slot.material.needsUpdate = true;
      }
      this.preForceMap.clear();
      return 0;
    }
    if (this.preForceMap.size === 0) {
      for (const slot of this.vehicle.slots) this.preForceMap.set(slot.id, slot.material.map ?? null);
    }
    if (!this.forcedTex) {
      this.forcedTex = new THREE.CanvasTexture(canvas);
      this.forcedTex.colorSpace = THREE.SRGBColorSpace;
      this.forcedTex.anisotropy = 8;
    }
    this.forcedTex.flipY = flipY;
    this.forcedTex.image = canvas;
    this.forcedTex.needsUpdate = true;
    for (const slot of this.vehicle.slots) {
      slot.material.map = this.forcedTex;
      slot.material.color.set(0xffffff);
      slot.material.needsUpdate = true;
    }
    return this.vehicle.slots.length;
  }

  /** Highlight one slot, a set of slots (e.g. every mesh using a texture), or clear. */
  highlightSlot(slotId: string | string[] | null) {
    if (!this.vehicle) return;
    const ids = slotId == null ? [] : Array.isArray(slotId) ? slotId : [slotId];
    const idSet = new Set(ids);
    const key = ids.slice().sort().join('|');
    if (this.highlightKey === key) return;
    for (const slot of this.vehicle.slots) {
      const on = idSet.has(slot.id);
      // A real, clearly visible highlight — must still not mask the
      // (painted) diffuse texture underneath. 0.18 was too subtle to read
      // as "selected" against bright paintwork; a brighter emissive plus a
      // wireframe overlay reads clearly regardless of the base texture.
      slot.material.emissive = new THREE.Color(on ? 0x2255ff : 0x000000);
      slot.material.emissiveIntensity = on ? 0.45 : 0;
      slot.material.needsUpdate = true;
    }
    this.highlightKey = key;
  }

  setWireframe(on: boolean) {
    this.wireframe = on;
    if (!this.vehicle) return;
    for (const slot of this.vehicle.slots) {
      slot.material.wireframe = on;
      slot.material.needsUpdate = true;
    }
  }

  isWireframe() { return this.wireframe; }

  /**
   * UV DEBUG: swap every mesh to a shader that paints UVs as colour
   * (red = U, green = V). Correct UVs show smooth red→green gradients across
   * each panel; broken/collapsed UVs show a flat colour. Pass false to restore.
   */
  setUVDebug(on: boolean) {
    if (!this.vehicle) return;
    if (on) {
      if (!this.uvDebugMat) {
        this.uvDebugMat = new THREE.ShaderMaterial({
          side: THREE.DoubleSide,
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'varying vec2 vUv; void main(){ gl_FragColor = vec4(fract(vUv.x), fract(vUv.y), 0.25, 1.0); }',
        });
      }
      for (const m of this.vehicle.meshes) {
        if (!this.savedMats.has(m)) this.savedMats.set(m, m.material);
        m.material = this.uvDebugMat;
      }
    } else {
      for (const m of this.vehicle.meshes) {
        const s = this.savedMats.get(m);
        if (s) m.material = s;
      }
      this.savedMats.clear();
    }
  }

  /**
   * SECTION DEBUG: paint each material section a unique flat colour (no texture)
   * so you can see exactly which mesh sections share a material and compare the
   * breakdown to OpenIV. Pass false to restore textures/colours.
   */
  setSectionDebug(on: boolean) {
    if (!this.vehicle) return;
    if (on) {
      this.vehicle.slots.forEach((slot, i) => {
        if (!this.savedSection.has(slot.id))
          this.savedSection.set(slot.id, { color: slot.material.color.clone(), map: slot.material.map });
        // Golden-ratio hue spacing → maximally distinct colours.
        slot.material.color.setHSL((i * 0.61803398875) % 1, 0.75, 0.5);
        slot.material.map = null;
        slot.material.emissive = new THREE.Color(0x000000);
        slot.material.emissiveIntensity = 0;
        slot.material.needsUpdate = true;
      });
    } else {
      for (const slot of this.vehicle.slots) {
        const s = this.savedSection.get(slot.id);
        if (s) { slot.material.color.copy(s.color); slot.material.map = s.map as THREE.Texture | null; slot.material.needsUpdate = true; }
      }
      this.savedSection.clear();
    }
  }

  /** Toggle DX↔GL vertical orientation of every texture (fixes upside-down liveries). */
  setFlipV(flip: boolean) {
    if (!this.vehicle) return;
    const apply = (t: THREE.Texture | null | undefined) => { if (t) { t.flipY = flip; t.needsUpdate = true; } };
    for (const slot of this.vehicle.slots) {
      apply(slot.material.map);
      apply(slot.originalMap);
      slot.material.needsUpdate = true;
    }
    this.overrideTex.forEach((t) => apply(t));
    if (this.forcedTex) apply(this.forcedTex);
  }

  resetView() {
    if (this.vehicle) this.frame(this.vehicle);
  }

  dispose() {
    cancelAnimationFrame(this.animId);
    this.resizeObs.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.overrideTex.forEach((t) => t.dispose());
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
