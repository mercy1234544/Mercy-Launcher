// Generate UV Template — for vehicles with no usable livery UV layout.
//
// Real box/planar-projection unwrap: for each selected mesh (body panel),
// drop its THINNEST bounding-box axis and project vertices onto the plane
// of the other two, normalized to a uniform scale (no stretching), then
// pack every panel into a shared texture SIZED PROPORTIONALLY TO ITS REAL
// 3D FOOTPRINT (shelf/bin packing, not a uniform grid) so panels never
// overlap. This is the same simplification every basic "UV unwrap" tool
// uses for near-flat panels (doors, hood, roof, bumpers) — not a full
// LSCM/ABF unwrapper, but a real, working algorithm, not a placeholder.
//
// Applied immediately to the live Three.js geometry so painting + the live
// 3D preview work right away in this session; see yftWriter.ts for writing
// the same UVs back into the real YFT file in place.
import * as THREE from 'three';
import type { LoadedVehicle } from '../glbVehicle';

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

/** A panel's real-world footprint — the area of its two LARGEST bounding-box
 *  dimensions (the plane it actually faces), used both to filter out tiny
 *  hardware and to size its UV island proportionally during packing. */
function panelFootprintArea(mesh: THREE.Mesh): number {
  const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr || posAttr.count === 0) return 0;
  const box = new THREE.Box3().setFromBufferAttribute(posAttr);
  const size = new THREE.Vector3(); box.getSize(size);
  const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
  return dims[1] * dims[2];
}

/**
 * REAL FIX for "Generate UV Template produces a scattered, unusable mess":
 * the old candidate list was every mesh on the vehicle — wheels, lights,
 * interior, glass, badges, and dozens of tiny painted hardware bits
 * (handles, mirror caps, antenna bases, splitters) that share the body
 * paint shader but aren't themselves a panel. Selecting that many
 * wildly-different-sized fragments is exactly what produced the "tiny
 * disconnected pieces everywhere" layout users reported — there's no way
 * to pack dozens of unrelated shapes into something that reads as "a car".
 *
 * This narrows the candidate list to only the meshes whose MATERIAL is
 * classified 'Body / Livery' (the vehicle's own paint shader — the same
 * classification VehicleMaterialSlot.section already uses to float paint
 * slots to the top of the texture list), then drops anything under 3% of
 * the largest body panel's real footprint area — keeping hood/doors/roof/
 * fenders/bumpers/trunk, dropping handles/trim/mirror caps/antenna mounts.
 * Falls back to every mesh on the vehicle if no paint-shaded material was
 * found at all (an unusual vehicle, but never leave the user with zero
 * choices).
 */
export function selectBodyPanels(vehicle: LoadedVehicle): PanelInfo[] {
  const bodyMeshes = new Set<THREE.Mesh>();
  for (const slot of vehicle.slots) {
    if (slot.section === 'Body / Livery') for (const m of slot.meshes) bodyMeshes.add(m);
  }
  const candidates = listPanels(Array.from(bodyMeshes));
  if (candidates.length === 0) return listPanels(vehicle.meshes);

  const areaByMesh = new Map(candidates.map((p) => [p.mesh, panelFootprintArea(p.mesh)] as const));
  const maxArea = Math.max(...areaByMesh.values());
  if (maxArea <= 1e-8) return candidates; // degenerate geometry — don't filter blindly

  const MIN_AREA_FRACTION = 0.03;
  const majorPanels = candidates.filter((p) => (areaByMesh.get(p.mesh) ?? 0) >= maxArea * MIN_AREA_FRACTION);
  return majorPanels.length > 0 ? majorPanels : candidates;
}

