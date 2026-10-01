// Loads GTA V vehicle geometry — either from native YFT (primary path) or from a
// GLB export (internal fallback). Exposes material slots, textures, UV layouts.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ParsedDrawable } from './rage/yft';

export interface VehicleMaterialSlot {
  id: string;
  name: string;
  material: THREE.MeshStandardMaterial;
  meshes: THREE.Mesh[];
  originalMap: THREE.Texture | null;
  /** Best-guess vehicle section from the material/mesh name (hood, doors, roof…). */
  section: string;
  /** Primary texture name this slot uses (from YTD dictionary key). */
  textureHint?: string;
  /** All texture-parameter names for this material (diffuse, normal, spec, …). */
  textures: string[];
  /** GTA material index (for debug / OpenIV comparison). */
  materialIndex?: number;
  /** GTA shader name hash (for OpenIV/CodeWalker comparison). */
  shaderHash?: string;
  /** Texture-list slot the chosen diffuse came from. */
  diffuseSlot?: number;
  /** Which texcoord channel this slot's meshes use (0 or 1). */
  uvChannel?: number;
}

export interface LoadedVehicle {
  root: THREE.Group;
  slots: VehicleMaterialSlot[];
  meshes: THREE.Mesh[];
  size: THREE.Vector3;
  center: THREE.Vector3;
}

// Heuristic mapping from GTA material/mesh names to human sections.
const SECTION_RULES: [RegExp, string][] = [
  [/paint|livery|body|chassis|primary|secondary/i, 'Body / Livery'],
  [/hood|bonnet/i, 'Hood'],
  [/door/i, 'Doors'],
  [/roof/i, 'Roof'],
  [/bumper|bump_|grille|grill/i, 'Bumpers'],
  [/trunk|boot|tailgate/i, 'Trunk'],
  [/window|glass|windscreen|windshield/i, 'Glass'],
  [/wheel|tyre|tire|rim/i, 'Wheels'],
  [/light|lamp|indicator|emiss/i, 'Lights'],
  [/interior|seat|dash/i, 'Interior'],
  [/badge|decal|sign|logo|number/i, 'Decals'],
  [/chrome|metal|trim/i, 'Trim'],
  [/plate/i, 'Plate'],
];

function guessSection(name: string): string {
  for (const [re, label] of SECTION_RULES) if (re.test(name)) return label;
  return 'Other';
}

export function loadVehicleGLB(buffer: ArrayBuffer): Promise<LoadedVehicle> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      '',
      (gltf) => {
        try {
          resolve(buildVehicle(gltf.scene));
        } catch (e) {
          reject(e);
        }
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err)))
    );
  });
}

function buildVehicle(scene: THREE.Group): LoadedVehicle {
  const meshes: THREE.Mesh[] = [];
  const slotByMaterial = new Map<THREE.Material, VehicleMaterialSlot>();

  scene.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    meshes.push(mesh);

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      // Normalise to MeshStandardMaterial so we always have .map / .emissive etc.
      let mat = raw as THREE.MeshStandardMaterial;
      if (!(mat as any).isMeshStandardMaterial) {
        const std = new THREE.MeshStandardMaterial({
          map: (raw as any).map ?? null,
          color: (raw as any).color ?? new THREE.Color(0xcccccc),
          metalness: 0.55,
          roughness: 0.45,
        });
        std.name = raw.name;
        if (Array.isArray(mesh.material)) {
          const idx = mesh.material.indexOf(raw);
          if (idx >= 0) mesh.material[idx] = std;
        } else {
          mesh.material = std;
        }
        mat = std;
      }

      let slot = slotByMaterial.get(mat);
      if (!slot) {
        const name = mat.name || `material_${slotByMaterial.size}`;
        slot = {
          id: `slot_${slotByMaterial.size}`,
          name,
          material: mat,
          meshes: [],
          originalMap: mat.map ?? null,
          section: guessSection(`${name} ${mesh.name}`),
          textures: [],
        };
        slotByMaterial.set(mat, slot);
      }
      if (!slot.meshes.includes(mesh)) slot.meshes.push(mesh);
    }
  });

  const slots = Array.from(slotByMaterial.values());

  // Centre + scale info for camera framing.
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Recentre the model at origin so orbiting feels natural.
  scene.position.sub(center);

  // Sort slots so paint/livery slots float to the top.
  slots.sort((a, b) => {
    const score = (s: VehicleMaterialSlot) =>
      /Body|Livery|Decals/.test(s.section) ? 0 : s.section === 'Other' ? 2 : 1;
    return score(a) - score(b);
  });

  return { root: scene, slots, meshes, size, center: new THREE.Vector3(0, 0, 0) };
}

