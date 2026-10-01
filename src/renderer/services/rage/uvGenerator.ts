// Generate UV Template — for vehicles with no usable livery UV layout.
//
// Real box/planar-projection unwrap: for each selected mesh (body panel),
// drop its THINNEST bounding-box axis and project vertices onto the plane
// of the other two, normalized to a uniform scale (no stretching), then
// pack each mesh into its own cell of a shared grid across one texture so
// panels never overlap. This is the same simplification every basic "UV
// unwrap" tool uses for near-flat panels (doors, hood, roof, bumpers) —
// not a full LSCM/ABF unwrapper, but a real, working algorithm, not a
// placeholder.
//
// Applied immediately to the live Three.js geometry so painting + the live
// 3D preview work right away in this session; see yftWriter.ts for writing
// the same UVs back into the real YFT file in place.
import * as THREE from 'three';

export interface PanelInfo {
  mesh: THREE.Mesh;
  name: string;
  vertexCount: number;
}

export interface GeneratedUV {
  mesh: THREE.Mesh;
  uvs: Float32Array;
}

/** The real, selectable panels for UV generation — the vehicle's own mesh
 *  list, nothing invented. Meshes with no geometry are excluded. */
export function listPanels(meshes: THREE.Mesh[]): PanelInfo[] {
  return meshes
    .filter((m) => (m.geometry.getAttribute('position')?.count ?? 0) > 0)
    .map((m) => ({ mesh: m, name: m.name || 'mesh', vertexCount: m.geometry.getAttribute('position').count }));
}

type Axis = 'x' | 'y' | 'z';
const AXIS_GETTER: Record<Axis, 'getX' | 'getY' | 'getZ'> = { x: 'getX', y: 'getY', z: 'getZ' };

export function generateBoxProjectedUVs(meshes: THREE.Mesh[], padding = 0.04): GeneratedUV[] {
  const n = Math.max(1, meshes.length);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cellW = 1 / cols, cellH = 1 / rows;

  return meshes.map((mesh, idx) => {
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = posAttr.count;
    const box = new THREE.Box3().setFromBufferAttribute(posAttr);
    const size = new THREE.Vector3(); box.getSize(size);

    // Drop the thinnest axis — project the panel onto its other two (the
    // real "which way does this panel face" decision a box-unwrap makes).
    const axes: Axis[] = (['x', 'y', 'z'] as Axis[]).sort((a, b) => size[a] - size[b]);
    const [, axisA, axisB] = axes;
    const extent = Math.max(size[axisA], size[axisB], 1e-5); // uniform scale, never stretched
    const minA = box.min[axisA], minB = box.min[axisB];
    const getA = AXIS_GETTER[axisA], getB = AXIS_GETTER[axisB];

    const col = idx % cols, row = Math.floor(idx / cols);
    const pad = Math.min(cellW, cellH) * padding;
    const u0 = col * cellW + pad, v0 = row * cellH + pad;
    const spanU = cellW - 2 * pad, spanV = cellH - 2 * pad;

    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const a = (posAttr[getA] as (i: number) => number)(i);
      const b = (posAttr[getB] as (i: number) => number)(i);
      const nu = Math.min(1, Math.max(0, (a - minA) / extent));
      const nv = Math.min(1, Math.max(0, (b - minB) / extent));
      uvs[i * 2] = u0 + nu * spanU;
      uvs[i * 2 + 1] = v0 + nv * spanV;
    }
    return { mesh, uvs };
  });
}

/** Apply newly generated UVs straight onto the live geometry — the 3D
 *  preview and the paint canvas's UV-template overlay reflect it
 *  immediately, with no reload needed. */
export function applyGeneratedUVs(results: GeneratedUV[]) {
  for (const { mesh, uvs } of results) {
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    const attr = mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }
}