export function generateBoxProjectedUVs(meshes: THREE.Mesh[], padding = 0.04): GeneratedUV[] {
  if (meshes.length === 0) return [];

  // 1. Project each panel onto its own best-fit plane (drop the thinnest
  //    bounding-box axis), in REAL-WORLD units — not yet packed or scaled
  //    into [0,1]. Keeping raw local (a,b) + the panel's real width/height
  //    lets step 2 size every island proportionally to its true size
  //    instead of forcing every panel into an identical cell.
  interface Projected { mesh: THREE.Mesh; w: number; h: number; local: Float32Array }
  const projected: Projected[] = meshes.map((mesh) => {
    const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = posAttr.count;
    const box = new THREE.Box3().setFromBufferAttribute(posAttr);
    const size = new THREE.Vector3(); box.getSize(size);
    const axes: Axis[] = (['x', 'y', 'z'] as Axis[]).sort((a, b) => size[a] - size[b]);
    const [, axisA, axisB] = axes;
    const minA = box.min[axisA], minB = box.min[axisB];
    const w = Math.max(size[axisA], 1e-5), h = Math.max(size[axisB], 1e-5);
    const getA = AXIS_GETTER[axisA], getB = AXIS_GETTER[axisB];
    const local = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      local[i * 2] = (posAttr[getA] as (i: number) => number)(i) - minA;
      local[i * 2 + 1] = (posAttr[getB] as (i: number) => number)(i) - minB;
    }
    return { mesh, w, h, local };
  });

  // 2. REAL FIX for "scattered fragments instead of a clean packed sheet":
  //    shelf-pack every island at ONE SHARED, consistent texel density
  //    (derived from the total real footprint area) instead of the old
  //    uniform NxN grid that forced a tiny trim piece and a whole door
  //    into identically-sized cells — which is what made the output look
  //    like random noise rather than a readable vehicle template. Bigger
  //    real panels now get bigger islands; smaller panels get smaller
  //    ones, same as Zoov.dev/FiveForge-style templates.
  const items = projected.map((p, i) => ({ i, w: p.w, h: p.h }));
  items.sort((a, b) => b.h - a.h); // tallest first — classic shelf packing

  const totalArea = items.reduce((s, it) => s + it.w * it.h, 0);
  const sheetSide = Math.sqrt(totalArea) * 1.15 || 1; // +15% slack for shelf waste/padding
  const scale = 1 / sheetSide;

  const pad = padding;
  let shelfX = pad, shelfY = pad, shelfH = 0;
  const placements = new Map<number, { x: number; y: number; w: number; h: number }>();
  for (const it of items) {
    const w = it.w * scale, h = it.h * scale;
    if (shelfX + w + pad > 1 && shelfX > pad) { // new shelf row (never on an empty row)
      shelfY += shelfH + pad;
      shelfX = pad;
      shelfH = 0;
    }
    placements.set(it.i, { x: shelfX, y: shelfY, w, h });
    shelfX += w + pad;
    shelfH = Math.max(shelfH, h);
  }

  // Rescale so the packed sheet (plus trailing padding on the far/bottom
  // edge, matching the padding already applied on the near/top edge) fits
  // the real [0,1] texture exactly — correct regardless of how far off the
  // sheetSide heuristic above was.
  const maxX = Math.max(...Array.from(placements.values()).map((p) => p.x + p.w)) + pad;
  const maxY = Math.max(...Array.from(placements.values()).map((p) => p.y + p.h)) + pad;
  const fit = Math.min(1 / maxX, 1 / maxY);

  return projected.map((p, i) => {
    const placement = placements.get(i)!;
    const u0 = placement.x * fit, v0 = placement.y * fit;
    const spanU = placement.w * fit, spanV = placement.h * fit;
    const count = p.local.length / 2;
    const uvs = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      const nu = p.w > 1e-9 ? Math.min(1, Math.max(0, p.local[v * 2] / p.w)) : 0;
      const nv = p.h > 1e-9 ? Math.min(1, Math.max(0, p.local[v * 2 + 1] / p.h)) : 0;
      uvs[v * 2] = u0 + nu * spanU;
      uvs[v * 2 + 1] = v0 + nv * spanV;
    }
    return { mesh: p.mesh, uvs };
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