// ── Native YFT → LoadedVehicle ───────────────────────────────────────────────
// Converts ParsedDrawable (from yft.ts) into a LoadedVehicle that the existing
// VehicleViewer and editor already understand.
//
// Coordinate transform: GTA V is X-right Y-forward Z-up.
//   Three.js: X-right Y-up Z-toward-viewer.
//   Mapping:  three = (gtaX, gtaZ, -gtaY).
//   Determinant = 1 → no winding-order flip needed.
//
// UV convention: GTA V uses DirectX UVs (v=0 at the TOP of the texture) and the
// YFT stores them that way. We feed those UVs to Three.js unchanged, so the
// texture must NOT be vertically flipped on upload → flipY = FALSE. (flipY=true,
// the Three.js default for OpenGL-convention UVs, would sample v=0 from the
// BOTTOM, vertically mirroring every texture — invisible on uniform paint but it
// scatters a livery atlas to the wrong panels.)

function gtaPos(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

function gtaNorm(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

export function buildVehicleFromDrawable(
  drawable: ParsedDrawable,
  ytdTextures: Map<string, ImageData>,
): LoadedVehicle {
  const root     = new THREE.Group();
  const meshes: THREE.Mesh[]                     = [];
  const matByShader = new Map<number, THREE.MeshStandardMaterial>();
  const slotByShader = new Map<number, VehicleMaterialSlot>();

  // Build one material per shader index.
  for (const shader of drawable.shaders) {
    const texName  = shader.textureParams[0] ?? null;
    const imgData  = texName ? ytdTextures.get(texName) : null;

    let map: THREE.CanvasTexture | null = null;
    if (imgData) {
      const c = document.createElement('canvas');
      c.width = imgData.width; c.height = imgData.height;
      c.getContext('2d')!.putImageData(imgData, 0, 0);
      map = new THREE.CanvasTexture(c);
      map.flipY       = false; // GTA DX UVs (v=0 top) used as-is → do not flip
      map.colorSpace  = THREE.SRGBColorSpace;
      map.anisotropy  = 8;
    }

    // Classify material section by shader name + texture name
    const sectionHint = `${shader.filename} ${texName ?? ''}`;
    const mat = new THREE.MeshStandardMaterial({
      map: map ?? undefined,
      color: map ? 0xffffff : 0xc0c0c0,
      metalness: 0.4,
      roughness: 0.55,
      name: shader.filename || `shader_${shader.index}`,
    });

    matByShader.set(shader.index, mat);
    slotByShader.set(shader.index, {
      id: `slot_${shader.index}`,
      name: shader.filename || `shader_${shader.index}`,
      material: mat,
      meshes: [],
      originalMap: map,
      section: guessSection(sectionHint),
      textureHint: texName ?? undefined,
      textures: shader.textureParams ?? [],
      materialIndex: shader.materialIndex,
      shaderHash: shader.shaderHash,
      diffuseSlot: shader.diffuseSlot,
    });
  }

  // Fallback material for shader indices with no parsed shader.
  const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.3, roughness: 0.6, name: 'fallback' });
  const fallbackSlot: VehicleMaterialSlot = { id: 'slot_fallback', name: 'Other', material: fallbackMat, meshes: [], originalMap: null, section: 'Other', textures: [] };

  // Build Three.js BufferGeometry for each parsed geometry.
  for (const geo of drawable.geometries) {
    const vertCount = geo.positions.length / 3;

    // Transformed positions (GTA → Three.js)
    const pos3 = new Float32Array(vertCount * 3);
    for (let vi = 0; vi < vertCount; vi++) {
      const [tx, ty, tz] = gtaPos(geo.positions[vi * 3], geo.positions[vi * 3 + 1], geo.positions[vi * 3 + 2]);
      pos3[vi * 3] = tx; pos3[vi * 3 + 1] = ty; pos3[vi * 3 + 2] = tz;
    }

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(pos3, 3));

    if (geo.normals) {
      const n3 = new Float32Array(vertCount * 3);
      for (let vi = 0; vi < vertCount; vi++) {
        const [nx, ny, nz] = gtaNorm(geo.normals[vi * 3], geo.normals[vi * 3 + 1], geo.normals[vi * 3 + 2]);
        n3[vi * 3] = nx; n3[vi * 3 + 1] = ny; n3[vi * 3 + 2] = nz;
      }
      bg.setAttribute('normal', new THREE.BufferAttribute(n3, 3));
    }

    if (geo.uvs) {
      bg.setAttribute('uv', new THREE.BufferAttribute(geo.uvs.slice(), 2));
    }

    bg.setIndex(new THREE.BufferAttribute(new Uint32Array(geo.indices), 1));

    if (!geo.normals) bg.computeVertexNormals();

    const mat  = matByShader.get(geo.shaderIndex) ?? fallbackMat;
    const slot = slotByShader.get(geo.shaderIndex) ?? fallbackSlot;

    const mesh = new THREE.Mesh(bg, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.name          = geo.name;
    mesh.frustumCulled = false; // never cull on a (possibly wrong) bounding sphere
    // Per-mesh trace data (read back by the editor's click inspector / console trace).
    mesh.userData = {
      uvChannel: geo.uvChannel,
      vertexCount: geo.positions.length / 3,
      triCount: geo.indices.length / 3,
      vertexStride: geo.vertexStride,
      materialIndex: slot.materialIndex,
      shaderHash: slot.shaderHash,
      diffuse: slot.textureHint,
      diffuseSlot: slot.diffuseSlot,
      hasTexture: !!slot.originalMap,
      texSource: slot.originalMap ? 'YTD' : 'none',
      // Real byte offsets into the original YFT's decompressed buffer —
      // see ParsedGeometry's own header in rage/yft.ts. Lets uvGenerator.ts
      // patch newly-generated UVs back into the actual file in place.
      vertexBufferOffset: geo.vertexBufferOffset,
      uvFieldOffset: geo.uvFieldOffset,
      uvIsHalf: geo.uvIsHalf,
    };
    slot.uvChannel = geo.uvChannel;
    root.add(mesh);
    meshes.push(mesh);
    if (!slot.meshes.includes(mesh)) slot.meshes.push(mesh);
  }

  // ── Complete texture trace (console) — one row per rendered mesh ──────────────
  try {
    const rows = meshes.map((m, i) => ({
      mesh: m.name, idx: i,
      matIdx: m.userData.materialIndex,
      shaderHash: m.userData.shaderHash,
      diffuse: m.userData.diffuse,
      diffuseSlot: m.userData.diffuseSlot,
      uvCh: m.userData.uvChannel,
      verts: m.userData.vertexCount,
      texSource: m.userData.texSource,
    }));
    // eslint-disable-next-line no-console
    console.log('%c[YFT texture trace] %d meshes', 'color:#4ea1ff;font-weight:bold', rows.length);
    // eslint-disable-next-line no-console
    console.table(rows);
  } catch { /* ignore */ }

  // Collect slots — prefer livery/body slots first.
  const slots = [
    ...Array.from(slotByShader.values()).filter((s) => s.meshes.length > 0),
    ...(fallbackSlot.meshes.length > 0 ? [fallbackSlot] : []),
  ];
  slots.sort((a, b) => {
    const score = (s: VehicleMaterialSlot) =>
      /Body|Livery|Decals/.test(s.section) ? 0 : s.section === 'Other' ? 2 : 1;
    return score(a) - score(b);
  });

  // Centre model at origin for natural orbiting.
  const box    = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box.getCenter(center);
  root.position.sub(center);

  const size = new THREE.Vector3();
  box.getSize(size);

  return { root, slots, meshes, size, center: new THREE.Vector3(0, 0, 0) };
}

/**
 * Build UV-edge line segments for every mesh in a slot, in [0,1] UV space.
 * Returns flat pairs of [x0,y0,x1,y1, …] suitable for drawing a UV wireframe.
 */
export function slotUVEdges(slot: VehicleMaterialSlot): Float32Array {
  const segs: number[] = [];

  for (const mesh of slot.meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv) continue;

    const pushTri = (a: number, b: number, c: number) => {
      const ax = uv.getX(a), ay = uv.getY(a);
      const bx = uv.getX(b), by = uv.getY(b);
      const cx = uv.getX(c), cy = uv.getY(c);
      segs.push(ax, ay, bx, by, bx, by, cx, cy, cx, cy, ax, ay);
    };

    if (geo.index) {
      const idx = geo.index;
      for (let i = 0; i < idx.count; i += 3) {
        pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      }
    } else {
      for (let i = 0; i < uv.count; i += 3) pushTri(i, i + 1, i + 2);
    }
  }

  return new Float32Array(segs);
}

/** Read the original texture of a slot into an ImageData (or null if none). */
export function slotTextureToImageData(slot: VehicleMaterialSlot): ImageData | null {
  const tex = slot.originalMap;
  const img = tex?.image as (HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined);
  if (!img) return null;
  const w = (img as any).width || 0;
  const h = (img as any).height || 0;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  try {
    ctx.drawImage(img as CanvasImageSource, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }
}
