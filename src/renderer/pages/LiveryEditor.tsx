import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Eye, EyeOff, Trash2, ChevronUp, ChevronDown, Download, Palette, ZoomIn, ZoomOut,
  Plus, Car, Grid3x3, Type, Brush, MousePointer, Layers as LayersIcon,
  FolderOpen, Box, Loader2, ChevronLeft, ArrowLeft, Wand2, Square, Stethoscope, X,
  CheckCircle2, XCircle, FileText, Image as ImageIcon,
  RotateCcw, Scan, BoxSelect, TriangleRight, Circle, Minus, Droplets,
  Undo2, Redo2, PaintBucket, Slash, Lock, Unlock, Save, Zap,
} from 'lucide-react';
import { ddsToImageData, extractTexturesFromYTD } from '../services/ytdParser';
import { loadVehicle, type DetectedVehicle, type LoadStage, type VehicleDiagnostics } from '../services/vehicleResourceLoader';
import type { VehicleTexture } from '../services/rage/ytd';
import type { LoadedVehicle, VehicleMaterialSlot } from '../services/glbVehicle';
import { slotUVEdges } from '../services/glbVehicle';
import { VehicleViewer } from '../services/vehicleViewer';
import { LIVERY_ASSETS, applyAsset, assetThumbnail, renderNumberSticker, type NumberStyle, type NumberOptions } from '../services/liveryAssets';
import { replaceTexturesInYTD } from '../services/rage/ytdWriter';
import { writeUVsToYFT } from '../services/rage/yftWriter';
import { listPanels, generateBoxProjectedUVs, applyGeneratedUVs, type PanelInfo } from '../services/rage/uvGenerator';
import { EXPORTERS, downloadResult } from '../services/liveryExport';

// ── Layer model ─────────────────────────────────────────────────────────────
type LayerKind = 'base' | 'image' | 'paint' | 'text' | 'fill' | 'shape' | 'gradient';
interface Layer {
  id: string; name: string; kind: LayerKind; visible: boolean; opacity: number;
  blendMode: GlobalCompositeOperation; canvas: HTMLCanvasElement;
  x: number; y: number; w: number; h: number;
  /** Radians, rotated around the layer's own center. Only image/text/shape/
   *  gradient/fill layers are user-transformable (see TRANSFORMABLE_KINDS) —
   *  base and paint layers always cover the full texture and are never moved. */
  rotation?: number;
  locked?: boolean;
  text?: string; fontSize?: number; color?: string;
  textOutline?: boolean; textOutlineColor?: string; textOutlineWidth?: number;
  textShadow?: boolean; textShadowColor?: string;
}
const TRANSFORMABLE_KINDS = new Set<LayerKind>(['image', 'text', 'shape', 'gradient', 'fill']);
type TransformHandle = 'move' | 'tl' | 'tr' | 'bl' | 'br' | 'rotate';
const HANDLE_SIZE = 10;
const ROTATE_HANDLE_OFFSET = 28;
interface TargetEdit { layers: Layer[]; canvas: HTMLCanvasElement; w: number; h: number; }
interface EditTarget { id: string; name: string; format: string; w: number; h: number; base: ImageData | null; }
interface UndoHistory { undo: ImageData[]; redo: ImageData[]; }
type DrawTool = 'select' | 'brush' | 'rect' | 'ellipse' | 'line' | 'gradient' | 'fill';
type ShapeFill = 'stroke' | 'fill' | 'both';

const BLEND_MODES: GlobalCompositeOperation[] = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'hard-light', 'soft-light', 'difference', 'exclusion',
];

function newCanvas(w: number, h: number) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function uid() { return Math.random().toString(36).slice(2); }
function canvasFromImageData(id: ImageData) { const c = newCanvas(id.width, id.height); c.getContext('2d')!.putImageData(id, 0, 0); return c; }
function renderTextLayer(l: Layer) {
  const ctx = l.canvas.getContext('2d')!;
  ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  ctx.font = `bold ${l.fontSize || 80}px Arial Black, Arial, sans-serif`;
  ctx.textBaseline = 'top';
  const txt = l.text || 'TEXT';
  if (l.textShadow) {
    ctx.shadowColor = l.textShadowColor || 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 8; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3;
  }
  if (l.textOutline) {
    ctx.strokeStyle = l.textOutlineColor || '#000';
    ctx.lineWidth = l.textOutlineWidth ?? 4;
    ctx.lineJoin = 'round';
    ctx.strokeText(txt, 20, 20);
  }
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  ctx.fillStyle = l.color || '#fff';
  ctx.fillText(txt, 20, 20);
}

type Phase = 'empty' | 'list' | 'loading' | 'edit';

// Compact key/value row for the material inspector. `ok` shows a YTD-resolution tick.
function Row({ k, v, ok }: { k: string; v?: string; ok?: boolean }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-surface-600 w-14 shrink-0">{k}</span>
      <span className="text-surface-300 truncate flex-1" title={v}>{v || '—'}</span>
      {v && ok !== undefined && (
        <span className={ok ? 'text-emerald-400' : 'text-red-400'}>{ok ? '✓' : '✗'}</span>
      )}
    </div>
  );
}

export interface LiveryWorkspaceProps {
  /** When set, the editor auto-scans this folder on mount instead of
   *  showing the "Open a Vehicle Resource" landing screen — used when
   *  embedded as Vehicle Studio's Livery tab, which already has a real
   *  imported workspace folder (scan.root) and should never make the user
   *  pick a folder a second time. */
  initialRoot?: string;
  /** True when rendered inside Vehicle Studio's tab layout rather than as
   *  the standalone /livery page — hides the standalone page's own back
   *  button and title (Vehicle Studio's own header already shows both). */
  embedded?: boolean;
}

export function LiveryWorkspace({ initialRoot, embedded }: LiveryWorkspaceProps) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>('empty');
  const [vehicles, setVehicles] = useState<DetectedVehicle[]>([]);
  const [folderName, setFolderName] = useState('');
  const [activeVehicle, setActiveVehicle] = useState<DetectedVehicle | null>(null);
  const [loadStage, setLoadStage] = useState<string>('');
  const [targets, setTargets] = useState<EditTarget[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<LoadedVehicle | null>(null);
  const [geomReason, setGeomReason] = useState<string | undefined>();
  const [diagnostics, setDiagnostics] = useState<VehicleDiagnostics | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [showAllTex, setShowAllTex] = useState(false);
  const [showAssets, setShowAssets] = useState(false);
  const [assetCat, setAssetCat] = useState<string>('police');
  const [numText, setNumText] = useState('99');
  const [numStyle, setNumStyle] = useState<NumberStyle>('block');
  const [numFill, setNumFill] = useState('#ffffff');
  const [numOutline, setNumOutline] = useState('#000000');
  const [numBg, setNumBg] = useState('#1a2b6b');
  const [numScale, setNumScale] = useState(1.0);
  const [view, setView] = useState<'browser' | 'editor'>('browser');
  const [wireframe, setWireframe] = useState(false);
  const [pickedSlotId, setPickedSlotId] = useState<string | null>(null);
  const [forceTexOn, setForceTexOn] = useState(false);
  // True when the CURRENTLY SELECTED texture had no direct material match
  // and composite() auto-applied it to every material as a fallback — a
  // real status, not a toggle, shown so the user knows why (and that
  // nothing is broken, Auto Sync handled it).
  const [autoSyncedAll, setAutoSyncedAll] = useState(false);
  const [uvDebug, setUvDebug] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [sectionDebug, setSectionDebug] = useState(false);
  const [pickedMesh, setPickedMesh] = useState<string>('');
  const replaceTargetRef = useRef<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [activeLayerId, setActiveLayerId] = useState<string | null>(null);
  const [tool, setTool] = useState<DrawTool>('select');
  const [brushColor, setBrushColor] = useState('#ff3344');
  const [brushColor2, setBrushColor2] = useState('#0033ff');
  const [brushSize, setBrushSize] = useState(24);
  const [shapeFill, setShapeFill] = useState<ShapeFill>('fill');
  const [zoom, setZoom] = useState(0.4);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [exporterId, setExporterId] = useState('png');
  const [showUVOverlay, setShowUVOverlay] = useState(true);
  const [showUVGen, setShowUVGen] = useState(false);
  const [uvGenSelected, setUvGenSelected] = useState<Set<string>>(new Set());
  const [uvGenBusy, setUvGenBusy] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);

  const edits = useRef<Map<string, TargetEdit>>(new Map());
  const historyRef = useRef<Map<string, UndoHistory>>(new Map());
  const centerCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const uvCanvas = useRef<HTMLCanvasElement>(null);
  const viewerMount = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<VehicleViewer | null>(null);
  const texInput = useRef<HTMLInputElement>(null);
  const painting = useRef(false);
  const panning = useRef(false);
  const shapeStart = useRef<{ x: number; y: number } | null>(null);
  const lastPt = useRef({ x: 0, y: 0 });
  // The last point a brush dab was stamped at — separate from `lastPt` (which
  // tracks panning) so fast strokes can be line-interpolated instead of
  // leaving gaps between discrete dabs.
  const lastPaintPt = useRef<{ x: number; y: number } | null>(null);
  // PERFORMANCE FIX for "painting is laggy": a pointermove fires far more
  // often than the screen can usefully redraw. Painting itself (stamping a
  // dab onto the small active-layer canvas) stays immediate, but the
  // expensive part — recompositing every layer across the full texture and
  // re-uploading it to the GPU for the 3D preview — is batched to at most
  // once per animation frame via this flag, instead of once per pointer
  // event (which can fire 100+ times/second).
  const renderPending = useRef(false);
  // Cached per-target UV wireframe edges (see slotUVEdges in glbVehicle.ts) —
  // computed once when a texture/geometry is selected, never recomputed on
  // every paint stroke or pan/zoom.
  const uvEdgesByTarget = useRef<Map<string, Float32Array[]>>(new Map());
  // Active image/text/shape/gradient/fill layer transform gesture (move,
  // corner-resize, or rotate) — see TRANSFORMABLE_KINDS.
  const transformGesture = useRef<{
    handle: TransformHandle; startX: number; startY: number;
    layer: { x: number; y: number; w: number; h: number; rotation: number };
  } | null>(null);
  // ── Generate UV Template state ──────────────────────────────────────────
  // For a texture target created by "Generate UV Template" (no real YTD
  // entry ever existed for it), composite()'s normal name-based material
  // matching has nothing to match against — this records EXACTLY which
  // material slots that target's selected panels actually belong to, so it
  // goes straight there instead of falling back to "every material on the
  // car" (which would be wrong — only the panels the user picked for this
  // template should show it).
  const generatedTargetSlots = useRef<Map<string, Set<string>>>(new Map());
  // mesh name -> newly-generated UVs, kept so Save can also patch them back
  // into the real YFT file in place (see yftWriter.ts).
  const pendingUVPatches = useRef<Map<string, Float32Array>>(new Map());
  // Keep a ref to targets so the slot-pick handler never captures a stale closure.
  const targetsRef = useRef<EditTarget[]>([]);
  useEffect(() => { targetsRef.current = targets; }, [targets]);

  // Spin up / replace the Three.js viewer when the editor tab is active AND geometry loaded.
  // The viewerMount div only exists in the DOM when view === 'editor', so we must
  // also depend on `view` to catch the case where geometry loaded while in browser view.
  useEffect(() => {
    viewerRef.current?.dispose();
    viewerRef.current = null;

    // Only initialise when the 3D panel is actually rendered.
    if (!geometry || view !== 'editor' || !viewerMount.current) return;

    const v = new VehicleViewer(viewerMount.current);
    v.setVehicle(geometry);

    // Clicking a mesh → select the matching texture (uses ref, not stale closure).
    v.onPickSlot = (slotId, meshName) => {
      const slot = geometry.slots.find((s) => s.id === slotId);
      if (!slot) return;
      setPickedSlotId(slotId);
      setPickedMesh(meshName);
      const currentTargets = targetsRef.current;
      const match =
        currentTargets.find((t) => t.name === slot.textureHint) ||
        currentTargets.find((t) => t.name === slot.name) ||
        currentTargets.find((t) => slot.name.toLowerCase().includes(t.name.toLowerCase())) ||
        null;
      if (match) { selectTarget(match.id); }
      v.highlightSlot(slotId);
    };

    viewerRef.current = v;
    return () => { v.dispose(); viewerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, view]);

  // ── Folder workflow ──────────────────────────────────────────────────────────
  const scanDir = useCallback(async (dir: string) => {
    try {
      const res = await window.electronAPI.livery.scanFolder(dir);
      if (!res.vehicles.length) { toast.error('No .yft/.ytd vehicle files found in that folder'); return; }
      setVehicles(res.vehicles);
      setFolderName(res.root.split(/[\\/]/).pop() || res.root);
      setPhase('list');
    } catch (e: any) {
      toast.error(e?.message || 'Scan failed');
    }
  }, []);

  const openFolder = useCallback(async () => {
    const dir = await window.electronAPI.livery.pickFolder();
    if (!dir) return;
    scanDir(dir);
  }, [scanDir]);

  // Embedded in Vehicle Studio: the user already imported a workspace
  // (scan.root) — auto-scan it immediately instead of showing the "Open a
  // Vehicle Resource" landing screen a second time.
  useEffect(() => {
    if (initialRoot) scanDir(initialRoot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoot]);

  const selectVehicle = useCallback(async (v: DetectedVehicle) => {
    setActiveVehicle(v);
    setPhase('loading');
    setGeometry(null); setGeomReason(undefined);
    edits.current.clear();
    // Target ids are index-based (tex_0, tex_1, …) and get reused across
    // vehicles — a stale UV-edge cache from the PREVIOUS vehicle would
    // silently draw the wrong wireframe on this one.
    uvEdgesByTarget.current.clear();
    generatedTargetSlots.current.clear();
    pendingUVPatches.current.clear();
    setUvGenSelected(new Set());
    const stageText: Record<LoadStage, string> = {
      scanning: 'Scanning files…', reading: 'Reading model…',
      textures: 'Reading textures…', geometry: 'Building preview…', done: 'Done',
    };
    try {
      const result = await loadVehicle(v, (s) => setLoadStage(stageText[s] || ''));
      const tg: EditTarget[] = result.textures.map((t: VehicleTexture, i) => ({
        id: `tex_${i}`, name: t.name, format: t.format, w: t.width, h: t.height, base: t.imageData,
      }));
      setTargets(tg);
      setGeometry(result.geometry);
      setGeomReason(result.geometryReason);
      setDiagnostics(result.diagnostics);
      setPhase('edit');
      setView('browser');
      if (tg.length) {
        setTimeout(() => selectTarget(tg[0].id, tg), 0);
      } else {
        // Never fail silently — surface the diagnostics so we can see why.
        setShowAllTex(true);
        setShowDiag(true);
        toast('No editable textures decoded — opening diagnostics', { icon: '🔬' });
      }
    } catch (e: any) {
      toast.error(e?.message || 'Load failed');
      setPhase('list');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Embedded + exactly one vehicle in the resource: skip the pick-a-vehicle
  // list too — most FiveM vehicle resources contain just one model, and the
  // whole point of embedding this in Vehicle Studio is removing extra
  // clicks before painting.
  useEffect(() => {
    if (initialRoot && phase === 'list' && vehicles.length === 1) selectVehicle(vehicles[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoot, phase, vehicles]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selected) return;
      if (e.ctrlKey && !e.shiftKey && e.key === 'z') { e.preventDefault(); applyUndo(selected); }
      if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); applyRedo(selected); }
      if (!e.ctrlKey && !e.altKey) {
        if (e.key === 'b' || e.key === 'B') setTool('brush');
        if (e.key === 'r' || e.key === 'R') setTool('rect');
        if (e.key === 'e' || e.key === 'E') setTool('ellipse');
        if (e.key === 'l' || e.key === 'L') setTool('line');
        if (e.key === 'g' || e.key === 'G') setTool('gradient');
        if (e.key === 'f' || e.key === 'F') setTool('fill');
        if (e.key === 'v' || e.key === 'V') setTool('select');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // ── Editing core (per texture target) ────────────────────────────────────────
  function ensureEdit(t: EditTarget): TargetEdit {
    let e = edits.current.get(t.id);
    if (e) return e;
    const layers: Layer[] = [];
    if (t.base) layers.push({
      id: uid(), name: 'Base texture', kind: 'base', visible: true, opacity: 100,
      blendMode: 'source-over', canvas: canvasFromImageData(t.base), x: 0, y: 0, w: t.w, h: t.h,
    });
    e = { layers, canvas: newCanvas(t.w, t.h), w: t.w, h: t.h };
    edits.current.set(t.id, e);
    composite(t.id);
    return e;
  }

  function targetById(id: string | null, list = targets) { return list.find((t) => t.id === id) || null; }

  function composite(id: string) {
    const e = edits.current.get(id); if (!e) return;
    const ctx = e.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, e.w, e.h);
    for (const l of e.layers) {
      if (!l.visible) continue;
      ctx.save(); ctx.globalAlpha = l.opacity / 100; ctx.globalCompositeOperation = l.blendMode;
      if (l.rotation) {
        const cx = l.x + l.w / 2, cy = l.y + l.h / 2;
        ctx.translate(cx, cy); ctx.rotate(l.rotation); ctx.translate(-cx, -cy);
      }
      ctx.drawImage(l.canvas, l.x, l.y, l.w, l.h); ctx.restore();
    }
    if (id === selected) drawCenter(e);

    // REAL FIX for "I have to click Force every time": push edited canvas
    // live onto EVERY material that references this texture (as diffuse or
    // any param), case-insensitively AND whitespace/null-trimmed — the
    // YFT/YTD binary parsers read fixed-length string fields and can leave
    // trailing padding that broke the old exact comparison for some
    // vehicles. "Auto Sync" (per the task spec) means this must never
    // require a manual click: if the targeted match finds zero materials
    // for the texture actually being edited, THIS IS THE ONLY TEXTURE BEING
    // PAINTED, so apply it everywhere automatically rather than silently
    // doing nothing — the same effect the old manual "Force" button had,
    // now automatic instead of a debug-only action. A real per-material
    // match (the common case for correctly-mapped vehicles) is always
    // preferred and never overridden.
    if (geometry && viewerRef.current) {
      const t = targets.find((tx) => tx.id === id);
      if (t) {
        // A "Generate UV Template" target has no real YTD entry to name-
        // match against — it was created for EXACTLY these material slots
        // (the panels the user selected), so go straight there instead of
        // falling through to "every material on the car".
        const explicitSlotIds = generatedTargetSlots.current.get(id);
        const norm = (s: string) => s.trim().replace(/\0+$/, '').toLowerCase();
        const tn = norm(t.name);
        let slots = explicitSlotIds
          ? geometry.slots.filter((s) => explicitSlotIds.has(s.id))
          : geometry.slots.filter(
              (s) => (s.textureHint && norm(s.textureHint) === tn) ||
                     s.textures.some((tx) => norm(tx) === tn)
            );
        let autoSynced = false;
        if (!explicitSlotIds && slots.length === 0) {
          slots = geometry.slots;
          autoSynced = slots.length > 0;
        }
        // REAL FIX for the painting freeze: push ONE shared GPU texture to
        // every matching slot (viewerRef.setTextureOnSlots), instead of the
        // old per-slot loop that created a SEPARATE full-resolution
        // CanvasTexture — and a separate GPU upload — for every single
        // material that referenced this texture. For a texture shared
        // across many body panels (completely normal), or whenever Auto
        // Sync falls back to "every material on the car", that used to
        // multiply the GPU upload cost by the slot count on EVERY
        // throttled frame — the actual cause of the multi-second-to-a-
        // minute freeze, not a missing frame-throttle (that part was
        // already correct).
        if (slots.length > 0) viewerRef.current.setTextureOnSlots(id, slots, e.canvas);
        if (id === selected) setAutoSyncedAll(autoSynced);
      }
    }
  }

  // Checker pattern built once (not per frame) — it's identical every time,
  // so rebuilding it on every paint stroke was pure waste on the main thread.
  const checkerPatternRef = useRef<HTMLCanvasElement | null>(null);
  function checkerPattern(): HTMLCanvasElement {
    if (checkerPatternRef.current) return checkerPatternRef.current;
    const pat = newCanvas(16, 16); const pc = pat.getContext('2d')!;
    pc.fillStyle = '#1a1c26'; pc.fillRect(0, 0, 16, 16);
    pc.fillStyle = '#232533'; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
    checkerPatternRef.current = pat;
    return pat;
  }

  function drawCenter(e: TargetEdit) {
    const cv = centerCanvas.current; if (!cv) return;
    cv.width = e.w; cv.height = e.h;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = ctx.createPattern(checkerPattern(), 'repeat')!; ctx.fillRect(0, 0, e.w, e.h);
    ctx.drawImage(e.canvas, 0, 0);
  }

  // PERFORMANCE FIX: the single most impactful change for brush lag. Paint
  // dabs themselves are cheap (they only touch the small active-layer
  // canvas), but composite() + drawCenter() + pushing the result to the GPU
  // for the live 3D preview each redraw the FULL texture (up to 4096×4096) —
  // genuinely expensive work that used to run synchronously on every single
  // pointermove event (which can fire 100+ times/second). Collapsing that
  // to at most once per animation frame removes the main-thread stutter
  // without changing what gets drawn.
  function scheduleRender(id: string) {
    if (renderPending.current) return;
    renderPending.current = true;
    requestAnimationFrame(() => { renderPending.current = false; composite(id); });
  }

  // ── UV template overlay ──────────────────────────────────────────────────
  // THE REAL FIX for "the paint area is just a plain square box": draw the
  // vehicle's actual UV-unwrap wireframe (which panel/part owns which pixels
  // of this texture) directly on top of the raw texture, exactly like
  // Zoov/FiveForge's livery templates. slotUVEdges() already existed in
  // glbVehicle.ts (built for this, never wired up) — it returns each
  // triangle edge in the mesh's real UV space; this just scales those
  // [0,1] coordinates into texture-pixel space and strokes them.
  function uvEdgesForTarget(t: EditTarget): Float32Array[] {
    const cached = uvEdgesByTarget.current.get(t.id);
    if (cached) return cached;
    const result: Float32Array[] = [];
    if (geometry) {
      const tn = t.name.toLowerCase();
      const slots = geometry.slots.filter(
        (s: VehicleMaterialSlot) => s.textureHint?.toLowerCase() === tn || s.textures.some((tx) => tx.toLowerCase() === tn)
      );
      for (const slot of slots) result.push(slotUVEdges(slot));
    }
    uvEdgesByTarget.current.set(t.id, result);
    return result;
  }

  function drawUVOverlay(t: EditTarget | null) {
    const cv = uvCanvas.current; if (!cv) return;
    if (!t || !showUVOverlay || !geometry) { cv.width = 1; cv.height = 1; return; }
    const edgeSets = uvEdgesForTarget(t);
    cv.width = t.w; cv.height = t.h;
    if (edgeSets.every((s) => s.length === 0)) return; // no UV data for this texture — draw nothing, not a wrong grid
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, t.w, t.h);
    ctx.strokeStyle = 'rgba(80,220,255,0.55)';
    ctx.lineWidth = Math.max(1, Math.min(2, t.w / 1024));
    ctx.beginPath();
    for (const edges of edgeSets) {
      for (let i = 0; i < edges.length; i += 4) {
        const x1 = edges[i] * t.w, y1 = (1 - edges[i + 1]) * t.h;
        const x2 = edges[i + 2] * t.w, y2 = (1 - edges[i + 3]) * t.h;
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
    }
    ctx.stroke();
  }

  function selectTarget(id: string, list = targets) {
    const t = targetById(id, list); if (!t) return;
    setSelected(id);
    // Reverse highlight: light up every mesh whose material uses this texture.
    if (geometry && viewerRef.current) {
      const tn = t.name.toLowerCase();
      const using = geometry.slots.filter(
        (s) => s.textureHint?.toLowerCase() === tn || s.textures.some((tx) => tx.toLowerCase() === tn));
      // eslint-disable-next-line no-console
      console.log(`[select] texture="${t.name}" maps to ${using.length} material slot(s):`,
        using.map((s) => `mat${s.materialIndex}/${s.shaderHash}(${s.meshes.length} mesh, uv${s.uvChannel})`));
      viewerRef.current.highlightSlot(using.length ? using.map((s) => s.id) : null);
    }
    const e = ensureEdit(t);
    setActiveLayerId(e.layers[e.layers.length - 1]?.id ?? null);
    requestAnimationFrame(() => { drawCenter(e); drawUVOverlay(t); });
    rerender();
  }

  // ── Generate UV Template ──────────────────────────────────────────────────
  // Real panel list for the picker — the vehicle's own meshes, nothing
  // invented. Available whenever geometry is loaded.
  const uvGenPanels: PanelInfo[] = geometry ? listPanels(geometry.meshes) : [];

  async function generateUVTemplate() {
    if (!geometry) return;
    const chosen = geometry.meshes.filter((m) => uvGenSelected.has(m.name));
    if (chosen.length === 0) { toast.error('Select at least one panel'); return; }

    setUvGenBusy(true);
    // Yield one frame so the "Generating…" spinner actually paints before
    // any work runs — this used to all happen synchronously inside the
    // click handler, so on a vehicle with many panels selected the UI
    // looked frozen/dead the instant Generate was clicked (same root cause
    // as the painting freeze: see composite()'s setTextureOnSlots fix —
    // that fix alone makes this fast now, but the explicit yield + spinner
    // keeps it honest even on a slow machine or a huge selection).
    await new Promise((r) => requestAnimationFrame(r));

    try {
      // 1. Real box-projection unwrap, applied straight to the live
      //    geometry — the 3D preview and the UV-template overlay reflect
      //    it immediately.
      const results = generateBoxProjectedUVs(chosen);
      applyGeneratedUVs(results);
      for (const { mesh, uvs } of results) pendingUVPatches.current.set(mesh.name, uvs);

      // 2. A fresh, blank, paintable texture for these panels specifically —
      //    composite() routes it straight to their real material slots (see
      //    generatedTargetSlots), never "every material on the car".
      const slotIds = new Set(
        geometry.slots.filter((s) => s.meshes.some((m) => chosen.includes(m))).map((s) => s.id)
      );
      const texSize = 2048;
      const genNumber = targets.filter((t) => t.id.startsWith('tex_generated_')).length + 1;
      const newId = `tex_generated_${uid()}`;
      const newName = `Generated Livery ${genNumber}`;
      generatedTargetSlots.current.set(newId, slotIds);
      const newTarget: EditTarget = { id: newId, name: newName, format: 'PNG', w: texSize, h: texSize, base: null };
      const nextTargets = [...targets, newTarget];
      setTargets(nextTargets);
      uvEdgesByTarget.current.delete(newId); // force a fresh UV-overlay computation for the new layout

      setShowUVGen(false);
      setUvGenSelected(new Set());
      setShowUVOverlay(true); // the whole point is seeing the new layout — never leave it hidden
      selectTarget(newId, nextTargets);
      setView('editor');
      setShowAllTex(false); // the new target must be visible in the real (not "show all debug") list
      toast.success(`Created "${newName}" (${texSize}×${texSize}) for ${chosen.length} panel${chosen.length !== 1 ? 's' : ''} — selected and ready to paint`, { duration: 6000 });
    } catch (err: any) {
      toast.error(`Generate UV Template failed: ${err?.message || 'Unknown error'}`, { duration: 8000 });
    } finally {
      setUvGenBusy(false);
    }
  }

  // ── Imports / layers ─────────────────────────────────────────────────────────
  function loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Image load failed')); };
      img.src = url;
    });
  }
  function loadImageFromURL(url: string): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img); img.onerror = () => rej(new Error('Image load failed'));
      img.src = url;
    });
  }

  const importTexture = useCallback(async (file: File) => {
    const t = targetById(selected); if (!t) { toast.error('Select a texture first'); return; }
    const e = ensureEdit(t);
    const name = file.name.toLowerCase();
    try {
      let id: ImageData | null = null;
      if (name.endsWith('.dds')) id = ddsToImageData(new Uint8Array(await file.arrayBuffer()));
      else if (name.endsWith('.ytd')) { const tx = await extractTexturesFromYTD(await file.arrayBuffer()); if (tx.length) id = ddsToImageData(tx[0].ddsBytes); }
      else if (name.endsWith('.svg')) {
        const svgText = await file.text();
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const img = await loadImageFromURL(url);
        URL.revokeObjectURL(url);
        const sw = img.naturalWidth || e.w, sh = img.naturalHeight || e.h;
        const c = newCanvas(e.w, e.h);
        // Scale SVG to fit the texture, centered
        const scale = Math.min(e.w / sw, e.h / sh);
        const dx = (e.w - sw * scale) / 2, dy = (e.h - sh * scale) / 2;
        c.getContext('2d')!.drawImage(img, dx, dy, sw * scale, sh * scale);
        addLayer(e, t.id, { kind: 'image', name: file.name, canvas: c, w: e.w, h: e.h });
        toast.success(`Imported SVG: ${file.name}`); return;
      } else if (name.match(/\.(png|jpe?g|webp|bmp)$/)) {
        const img = await loadImage(file); const c = newCanvas(img.naturalWidth, img.naturalHeight);
        c.getContext('2d')!.drawImage(img, 0, 0);
        addLayer(e, t.id, { kind: 'image', name: file.name, canvas: c, w: img.naturalWidth, h: img.naturalHeight });
        toast.success(`Added ${file.name}`); return;
      } else { toast.error('Supported: .dds .ytd .svg .png .jpg'); return; }
      if (!id) { toast.error('Could not decode texture'); return; }
      addLayer(e, t.id, { kind: 'image', name: file.name, canvas: canvasFromImageData(id), w: id.width, h: id.height });
      toast.success(`Added ${file.name}`);
    } catch (err: any) { toast.error(err?.message || 'Import failed'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, targets]);

  function addLayer(e: TargetEdit, id: string, p: Partial<Layer> & { kind: LayerKind; canvas: HTMLCanvasElement; w: number; h: number }) {
    const l: Layer = { id: uid(), name: p.name || p.kind, visible: true, opacity: 100, blendMode: 'source-over', x: 0, y: 0, ...p } as Layer;
    e.layers.push(l); setActiveLayerId(l.id); composite(id); rerender();
  }
  function addTextLayer() {
    const t = targetById(selected); if (!t) return; const e = ensureEdit(t);
    const c = newCanvas(e.w, e.h);
    const l: Layer = { id: uid(), name: 'Text', kind: 'text', visible: true, opacity: 100, blendMode: 'source-over', canvas: c, x: 0, y: 0, w: e.w, h: e.h, text: 'TEXT', fontSize: Math.round(e.h / 12), color: '#ffffff' };
    renderTextLayer(l); e.layers.push(l); setActiveLayerId(l.id); composite(t.id); rerender();
  }
  function addFillLayer() {
    const t = targetById(selected); if (!t) return; const e = ensureEdit(t);
    const c = newCanvas(e.w, e.h); const ctx = c.getContext('2d')!; ctx.fillStyle = brushColor; ctx.fillRect(0, 0, e.w, e.h);
    addLayer(e, t.id, { kind: 'fill', name: 'Fill', canvas: c, w: e.w, h: e.h, opacity: 60 });
  }
  // ── Asset library ────────────────────────────────────────────────────────────
  function applyLiveryAsset(assetId: string) {
    const t = targetById(selected); if (!t) { toast.error('Select a texture first'); return; }
    const e = ensureEdit(t);
    const asset = LIVERY_ASSETS.find((a) => a.id === assetId); if (!asset) return;
    pushUndo(t.id);
    const c = applyAsset(asset, e.w, e.h);
    addLayer(e, t.id, { kind: 'shape', name: asset.name, canvas: c, w: e.w, h: e.h, opacity: 85 });
    toast.success(`Applied: ${asset.name}`);
  }

  function applyNumberSticker() {
    const t = targetById(selected); if (!t) { toast.error('Select a texture first'); return; }
    if (!numText.trim()) { toast.error('Enter a number or text'); return; }
    const e = ensureEdit(t);
    pushUndo(t.id);
    const opts: NumberOptions = {
      text: numText.trim(), style: numStyle,
      fillColor: numFill, outlineColor: numOutline, bgColor: numBg,
      posX: 0.5, posY: 0.5, scale: numScale,
    };
    const c = renderNumberSticker(e.w, e.h, opts);
    addLayer(e, t.id, { kind: 'text', name: `#${numText}`, canvas: c, w: e.w, h: e.h });
    toast.success(`Applied number sticker: ${numText}`);
  }

  // ── Save / export ────────────────────────────────────────────────────────────
  function bufToB64(buf: Uint8Array): string {
    let b64 = ''; const chunk = 65536;
    for (let i = 0; i < buf.length; i += chunk)
      b64 += btoa(String.fromCharCode(...Array.from(buf.subarray(i, i + chunk))));
    return b64;
  }
  function b64ToBuf(b64: string): ArrayBuffer {
    const bin = atob(b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function saveActiveTexture() {
    const t = targetById(selected); if (!t) { toast.error('No texture selected'); return; }
    const e = edits.current.get(t.id); if (!e) { toast.error('No edits to save'); return; }
    const filePath = await window.electronAPI.livery.showSaveDialog({
      defaultPath: `${t.name}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (!filePath) return;
    e.canvas.toBlob(async (blob) => {
      if (!blob) { toast.error('Export failed'); return; }
      const b64 = bufToB64(new Uint8Array(await blob.arrayBuffer()));
      const ok = await window.electronAPI.livery.writeFile(filePath, b64);
      if (ok) toast.success(`Saved to ${filePath.split(/[\\/]/).pop()}`);
      else toast.error('Write failed');
    }, 'image/png');
  }

  async function saveToYTD() {
    if (!diagnostics) { toast.error('Load a vehicle first'); return; }
    const t = targetById(selected); if (!t) { toast.error('Select a texture to save'); return; }
    const e = edits.current.get(t.id); if (!e) { toast.error('No edits on this texture'); return; }
    const ytdEntry = diagnostics.ytds.find((y) => y.textures.some((tx) => tx.name === t.name));
    if (!ytdEntry) { toast.error('Source YTD not found in diagnostics'); return; }
    const tid = toast.loading('Encoding and writing YTD…');
    try {
      const origB64 = await window.electronAPI.livery.readBinary(ytdEntry.path);
      const origBuf = b64ToBuf(origB64);
      const writeResult = await replaceTexturesInYTD(origBuf, [{ name: t.name, canvas: e.canvas }]);
      if (writeResult.replaced.length === 0) {
        toast.dismiss(tid);
        const reason = writeResult.skipped.find((s) => s.name === t.name)?.reason || 'Unknown';
        toast.error(`Save failed: ${reason}`); return;
      }
      // Backup original
      await window.electronAPI.livery.writeFile(ytdEntry.path + '.bak', origB64);
      // Write modified YTD
      await window.electronAPI.livery.writeFile(ytdEntry.path, bufToB64(new Uint8Array(writeResult.bytes)));
      toast.dismiss(tid);
      toast.success(`Saved to ${ytdEntry.fileName} · backup written to .ytd.bak`);
    } catch (err: any) {
      toast.dismiss(tid);
      toast.error(err?.message || 'YTD save failed');
    }
  }

  async function batchSaveToYTD() {
    if (!diagnostics || !activeVehicle) { toast.error('Load a vehicle first'); return; }
    const editedTargets = targets.filter((t) => edits.current.has(t.id));
    if (editedTargets.length === 0) { toast.error('No textures have been edited'); return; }
    // Group by source YTD
    const byYtd = new Map<string, Array<{ name: string; canvas: HTMLCanvasElement }>>();
    // "Generate UV Template" targets have no existing YTD entry to replace —
    // there's no writer that can ADD a brand-new texture into a YTD's
    // dictionary (only replace an existing same-size one), so those are
    // exported as a loose PNG instead of silently losing the painted work.
    const unmatchedGenerated: EditTarget[] = [];
    for (const t of editedTargets) {
      const e = edits.current.get(t.id)!;
      const ytdEntry = diagnostics.ytds.find((y) => y.textures.some((tx) => tx.name === t.name));
      if (!ytdEntry) { unmatchedGenerated.push(t); continue; }
      if (!byYtd.has(ytdEntry.path)) byYtd.set(ytdEntry.path, []);
      byYtd.get(ytdEntry.path)!.push({ name: t.name, canvas: e.canvas });
    }
    if (byYtd.size === 0 && unmatchedGenerated.length === 0 && pendingUVPatches.current.size === 0) {
      toast.error('Could not match edits to YTD files'); return;
    }
    const tid = toast.loading(`Saving ${editedTargets.length} texture(s)…`);
    let totalReplaced = 0, totalSkipped = 0;
    try {
      for (const [ytdPath, reps] of byYtd) {
        const origB64 = await window.electronAPI.livery.readBinary(ytdPath);
        const origBuf = b64ToBuf(origB64);
        const wr = await replaceTexturesInYTD(origBuf, reps);
        if (wr.replaced.length > 0) {
          await window.electronAPI.livery.writeFile(ytdPath + '.bak', origB64);
          await window.electronAPI.livery.writeFile(ytdPath, bufToB64(new Uint8Array(wr.bytes)));
        }
        totalReplaced += wr.replaced.length;
        totalSkipped += wr.skipped.length;
      }

      // Generated-livery targets: export as PNG next to the vehicle's files
      // — honest about there being no YTD slot to write into yet.
      const exportedPaths: string[] = [];
      for (const t of unmatchedGenerated) {
        const e = edits.current.get(t.id)!;
        const pngPath = `${activeVehicle!.dir}/${t.name}.png`.replace(/\\/g, '/');
        const b64 = await new Promise<string>((res) => e.canvas.toBlob(async (blob) => {
          res(blob ? bufToB64(new Uint8Array(await blob.arrayBuffer())) : '');
        }, 'image/png'));
        if (b64 && await window.electronAPI.livery.writeFile(pngPath, b64)) exportedPaths.push(`${t.name}.png`);
      }

      // Write any generated UVs back into the real YFT (in place — same
      // vertex count/stride/offsets, see yftWriter.ts's own header).
      let uvPatchResult: { patched: number; skipped: number } | null = null;
      if (pendingUVPatches.current.size > 0 && geometry) {
        const modelPath = activeVehicle.hiYft || activeVehicle.yft;
        if (modelPath) {
          const patches = geometry.meshes
            .filter((m) => pendingUVPatches.current.has(m.name))
            .map((m) => ({ mesh: m, uvs: pendingUVPatches.current.get(m.name)! }));
          const origB64 = await window.electronAPI.livery.readBinary(modelPath);
          const origBuf = b64ToBuf(origB64);
          const wr = await writeUVsToYFT(origBuf, patches);
          if (wr.patchedMeshes.length > 0) {
            await window.electronAPI.livery.writeFile(modelPath + '.bak', origB64);
            await window.electronAPI.livery.writeFile(modelPath, bufToB64(new Uint8Array(wr.bytes)));
          }
          uvPatchResult = { patched: wr.patchedMeshes.length, skipped: wr.skipped.length };
          if (wr.patchedMeshes.length > 0) pendingUVPatches.current.clear();
        }
      }

      toast.dismiss(tid);
      const parts: string[] = [];
      if (totalReplaced > 0) parts.push(`${totalReplaced} texture(s) saved to YTD`);
      if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
      if (exportedPaths.length > 0) parts.push(`${exportedPaths.length} exported as PNG (no existing YTD slot — add via your texture tool)`);
      if (uvPatchResult) parts.push(`${uvPatchResult.patched} mesh(es) UV-updated in the .yft${uvPatchResult.skipped ? ` (${uvPatchResult.skipped} skipped)` : ''}`);
      if (parts.length === 0) { toast.error('Nothing could be saved'); return; }
      toast.success(parts.join(' · '), { duration: 7000 });
    } catch (err: any) {
      toast.dismiss(tid);
      toast.error(err?.message || 'Batch save failed');
    }
  }

  function ensurePaintLayer(e: TargetEdit): Layer {
    // Check if active layer is locked
    const activeLyr = e.layers.find((x) => x.id === activeLayerId);
    if (activeLyr?.locked) { toast('Layer is locked', { icon: '🔒' }); return activeLyr; }
    let l = e.layers.find((x) => x.id === activeLayerId && x.kind === 'paint');
    if (!l) { l = { id: uid(), name: 'Paint', kind: 'paint', visible: true, opacity: 100, blendMode: 'source-over', canvas: newCanvas(e.w, e.h), x: 0, y: 0, w: e.w, h: e.h }; e.layers.push(l); setActiveLayerId(l.id); rerender(); }
    return l;
  }
  // ── Undo / Redo ─────────────────────────────────────────────────────────────
  const MAX_HISTORY = 30;
  function getHistory(id: string): UndoHistory {
    let h = historyRef.current.get(id);
    if (!h) { h = { undo: [], redo: [] }; historyRef.current.set(id, h); }
    return h;
  }
  function pushUndo(id: string) {
    const e = edits.current.get(id); if (!e) return;
    const h = getHistory(id);
    const snap = e.canvas.getContext('2d')!.getImageData(0, 0, e.w, e.h);
    h.undo.push(snap);
    if (h.undo.length > MAX_HISTORY) h.undo.shift();
    h.redo = [];
  }
  function applyUndo(id: string) {
    const e = edits.current.get(id); if (!e) return;
    const h = getHistory(id); if (h.undo.length === 0) { toast('Nothing to undo', { icon: '↩' }); return; }
    const current = e.canvas.getContext('2d')!.getImageData(0, 0, e.w, e.h);
    h.redo.push(current);
    const prev = h.undo.pop()!;
    const c = newCanvas(e.w, e.h); c.getContext('2d')!.putImageData(prev, 0, 0);
    e.layers = [{ id: uid(), name: 'Undo state', kind: 'base', visible: true, opacity: 100, blendMode: 'source-over', canvas: c, x: 0, y: 0, w: e.w, h: e.h }];
    composite(id); rerender();
  }
  function applyRedo(id: string) {
    const e = edits.current.get(id); if (!e) return;
    const h = getHistory(id); if (h.redo.length === 0) { toast('Nothing to redo', { icon: '↪' }); return; }
    const current = e.canvas.getContext('2d')!.getImageData(0, 0, e.w, e.h);
    h.undo.push(current);
    const next = h.redo.pop()!;
    const c = newCanvas(e.w, e.h); c.getContext('2d')!.putImageData(next, 0, 0);
    e.layers = [{ id: uid(), name: 'Redo state', kind: 'base', visible: true, opacity: 100, blendMode: 'source-over', canvas: c, x: 0, y: 0, w: e.w, h: e.h }];
    composite(id); rerender();
  }

  function updateLayer(id: string, changes: Partial<Layer>) {
    const e = edits.current.get(selected || ''); if (!e) return;
    const l = e.layers.find((x) => x.id === id); if (!l) return;
    Object.assign(l, changes); if (l.kind === 'text') renderTextLayer(l);
    // Same throttling as painting — an opacity/blend-mode slider fires
    // onChange continuously while dragging, and a full recomposite on every
    // tick is exactly the same main-thread cost that made brushing laggy.
    scheduleRender(selected!); rerender();
  }
  function deleteLayer(id: string) {
    const e = edits.current.get(selected || ''); if (!e) return;
    e.layers = e.layers.filter((l) => l.id !== id);
    if (activeLayerId === id) setActiveLayerId(e.layers[e.layers.length - 1]?.id ?? null);
    composite(selected!); rerender();
  }
  function moveLayer(id: string, dir: -1 | 1) {
    const e = edits.current.get(selected || ''); if (!e) return;
    const i = e.layers.findIndex((l) => l.id === id); const j = i + dir;
    if (j < 0 || j >= e.layers.length) return;
    [e.layers[i], e.layers[j]] = [e.layers[j], e.layers[i]]; composite(selected!); rerender();
  }

  // ── Canvas interaction ───────────────────────────────────────────────────────
  function canvasPoint(ev: React.PointerEvent) {
    const cv = centerCanvas.current; if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * cv.width, y: ((ev.clientY - r.top) / r.height) * cv.height };
  }

  /** Stamp one dab, directly on the active paint layer — cheap (small
   *  canvas region), always synchronous. Never recomposites itself; callers
   *  batch that via scheduleRender(). */
  function stampDab(l: Layer, x: number, y: number) {
    const ctx = l.canvas.getContext('2d')!; ctx.fillStyle = brushColor;
    ctx.beginPath(); ctx.arc(x, y, brushSize, 0, Math.PI * 2); ctx.fill();
  }

  /** REAL FIX for choppy/dotted strokes: a fast mouse move can jump several
   *  brush-widths between two pointermove events, leaving gaps between
   *  discrete dabs. This stamps evenly-spaced dabs along the segment from
   *  the last painted point to the new one instead of just the endpoint. */
  function paintAt(p: { x: number; y: number }) {
    const e = edits.current.get(selected || ''); if (!e) return;
    const l = ensurePaintLayer(e);
    const prev = lastPaintPt.current;
    if (!prev) {
      stampDab(l, p.x, p.y);
    } else {
      const dx = p.x - prev.x, dy = p.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, brushSize / 3);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= steps; i++) stampDab(l, prev.x + (dx * i) / steps, prev.y + (dy * i) / steps);
    }
    lastPaintPt.current = p;
    scheduleRender(selected!);
  }

  function floodFill(x0: number, y0: number) {
    const e = edits.current.get(selected || ''); if (!e) return;
    pushUndo(selected!);
    const l = ensurePaintLayer(e);
    const ctx = l.canvas.getContext('2d')!;
    const iw = e.w, ih = e.h;
    const imgData = ctx.getImageData(0, 0, iw, ih);
    const data = imgData.data;
    const xi = Math.round(x0), yi = Math.round(y0);
    const idx = (yi * iw + xi) * 4;
    if (idx < 0 || idx >= data.length) return;
    const [tr, tg, tb, ta] = [data[idx], data[idx+1], data[idx+2], data[idx+3]];
    const fr = parseInt(brushColor.slice(1, 3), 16);
    const fg = parseInt(brushColor.slice(3, 5), 16);
    const fb = parseInt(brushColor.slice(5, 7), 16);
    if (tr === fr && tg === fg && tb === fb && ta === 255) return;
    const stack = [xi + yi * iw];
    const visited = new Uint8Array(iw * ih);
    while (stack.length) {
      const i = stack.pop()!;
      if (visited[i]) continue; visited[i] = 1;
      const b = i * 4;
      if (Math.abs(data[b]-tr) + Math.abs(data[b+1]-tg) + Math.abs(data[b+2]-tb) + Math.abs(data[b+3]-ta) > 40) continue;
      data[b] = fr; data[b+1] = fg; data[b+2] = fb; data[b+3] = 255;
      const x = i % iw, y = Math.floor(i / iw);
      if (x > 0) stack.push(i - 1);
      if (x < iw - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - iw);
      if (y < ih - 1) stack.push(i + iw);
    }
    ctx.putImageData(imgData, 0, 0);
    composite(selected!);
  }

  function drawShapeOnCanvas(
    type: 'rect' | 'ellipse' | 'line', x1: number, y1: number, x2: number, y2: number,
    c1: string, sz: number, mode: ShapeFill, targetCanvas: HTMLCanvasElement
  ) {
    const ctx = targetCanvas.getContext('2d')!;
    ctx.strokeStyle = c1; ctx.fillStyle = c1;
    ctx.lineWidth = sz; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (type === 'rect') {
      const [rx, ry, rw, rh] = [Math.min(x1,x2), Math.min(y1,y2), Math.abs(x2-x1), Math.abs(y2-y1)];
      if (mode === 'fill' || mode === 'both') ctx.fillRect(rx, ry, rw, rh);
      if (mode === 'stroke' || mode === 'both') ctx.strokeRect(rx, ry, rw, rh);
    } else if (type === 'ellipse') {
      const cx = (x1+x2)/2, cy = (y1+y2)/2, rx = Math.abs(x2-x1)/2, ry = Math.abs(y2-y1)/2;
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(rx,1), Math.max(ry,1), 0, 0, Math.PI*2);
      if (mode === 'fill' || mode === 'both') ctx.fill();
      if (mode === 'stroke' || mode === 'both') ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }

  function updateShapeOverlay(x1: number, y1: number, x2: number, y2: number) {
    const oc = overlayCanvas.current; if (!oc) return;
    const e = edits.current.get(selected || ''); if (!e) return;
    oc.width = e.w; oc.height = e.h;
    const octx = oc.getContext('2d')!; octx.clearRect(0, 0, e.w, e.h);
    const t = tool as 'rect' | 'ellipse' | 'line';
    if (t === 'rect' || t === 'ellipse' || t === 'line') {
      drawShapeOnCanvas(t, x1, y1, x2, y2, brushColor, brushSize, shapeFill, oc);
    } else if (tool === 'gradient') {
      const grd = octx.createLinearGradient(x1, y1, x2, y2);
      grd.addColorStop(0, brushColor); grd.addColorStop(1, brushColor2);
      octx.fillStyle = grd; octx.fillRect(0, 0, e.w, e.h);
    }
  }

  // ── Image/text/shape layer transforms (move / scale / rotate) ───────────────
  // REAL FIX for "importing graphics is awkward": a newly imported image
  // used to land at (0,0) at its native size with no way to reposition it
  // except editing numbers nowhere in the UI. This gives the active
  // transformable layer real on-canvas handles — drag the body to move,
  // drag a corner to scale (uniformly, from the layer's own center), drag
  // the handle above it to rotate.
  function getActiveTransformableLayer(): Layer | null {
    const e = edits.current.get(selected || ''); if (!e) return null;
    const l = e.layers.find((x) => x.id === activeLayerId); if (!l) return null;
    if (!TRANSFORMABLE_KINDS.has(l.kind) || l.locked) return null;
    return l;
  }
  function layerCenter(l: { x: number; y: number; w: number; h: number }) { return { cx: l.x + l.w / 2, cy: l.y + l.h / 2 }; }
  function rotatePoint(x: number, y: number, cx: number, cy: number, rot: number) {
    const dx = x - cx, dy = y - cy, cos = Math.cos(rot), sin = Math.sin(rot);
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }
  function layerHandles(l: Layer) {
    const rot = l.rotation || 0;
    const { cx, cy } = layerCenter(l);
    const rotateOffset = ROTATE_HANDLE_OFFSET / zoom;
    return {
      cx, cy,
      tl: rotatePoint(l.x, l.y, cx, cy, rot),
      tr: rotatePoint(l.x + l.w, l.y, cx, cy, rot),
      bl: rotatePoint(l.x, l.y + l.h, cx, cy, rot),
      br: rotatePoint(l.x + l.w, l.y + l.h, cx, cy, rot),
      topMid: rotatePoint(cx, l.y, cx, cy, rot),
      rotateHandle: rotatePoint(cx, l.y - rotateOffset, cx, cy, rot),
    };
  }
  function pointInLayer(p: { x: number; y: number }, l: Layer) {
    const { cx, cy } = layerCenter(l);
    const inv = rotatePoint(p.x, p.y, cx, cy, -(l.rotation || 0));
    return inv.x >= l.x && inv.x <= l.x + l.w && inv.y >= l.y && inv.y <= l.y + l.h;
  }
  function hitTestHandle(p: { x: number; y: number }, l: Layer): TransformHandle | null {
    const hs = HANDLE_SIZE / zoom;
    const h = layerHandles(l);
    if (Math.hypot(p.x - h.rotateHandle.x, p.y - h.rotateHandle.y) <= hs) return 'rotate';
    if (Math.hypot(p.x - h.tl.x, p.y - h.tl.y) <= hs) return 'tl';
    if (Math.hypot(p.x - h.tr.x, p.y - h.tr.y) <= hs) return 'tr';
    if (Math.hypot(p.x - h.bl.x, p.y - h.bl.y) <= hs) return 'bl';
    if (Math.hypot(p.x - h.br.x, p.y - h.br.y) <= hs) return 'br';
    if (pointInLayer(p, l)) return 'move';
    return null;
  }
  function drawTransformHandles(l: Layer) {
    const oc = overlayCanvas.current; const e = edits.current.get(selected || '');
    if (!oc || !e) return;
    oc.width = e.w; oc.height = e.h;
    const ctx = oc.getContext('2d')!; ctx.clearRect(0, 0, e.w, e.h);
    const h = layerHandles(l);
    const hs = HANDLE_SIZE / zoom;
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = Math.max(1, 1.5 / zoom); ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.beginPath();
    ctx.moveTo(h.tl.x, h.tl.y); ctx.lineTo(h.tr.x, h.tr.y); ctx.lineTo(h.br.x, h.br.y); ctx.lineTo(h.bl.x, h.bl.y); ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(h.topMid.x, h.topMid.y); ctx.lineTo(h.rotateHandle.x, h.rotateHandle.y); ctx.stroke();
    ctx.fillStyle = '#38bdf8'; ctx.strokeStyle = '#0a1622'; ctx.lineWidth = Math.max(1, 1.5 / zoom);
    for (const pt of [h.tl, h.tr, h.bl, h.br]) { ctx.beginPath(); ctx.rect(pt.x - hs / 2, pt.y - hs / 2, hs, hs); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(h.rotateHandle.x, h.rotateHandle.y, hs / 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // Keep handles visible/current whenever the select tool has a
  // transformable active layer — tool switches, layer switches, and zoom
  // changes all need a redraw; the live drag itself is handled imperatively
  // in onPointerMove below for immediate feedback.
  useEffect(() => {
    const l = getActiveTransformableLayer();
    if (tool === 'select' && l) drawTransformHandles(l);
    else { const oc = overlayCanvas.current; if (oc) { oc.width = 1; oc.height = 1; } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, activeLayerId, zoom, selected]);

  const onPointerDown = (ev: React.PointerEvent) => {
    const p = canvasPoint(ev);
    if (ev.button === 1 || ev.altKey) {
      panning.current = true; lastPt.current = { x: ev.clientX, y: ev.clientY };
    } else if (tool === 'select') {
      const activeLayer = getActiveTransformableLayer();
      const handle = activeLayer && p ? hitTestHandle(p, activeLayer) : null;
      if (activeLayer && handle && p && selected) {
        pushUndo(selected); // one undo step for the whole move/scale/rotate gesture
        transformGesture.current = {
          handle, startX: p.x, startY: p.y,
          layer: { x: activeLayer.x, y: activeLayer.y, w: activeLayer.w, h: activeLayer.h, rotation: activeLayer.rotation || 0 },
        };
      } else {
        panning.current = true; lastPt.current = { x: ev.clientX, y: ev.clientY };
      }
    } else if (tool === 'brush') {
      if (!painting.current) pushUndo(selected!);
      painting.current = true; lastPaintPt.current = null;
      if (p) paintAt(p);
    } else if (tool === 'fill') {
      if (p) floodFill(p.x, p.y);
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'gradient') {
      if (p) { shapeStart.current = p; updateShapeOverlay(p.x, p.y, p.x, p.y); }
    }
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };

  const onPointerMove = (ev: React.PointerEvent) => {
    if (transformGesture.current) {
      const p = canvasPoint(ev); if (!p || !selected) return;
      const g = transformGesture.current;
      const activeLayer = getActiveTransformableLayer();
      if (!activeLayer) { transformGesture.current = null; return; }
      if (g.handle === 'move') {
        activeLayer.x = g.layer.x + (p.x - g.startX);
        activeLayer.y = g.layer.y + (p.y - g.startY);
      } else if (g.handle === 'rotate') {
        const { cx, cy } = layerCenter(g.layer);
        const startAngle = Math.atan2(g.startY - cy, g.startX - cx);
        const curAngle = Math.atan2(p.y - cy, p.x - cx);
        activeLayer.rotation = g.layer.rotation + (curAngle - startAngle);
      } else {
        // Corner handle: uniform scale from the layer's own center — avoids
        // the ambiguity of "which corner stays anchored" once rotation is
        // involved, and matches how most lightweight editors behave.
        const { cx, cy } = layerCenter(g.layer);
        const startDist = Math.hypot(g.startX - cx, g.startY - cy) || 1;
        const curDist = Math.hypot(p.x - cx, p.y - cy);
        const scale = Math.max(0.05, curDist / startDist);
        const newW = g.layer.w * scale, newH = g.layer.h * scale;
        activeLayer.w = newW; activeLayer.h = newH;
        activeLayer.x = cx - newW / 2; activeLayer.y = cy - newH / 2;
      }
      scheduleRender(selected);
      drawTransformHandles(activeLayer);
      return;
    }
    if (panning.current) {
      setPan((pp) => ({ x: pp.x + ev.clientX - lastPt.current.x, y: pp.y + ev.clientY - lastPt.current.y }));
      lastPt.current = { x: ev.clientX, y: ev.clientY };
    } else if (painting.current) {
      const p = canvasPoint(ev); if (p) paintAt(p);
    } else if (shapeStart.current) {
      const p = canvasPoint(ev);
      if (p) updateShapeOverlay(shapeStart.current.x, shapeStart.current.y, p.x, p.y);
    }
  };

  const onPointerUp = (ev: React.PointerEvent) => {
    if (transformGesture.current) {
      transformGesture.current = null;
      if (selected) composite(selected);
      rerender();
    } else if (shapeStart.current) {
      const p = canvasPoint(ev);
      if (p && selected) {
        const e = edits.current.get(selected);
        if (e) {
          pushUndo(selected);
          const t = tool as 'rect' | 'ellipse' | 'line' | 'gradient';
          const c = newCanvas(e.w, e.h);
          const ctx = c.getContext('2d')!;
          if (t === 'gradient') {
            const grd = ctx.createLinearGradient(shapeStart.current.x, shapeStart.current.y, p.x, p.y);
            grd.addColorStop(0, brushColor); grd.addColorStop(1, brushColor2);
            ctx.fillStyle = grd; ctx.fillRect(0, 0, e.w, e.h);
            addLayer(e, selected, { kind: 'gradient', name: 'Gradient', canvas: c, w: e.w, h: e.h, opacity: 90 });
          } else {
            drawShapeOnCanvas(t, shapeStart.current.x, shapeStart.current.y, p.x, p.y, brushColor, brushSize, shapeFill, c);
            addLayer(e, selected, { kind: 'shape', name: t.charAt(0).toUpperCase() + t.slice(1), canvas: c, w: e.w, h: e.h });
          }
        }
      }
      shapeStart.current = null;
      // Clear overlay
      const oc = overlayCanvas.current;
      if (oc) { oc.width = 1; oc.height = 1; }
      rerender();
    }
    panning.current = false; painting.current = false;
    lastPaintPt.current = null;
  };

  const onWheel = (ev: React.WheelEvent) => setZoom((z) => Math.max(0.05, Math.min(5, z * (ev.deltaY > 0 ? 0.9 : 1.1))));

  async function doExport() {
    const e = edits.current.get(selected || ''); const exporter = EXPORTERS.find((x) => x.id === exporterId);
    if (!e || !exporter) { toast.error('Nothing to export'); return; }
    if (!exporter.ready) { toast.error(exporter.label + ' not available yet'); return; }
    try {
      const t = targetById(selected);
      const base = `${activeVehicle?.name || 'livery'}_${t?.name || 'texture'}`.replace(/[^\w.-]+/g, '_');
      const res = await exporter.export(e.canvas, base);
      downloadResult(res); toast.success(`Exported ${res.filename}`);
    } catch (err: any) { toast.error(err?.message || 'Export failed'); }
  }

  // ── Raw browser helpers ──────────────────────────────────────────────────────
  function findTarget(name: string, w: number, h: number) {
    return targets.find((t) => t.name === name && t.w === w && t.h === h) || null;
  }
  function openInEditor(name: string, w: number, h: number) {
    const t = findTarget(name, w, h);
    if (!t) { toast.error('This texture could not be decoded, so it can’t be opened'); return; }
    selectTarget(t.id); setView('editor');
  }
  async function exportImageData(name: string, id: ImageData) {
    const exporter = EXPORTERS.find((x) => x.id === exporterId) || EXPORTERS[0];
    if (!exporter.ready) { toast.error(exporter.label + ' not available yet'); return; }
    const c = newCanvas(id.width, id.height); c.getContext('2d')!.putImageData(id, 0, 0);
    const base = `${activeVehicle?.name || 'livery'}_${name}`.replace(/[^\w.-]+/g, '_');
    try { const res = await exporter.export(c, base); downloadResult(res); toast.success(`Exported ${res.filename}`); }
    catch (err: any) { toast.error(err?.message || 'Export failed'); }
  }
  function startReplace(name: string, w: number, h: number) {
    const t = findTarget(name, w, h);
    if (!t) { toast.error('Only decoded textures can be replaced'); return; }
    replaceTargetRef.current = t.id; replaceInput.current?.click();
  }
  async function applyReplace(file: File) {
    const id = replaceTargetRef.current; replaceTargetRef.current = null;
    const t = targetById(id); if (!t) return;
    const e = ensureEdit(t);
    try {
      const img = await loadImage(file);
      const c = newCanvas(t.w, t.h); const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, t.w, t.h);
      const baseLayer = e.layers.find((l) => l.kind === 'base');
      if (baseLayer) { baseLayer.canvas = c; }
      else e.layers.unshift({ id: uid(), name: 'Base texture', kind: 'base', visible: true, opacity: 100, blendMode: 'source-over', canvas: c, x: 0, y: 0, w: t.w, h: t.h });
      composite(t.id); rerender();
      toast.success(`Replaced ${t.name}`);
    } catch (err: any) { toast.error(err?.message || 'Replace failed'); }
  }

  // Live-update the texture onto the real model when geometry exists.
  useEffect(() => {
    if (!geometry || !viewerRef.current || !selected) return;
    const e = edits.current.get(selected);
    const slot = geometry.slots[0];
    if (e && slot) viewerRef.current.setSlotTexture(slot, e.canvas);
  }, [geometry, selected]);

  // Redraw the UV wireframe overlay whenever its visibility is toggled or
  // the geometry finishes loading after the target was already selected.
  useEffect(() => {
    drawUVOverlay(targetById(selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showUVOverlay, selected, geometry]);

  const curEdit = selected ? edits.current.get(selected) : null;
  const curTarget = targetById(selected);
  const activeLayer = curEdit?.layers.find((l) => l.id === activeLayerId) || null;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-2.5 border-b border-overlay-6 bg-surface-950/60 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          {!embedded && <button onClick={() => navigate(-1)} className="p-2 rounded-lg text-surface-500 hover:text-surface-100 hover:bg-overlay-6 transition-colors shrink-0"><ArrowLeft size={16} /></button>}
          <div className="w-8 h-8 rounded-lg bg-pink-500/15 border border-pink-500/25 flex items-center justify-center"><Palette size={16} className="text-pink-400" /></div>
          <div>
            <h1 className="text-sm font-bold text-surface-100">Livery Editor</h1>
            <p className="text-[10px] text-surface-500">{activeVehicle ? `${activeVehicle.name} · ${targets.length} textures` : 'Open a vehicle resource folder'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {phase !== 'empty' && (
            <button onClick={() => setPhase('list')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium btn-secondary"><ChevronLeft size={12} /> Vehicles</button>
          )}
          <button onClick={openFolder} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium btn-secondary"><FolderOpen size={12} /> Open Vehicle Folder</button>
          {phase === 'edit' && (
            <div className="flex items-center rounded-lg overflow-hidden border border-overlay-6">
              <button onClick={() => setView('browser')} className={`px-3 py-1.5 text-xs font-medium transition-all ${view === 'browser' ? 'bg-primary-600/25 text-primary-200' : 'text-surface-400 hover:bg-overlay-4'}`}>Browser</button>
              <button onClick={() => setView('editor')} className={`px-3 py-1.5 text-xs font-medium transition-all ${view === 'editor' ? 'bg-primary-600/25 text-primary-200' : 'text-surface-400 hover:bg-overlay-4'}`}>Editor</button>
            </div>
          )}
          {(phase === 'edit' || phase === 'list') && diagnostics && (
            <button onClick={() => setShowDiag(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-600/15 text-cyan-300 border border-cyan-500/25 rounded-lg hover:bg-cyan-600/25 transition-all"><Stethoscope size={12} /> Diagnostics</button>
          )}
          {phase === 'edit' && view === 'editor' && geometry && (
            // Always-visible, top-bar entry point for Generate UV Template —
            // the sidebar links (small text link + empty-state-only button)
            // are easy to miss or disappear once any texture exists; this one
            // stays put regardless of scroll position or how many textures
            // the vehicle already has, per the explicit "make it obvious and
            // easy to find" requirement.
            <button onClick={() => setShowUVGen(true)} title="Generate a fresh UV template for selected panels" className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-sky-600/15 text-sky-300 border border-sky-500/25 rounded-lg hover:bg-sky-600/25 transition-all">
              <Scan size={12} /> Generate UV Template
            </button>
          )}
          {phase === 'edit' && view === 'editor' && (
            <button onClick={() => setShowAssets((v) => !v)} title="Asset Library" className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-lg transition-all ${showAssets ? 'bg-emerald-600/25 text-emerald-200 border-emerald-500/30' : 'border-overlay-6 text-surface-400 hover:bg-overlay-4'}`}>
              <Grid3x3 size={12} /> Assets
            </button>
          )}
          {phase === 'edit' && (
            <div className="relative flex items-stretch rounded-lg overflow-hidden border border-emerald-500/40">
              {/* ONE clear primary action — the sensible default (save every
                  edited texture back into its real .ytd, with an automatic
                  .bak backup) rather than making the user pick between four
                  separate save/export buttons to figure out which one
                  actually produces a usable FiveM file. */}
              <button onClick={batchSaveToYTD} disabled={!diagnostics} className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-emerald-600/30 text-emerald-100 hover:bg-emerald-600/50 disabled:opacity-40 transition-all" title="Save every edited texture back into its .ytd file (backs up the original first)">
                <Save size={13} /> Save
              </button>
              <button onClick={() => setShowSaveMenu((v) => !v)} disabled={!curEdit} className="px-1.5 border-l border-emerald-500/30 bg-emerald-600/15 text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-40 transition-all" title="More save/export options">
                <ChevronDown size={13} />
              </button>
              {showSaveMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSaveMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-overlay-6 bg-surface-900 shadow-2xl p-1.5 space-y-0.5">
                    <button onClick={() => { setShowSaveMenu(false); saveToYTD(); }} disabled={!curEdit || !diagnostics} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium rounded-lg text-surface-200 hover:bg-overlay-6 disabled:opacity-40">
                      <Save size={12} className="text-emerald-400" /> Save this texture only
                    </button>
                    <button onClick={() => { setShowSaveMenu(false); saveActiveTexture(); }} disabled={!curEdit} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium rounded-lg text-surface-200 hover:bg-overlay-6 disabled:opacity-40">
                      <Download size={12} className="text-surface-400" /> Save as PNG…
                    </button>
                    <div className="h-px bg-overlay-6 my-1" />
                    <div className="px-2.5 pb-1 text-[9px] uppercase tracking-widest text-surface-600">Export as</div>
                    <div className="flex items-center gap-1 px-1.5 pb-1">
                      <select value={exporterId} onChange={(e) => setExporterId(e.target.value)} className="flex-1 px-2 py-1 text-xs bg-overlay-6 border border-overlay-6 rounded text-surface-200 focus:outline-none">
                        {EXPORTERS.map((x) => <option key={x.id} value={x.id} disabled={!x.ready}>{x.label}{x.ready ? '' : ' (soon)'}</option>)}
                      </select>
                      <button onClick={() => { setShowSaveMenu(false); doExport(); }} disabled={!curEdit} className="px-2.5 py-1 text-xs font-medium rounded bg-pink-600/25 text-pink-200 hover:bg-pink-600/40 disabled:opacity-40">Go</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <input ref={texInput} type="file" multiple accept=".dds,.ytd,.png,.jpg,.jpeg,.webp,.svg" className="hidden" onChange={(e) => { Array.from(e.target.files || []).forEach(importTexture); e.target.value = ''; }} />
        <input ref={replaceInput} type="file" accept=".dds,.png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) applyReplace(f); e.target.value = ''; }} />
      </div>

      {/* EMPTY */}
      {phase === 'empty' && initialRoot && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Loader2 size={24} className="text-pink-400 animate-spin" />
          <p className="text-sm text-surface-400">Scanning the imported vehicle for .yft/.ytd files…</p>
        </div>
      )}
      {phase === 'empty' && !initialRoot && (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <div className="border-2 border-dashed border-pink-500/20 rounded-2xl p-12 flex flex-col items-center text-center bg-pink-500/3 max-w-lg">
            <div className="w-16 h-16 rounded-2xl bg-pink-500/15 border border-pink-500/20 flex items-center justify-center mb-4"><Car size={28} className="text-pink-400" /></div>
            <h3 className="text-lg font-bold text-surface-100 mb-1.5">Open a Vehicle Resource</h3>
            <p className="text-sm text-surface-400 mb-5">Point at any FiveM vehicle folder. The editor finds the <b className="text-surface-200">.yft</b> and <b className="text-surface-200">.ytd</b> files automatically, reads the real textures, and lets you edit the livery. No converting, no extra tools.</p>
            <button onClick={openFolder} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-pink-600/25 text-pink-200 border border-pink-500/30 rounded-xl hover:bg-pink-600/40 transition-all"><FolderOpen size={16} /> Open Vehicle Folder</button>
          </div>
        </div>
      )}

      {/* VEHICLE LIST */}
      {phase === 'list' && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-[11px] uppercase tracking-widest text-surface-600 mb-3">{folderName} · {vehicles.length} vehicles detected</p>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {vehicles.map((v) => (
              <button key={v.name + v.dir} onClick={() => selectVehicle(v)} className="text-left p-4 rounded-xl bg-surface-900/40 border border-overlay-6 hover:border-pink-500/40 hover:bg-surface-900/70 transition-all group">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-9 h-9 rounded-lg bg-pink-500/10 border border-pink-500/20 flex items-center justify-center group-hover:bg-pink-500/20"><Car size={16} className="text-pink-400" /></div>
                  <div className="min-w-0"><p className="text-sm font-semibold text-surface-100 truncate">{v.name}</p><p className="text-[10px] text-surface-500">{v.ytds.length} texture file{v.ytds.length !== 1 ? 's' : ''}</p></div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {v.yft && <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300">.yft</span>}
                  {v.hiYft && <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">_hi.yft</span>}
                  {v.ytds.length > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">.ytd</span>}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* LOADING */}
      {phase === 'loading' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <Loader2 size={28} className="text-pink-400 animate-spin" />
          <p className="text-sm text-surface-300">{loadStage || 'Loading…'}</p>
          <p className="text-[11px] text-surface-600">{activeVehicle?.name}</p>
        </div>
      )}

      {/* RAW TEXTURE BROWSER */}
      {phase === 'edit' && view === 'browser' && (
        <div className="flex-1 overflow-y-auto p-5">
          {/* 3D model ready banner */}
          {geometry && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-2.5">
              <Car size={14} className="text-emerald-400 shrink-0" />
              <p className="text-[11px] text-emerald-300 flex-1">
                Vehicle model loaded — <b>{diagnostics?.summary.meshCount} meshes</b>, <b>{diagnostics?.summary.vertexCount?.toLocaleString()} vertices</b>, <b>{diagnostics?.summary.shaderCount} shaders</b>
              </p>
              <button onClick={() => setView('editor')} className="text-[10px] px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 font-medium whitespace-nowrap">View 3D →</button>
            </div>
          )}
          {/* geometry failure notice */}
          {!geometry && geomReason && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-500/8 border border-amber-500/20 flex items-center gap-2.5">
              <Wand2 size={13} className="text-amber-400 shrink-0" />
              <p className="text-[11px] text-amber-300/80 flex-1">{geomReason}</p>
              <button onClick={() => setShowDiag(true)} className="text-[10px] px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 whitespace-nowrap">Diagnostics</button>
            </div>
          )}
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] uppercase tracking-widest text-surface-600">
              Raw Texture Browser — {diagnostics?.summary.totalTexturesFound ?? 0} textures · {diagnostics?.summary.totalEditable ?? 0} decoded · {diagnostics?.summary.totalRejected ?? 0} failed
            </p>
            <p className="text-[10px] text-surface-600">Every texture in the YTD, no livery filtering</p>
          </div>
          {(!diagnostics || diagnostics.summary.totalTexturesFound === 0) && (
            <div className="text-sm text-surface-500 py-10 text-center">No textures were found. Open <button className="text-cyan-400 underline" onClick={() => setShowDiag(true)}>Diagnostics</button> for details.</div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {diagnostics?.ytds.flatMap((y) => y.textures.map((rec) => ({ rec, ytd: y.fileName }))).map(({ rec, ytd }, i) => (
              <div key={i} className={`rounded-xl border overflow-hidden flex flex-col ${rec.decoded ? 'border-overlay-6 bg-surface-900/40' : 'border-red-500/20 bg-red-500/5'}`}>
                <div className="aspect-square bg-[repeating-conic-gradient(#1a1c26_0deg_90deg,#232533_90deg_180deg)] bg-[length:16px_16px] flex items-center justify-center relative">
                  {rec.imageData
                    ? <ThumbImageData id={rec.imageData} large />
                    : <div className="flex flex-col items-center gap-1 text-red-400/70 p-2 text-center"><XCircle size={20} /><span className="text-[9px] leading-tight">{rec.format || 'undecoded'}</span></div>}
                  {rec.livery && rec.decoded && <span className="absolute top-1 left-1 text-[8px] px-1 rounded bg-pink-500/30 text-pink-200">livery?</span>}
                </div>
                <div className="p-2 flex flex-col gap-1 flex-1">
                  <p className="text-[11px] font-medium text-surface-200 truncate" title={rec.name}>{rec.name}</p>
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className={`text-[9px] px-1 rounded ${rec.decoded ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{rec.format || 'unknown'}</span>
                    <span className="text-[9px] text-surface-500 font-mono">{rec.width}×{rec.height}</span>
                    {rec.levels > 0 && <span className="text-[9px] text-surface-600">{rec.levels} mips</span>}
                  </div>
                  {!rec.decoded && <p className="text-[9px] text-red-300/80 leading-tight" title={rec.reason}>{rec.reason}</p>}
                  <p className="text-[8px] text-surface-600 truncate" title={ytd}>{ytd}</p>
                  {rec.decoded && (
                    <div className="flex gap-1 mt-auto pt-1">
                      <button onClick={() => openInEditor(rec.name, rec.width, rec.height)} className="flex-1 text-[10px] px-1.5 py-1 rounded bg-primary-600/20 text-primary-200 hover:bg-primary-600/30">Open</button>
                      <button onClick={() => exportImageData(rec.name, rec.imageData!)} title="Export" className="px-1.5 py-1 rounded bg-overlay-4 text-surface-300 hover:text-surface-100"><Download size={11} /></button>
                      <button onClick={() => startReplace(rec.name, rec.width, rec.height)} title="Replace" className="px-1.5 py-1 rounded bg-overlay-4 text-surface-300 hover:text-surface-100"><ImageIcon size={11} /></button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* EDIT */}
      {phase === 'edit' && view === 'editor' && (
        <div className="flex-1 flex overflow-hidden" onDrop={(ev) => { ev.preventDefault(); Array.from(ev.dataTransfer.files).forEach(importTexture); }} onDragOver={(ev) => ev.preventDefault()}>
          {/* LEFT — textures + layers */}
          <div className="w-60 shrink-0 flex flex-col border-r border-overlay-6 bg-surface-950/20 overflow-hidden">
            <div className="shrink-0 px-3 pt-3 pb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-surface-600">Textures</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setShowUVGen(true)} disabled={!geometry} title={geometry ? 'Generate a new, paintable UV layout for selected body panels' : 'Load a vehicle model first'} className="text-[9px] px-1.5 py-0.5 rounded transition-all text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 disabled:opacity-30 disabled:hover:bg-transparent font-semibold">+ UV Template</button>
                <button onClick={() => setShowAllTex((v) => !v)} title="Show every texture in the YTD (debug)" className={`text-[9px] px-1.5 py-0.5 rounded transition-all ${showAllTex ? 'bg-cyan-600/20 text-cyan-300' : 'text-surface-600 hover:text-surface-300 hover:bg-overlay-4'}`}>Show all</button>
              </div>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: '42%' }}>
              {targets.length === 0 && !showAllTex && (
                <div className="px-3 pb-3 space-y-2">
                  <p className="text-[11px] text-surface-600">No editable textures decoded — this vehicle has no usable livery layout. Toggle <b className="text-surface-400">Show all</b> or open <b className="text-cyan-400">Diagnostics</b> to see why, or:</p>
                  <button onClick={() => setShowUVGen(true)} disabled={!geometry} className="w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-sky-600/20 text-sky-300 border border-sky-500/30 hover:bg-sky-600/30 disabled:opacity-30 transition-all">
                    <Scan size={12} /> Generate UV Template
                  </button>
                </div>
              )}
              {!showAllTex && targets.map((t) => (
                <button key={t.id} onClick={() => selectTarget(t.id)} className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-all ${selected === t.id ? 'bg-primary-600/15 text-primary-300' : 'text-surface-400 hover:bg-overlay-4 hover:text-surface-200'}`}>
                  <div className="w-8 h-8 rounded bg-surface-800 border border-overlay-6 shrink-0 overflow-hidden">{t.base ? <ThumbImageData id={t.base} /> : <div className="w-full h-full bg-surface-700" />}</div>
                  <div className="min-w-0 flex-1"><p className="text-[11px] font-medium truncate">{t.name}</p><div className="flex items-center gap-1 mt-0.5"><span className="text-[9px] px-1 rounded bg-surface-700/40 text-surface-400">{t.format}</span><span className="text-[9px] text-surface-600">{t.w}×{t.h}</span></div></div>
                </button>
              ))}
              {showAllTex && diagnostics && diagnostics.ytds.flatMap((y) => y.textures).map((rec, i) => {
                const target = targets.find((t) => t.name === rec.name && t.w === rec.width && t.h === rec.height);
                return (
                  <button key={i} disabled={!rec.decoded} onClick={() => target && selectTarget(target.id)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-all ${target && selected === target.id ? 'bg-primary-600/15 text-primary-300' : rec.decoded ? 'text-surface-400 hover:bg-overlay-4 hover:text-surface-200' : 'text-surface-600 opacity-70 cursor-default'}`}>
                    <div className="w-8 h-8 rounded bg-surface-800 border border-overlay-6 shrink-0 overflow-hidden flex items-center justify-center">
                      {rec.imageData ? <ThumbImageData id={rec.imageData} /> : rec.decoded ? <ImageIcon size={12} className="text-surface-600" /> : <XCircle size={12} className="text-red-500/60" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-medium truncate">{rec.name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={`text-[9px] px-1 rounded ${rec.decoded ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{rec.format || 'unknown'}</span>
                        <span className="text-[9px] text-surface-600">{rec.width}×{rec.height}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 flex flex-col overflow-hidden border-t border-overlay-6">
              <div className="shrink-0 px-3 pt-2.5 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-surface-600 flex items-center gap-1"><LayersIcon size={11} /> Layers</span>
                <div className="flex items-center gap-0.5">
                  <button title="Add text" onClick={addTextLayer} disabled={!curTarget} className="p-1 rounded text-surface-500 hover:text-primary-400 disabled:opacity-30"><Type size={12} /></button>
                  <button title="Add fill" onClick={addFillLayer} disabled={!curTarget} className="p-1 rounded text-surface-500 hover:text-primary-400 disabled:opacity-30"><Square size={12} /></button>
                  <button title="Add image" onClick={() => texInput.current?.click()} disabled={!curTarget} className="p-1 rounded text-surface-500 hover:text-primary-400 disabled:opacity-30"><Plus size={13} /></button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
                {!curTarget && <p className="text-[11px] text-surface-600 px-1 py-2">Select a texture</p>}
                {curEdit && [...curEdit.layers].reverse().map((layer) => (
                  <div key={layer.id} onClick={() => setActiveLayerId(layer.id)} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer group transition-all ${activeLayerId === layer.id ? 'bg-primary-600/15 border border-primary-500/20' : 'hover:bg-overlay-4 border border-transparent'}`}>
                    <button onClick={(ev) => { ev.stopPropagation(); updateLayer(layer.id, { visible: !layer.visible }); }} className="text-surface-500 hover:text-surface-200 shrink-0">{layer.visible ? <Eye size={12} /> : <EyeOff size={12} className="opacity-40" />}</button>
                    <button onClick={(ev) => { ev.stopPropagation(); updateLayer(layer.id, { locked: !layer.locked }); }} className={`text-surface-500 hover:text-surface-200 shrink-0 ${layer.locked ? 'text-amber-400' : ''}`}>{layer.locked ? <Lock size={11} /> : <Unlock size={11} className="opacity-0 group-hover:opacity-60" />}</button>
                    <div className="w-7 h-7 rounded bg-surface-800 border border-overlay-6 shrink-0 overflow-hidden"><ThumbCanvas source={layer.canvas} /></div>
                    <span className={`text-[11px] truncate flex-1 ${layer.locked ? 'text-surface-500 italic' : 'text-surface-300'}`}>{layer.name}</span>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                      <button onClick={(ev) => { ev.stopPropagation(); moveLayer(layer.id, 1); }} className="p-0.5 text-surface-500 hover:text-surface-200"><ChevronUp size={10} /></button>
                      <button onClick={(ev) => { ev.stopPropagation(); moveLayer(layer.id, -1); }} className="p-0.5 text-surface-500 hover:text-surface-200"><ChevronDown size={10} /></button>
                      {layer.kind !== 'base' && <button onClick={(ev) => { ev.stopPropagation(); deleteLayer(layer.id); }} className="p-0.5 text-surface-500 hover:text-red-400"><Trash2 size={10} /></button>}
                    </div>
                  </div>
                ))}
              </div>
              {activeLayer && (
                <div className="shrink-0 border-t border-overlay-6 p-4 space-y-3">
                  <div className="flex items-center justify-between"><span className="text-sm font-medium text-surface-300">Opacity</span><span className="text-sm text-surface-200 font-mono">{activeLayer.opacity}%</span></div>
                  <input type="range" min={0} max={100} value={activeLayer.opacity} onChange={(e) => updateLayer(activeLayer.id, { opacity: Number(e.target.value) })} className="w-full h-2.5 accent-pink-500" />
                  <select value={activeLayer.blendMode} onChange={(e) => updateLayer(activeLayer.id, { blendMode: e.target.value as GlobalCompositeOperation })} className="w-full px-3 py-2 text-sm bg-overlay-4 border border-overlay-6 rounded-lg text-surface-200 focus:outline-none">{BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                  {activeLayer.kind === 'text' && (
                    <div className="space-y-1.5 pt-1">
                      <input value={activeLayer.text || ''} onChange={(e) => updateLayer(activeLayer.id, { text: e.target.value })} placeholder="Text" className="w-full px-2 py-1 text-[11px] bg-overlay-4 border border-overlay-6 rounded text-surface-200 focus:outline-none" />
                      <div className="flex gap-1.5">
                        <input type="number" value={activeLayer.fontSize || 80} onChange={(e) => updateLayer(activeLayer.id, { fontSize: Number(e.target.value) })} className="w-16 px-2 py-1 text-[11px] bg-overlay-4 border border-overlay-6 rounded text-surface-200 focus:outline-none" />
                        <input type="color" value={activeLayer.color || '#ffffff'} onChange={(e) => updateLayer(activeLayer.id, { color: e.target.value })} className="flex-1 h-7 bg-overlay-4 border border-overlay-6 rounded cursor-pointer" />
                      </div>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={!!activeLayer.textOutline} onChange={(e) => updateLayer(activeLayer.id, { textOutline: e.target.checked })} className="w-3 h-3 accent-pink-500" />
                        <span className="text-[10px] text-surface-400 flex-1">Outline</span>
                        {activeLayer.textOutline && (
                          <><input type="color" value={activeLayer.textOutlineColor || '#000000'} onChange={(e) => updateLayer(activeLayer.id, { textOutlineColor: e.target.value })} className="w-6 h-5 rounded border border-overlay-6 cursor-pointer" />
                          <input type="number" min={1} max={20} value={activeLayer.textOutlineWidth ?? 4} onChange={(e) => updateLayer(activeLayer.id, { textOutlineWidth: Number(e.target.value) })} className="w-10 px-1 py-0 text-[10px] bg-overlay-4 border border-overlay-6 rounded text-surface-200 focus:outline-none" /></>
                        )}
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={!!activeLayer.textShadow} onChange={(e) => updateLayer(activeLayer.id, { textShadow: e.target.checked })} className="w-3 h-3 accent-pink-500" />
                        <span className="text-[10px] text-surface-400 flex-1">Shadow</span>
                        {activeLayer.textShadow && <input type="color" value={activeLayer.textShadowColor || 'rgba(0,0,0,0.7)'} onChange={(e) => updateLayer(activeLayer.id, { textShadowColor: e.target.value })} className="w-6 h-5 rounded border border-overlay-6 cursor-pointer" />}
                      </label>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* CENTER — texture editor */}
          <div className="flex-1 flex flex-col overflow-hidden bg-surface-950/30">
            {/* Toolbar row 1 — tools. Enlarged across the board (bigger hit
                targets, bigger swatches, bigger sliders) — the old 13px
                icons / 24px swatches were too cramped to use comfortably. */}
            <div className="shrink-0 flex items-center gap-1.5 px-4 py-3 border-b border-overlay-6 flex-wrap">
              {/* History */}
              <button onClick={() => selected && applyUndo(selected)} title="Undo (Ctrl+Z)" className="p-2.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-4"><Undo2 size={18} /></button>
              <button onClick={() => selected && applyRedo(selected)} title="Redo (Ctrl+Y)" className="p-2.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-4"><Redo2 size={18} /></button>
              <div className="w-px h-6 bg-overlay-6 mx-1" />
              {/* Drawing tools */}
              {([['select','V',<MousePointer size={18} />,'Move / pan'],['brush','B',<Brush size={18} />,'Brush'],['fill','F',<PaintBucket size={18} />,'Bucket fill'],['rect','R',<Square size={18} />,'Rectangle'],['ellipse','E',<Circle size={18} />,'Ellipse'],['line','L',<Slash size={18} />,'Line'],['gradient','G',<Droplets size={18} />,'Gradient fill']] as [DrawTool,string,React.ReactNode,string][]).map(([t,key,icon,label]) => (
                <button key={t} onClick={() => setTool(t)} title={`${label} (${key})`} className={`p-2.5 rounded-lg transition-all ${tool === t ? 'bg-primary-600/20 text-primary-300 ring-1 ring-primary-500/30' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}>{icon}</button>
              ))}
              <div className="w-px h-6 bg-overlay-6 mx-1" />
              {/* Color pickers */}
              <div className="flex items-center gap-2">
                <label title="Primary color" className="relative cursor-pointer">
                  <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="sr-only" />
                  <div className="w-9 h-9 rounded-lg border-2 border-overlay-8 shadow-md hover:scale-105 transition-transform" style={{ background: brushColor }} />
                </label>
                {(tool === 'gradient') && (
                  <label title="Secondary color (gradient end)" className="relative cursor-pointer">
                    <input type="color" value={brushColor2} onChange={(e) => setBrushColor2(e.target.value)} className="sr-only" />
                    <div className="w-9 h-9 rounded-lg border-2 border-overlay-8 shadow-md hover:scale-105 transition-transform" style={{ background: brushColor2 }} />
                  </label>
                )}
              </div>
              {/* Brush size / shape options */}
              {tool === 'brush' && (
                <div className="flex items-center gap-2 pl-1">
                  <span className="text-xs text-surface-500">Size</span>
                  <input type="range" min={2} max={120} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-32 h-2 accent-pink-500" />
                  <span className="text-xs text-surface-300 font-mono w-10">{brushSize}px</span>
                </div>
              )}
              {(tool === 'rect' || tool === 'ellipse') && (
                <select value={shapeFill} onChange={(e) => setShapeFill(e.target.value as ShapeFill)} className="text-xs px-2.5 py-1.5 rounded-lg bg-overlay-4 border border-overlay-6 text-surface-200 focus:outline-none">
                  <option value="fill">Fill</option>
                  <option value="stroke">Stroke</option>
                  <option value="both">Both</option>
                </select>
              )}
              {(tool === 'rect' || tool === 'ellipse' || tool === 'line') && (
                <div className="flex items-center gap-2 pl-1">
                  <span className="text-xs text-surface-500">Width</span>
                  <input type="range" min={1} max={40} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} className="w-24 h-2 accent-pink-500" />
                  <span className="text-xs text-surface-300 font-mono w-8">{brushSize}</span>
                </div>
              )}
              <div className="w-px h-6 bg-overlay-6 mx-1" />
              <button onClick={() => setZoom((z) => Math.min(5, z * 1.25))} className="p-2.5 text-surface-500 hover:text-surface-200 hover:bg-overlay-4 rounded-lg"><ZoomIn size={18} /></button>
              <button onClick={() => setZoom((z) => Math.max(0.05, z * 0.8))} className="p-2.5 text-surface-500 hover:text-surface-200 hover:bg-overlay-4 rounded-lg"><ZoomOut size={18} /></button>
              <span className="text-sm text-surface-400 font-mono w-12 text-center">{Math.round(zoom * 100)}%</span>
              <button onClick={() => { setZoom(0.4); setPan({ x: 0, y: 0 }); }} className="text-sm text-surface-400 hover:text-surface-200 px-3 py-1.5 hover:bg-overlay-4 rounded-lg font-medium">Fit</button>
              <div className="w-px h-6 bg-overlay-6 mx-1" />
              <button
                onClick={() => setShowUVOverlay((v) => !v)}
                disabled={!geometry}
                title={geometry ? 'Toggle the UV template — which panel owns which pixels of this texture' : 'Load a vehicle model to see its UV template'}
                className={`flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-lg transition-all disabled:opacity-30 ${showUVOverlay ? 'bg-sky-600/20 text-sky-300' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}
              >
                <Grid3x3 size={16} /> UV Template
              </button>
              <div className="w-px h-6 bg-overlay-6 mx-1" />
              {/* Always-on status, not a toggle — every paint stroke, fill,
                  opacity change, and layer transform pushes straight to the
                  3D preview with zero extra clicks. See composite()'s own
                  header for the automatic no-material-match fallback that
                  makes this actually always true, not just a label. */}
              <span
                title={autoSyncedAll ? 'This texture has no direct material match on this vehicle — Auto Sync applied it to every material so it still shows up live.' : 'Every change updates the 3D preview instantly — no manual sync needed.'}
                className={`flex items-center gap-2 px-3.5 py-2 text-sm font-semibold rounded-lg ${autoSyncedAll ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}`}
              >
                <Zap size={16} /> Auto Sync {autoSyncedAll ? '· synced to all materials' : 'ON'}
              </span>
              <span className="ml-auto text-xs text-surface-600 truncate max-w-48">{curTarget ? `${curTarget.name} · ${curEdit?.w}×${curEdit?.h}` : 'No texture selected'}</span>
            </div>
            <div
              className="flex-1 overflow-hidden relative"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}
              style={{ cursor: tool === 'select' ? 'grab' : 'crosshair' }}
            >
              {!curEdit && <div className="absolute inset-0 flex items-center justify-center text-sm text-surface-600">Select a texture to edit</div>}
              {curEdit && (
                <div className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
                  <div style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`, transformOrigin: 'center center', pointerEvents: 'all' }}>
                    <div className="relative" style={{ boxShadow: '0 0 0 1px rgba(255,255,255,0.08), 0 20px 60px rgba(0,0,0,0.7)' }}>
                      <canvas ref={centerCanvas} style={{ display: 'block', imageRendering: zoom < 0.5 ? 'auto' : 'pixelated' }} />
                      {/* UV template wireframe — which panel owns which pixels of this texture */}
                      <canvas ref={uvCanvas} style={{ display: 'block', position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
                      {/* Overlay canvas for shape/gradient preview AND layer transform handles */}
                      <canvas ref={overlayCanvas} style={{ display: 'block', position: 'absolute', top: 0, left: 0, pointerEvents: 'none', imageRendering: zoom < 0.5 ? 'auto' : 'pixelated', opacity: 0.85 }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT — 3D viewport */}
          <div className="w-80 shrink-0 flex flex-col border-l border-overlay-6 bg-surface-950/20">
            {/* Toolbar */}
            <div className="shrink-0 px-3 py-2 border-b border-overlay-6 flex items-center gap-1">
              <Car size={13} className="text-pink-400 mr-1" />
              <span className="text-xs font-semibold text-surface-200 flex-1">3D Preview</span>
              {geometry && (<>
                <button title="Toggle wireframe" onClick={() => { setWireframe((w) => { const nw = !w; viewerRef.current?.setWireframe(nw); return nw; }); }}
                  className={`p-1.5 rounded text-[10px] ${wireframe ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}>
                  <BoxSelect size={13} />
                </button>
                <button title="Reset camera" onClick={() => viewerRef.current?.resetView()}
                  className="p-1.5 rounded text-surface-500 hover:text-surface-200 hover:bg-overlay-4">
                  <RotateCcw size={13} />
                </button>
                <button title="UV debug (red=U, green=V — smooth gradient = correct UVs)"
                  onClick={() => { setUvDebug((u) => { const nu = !u; viewerRef.current?.setUVDebug(nu); return nu; }); }}
                  className={`p-1.5 rounded text-[9px] font-bold ${uvDebug ? 'bg-primary-600/20 text-primary-300' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}>
                  UV
                </button>
                <button title="Flip texture V (only if a livery looks vertically mirrored)"
                  onClick={() => { setFlipV((f) => { const nf = !f; viewerRef.current?.setFlipV(nf); return nf; }); }}
                  className={`p-1.5 rounded text-[9px] font-bold ${flipV ? 'bg-amber-500/20 text-amber-300' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}>
                  ⇅V
                </button>
                <button title="Section debug — colour each material section uniquely (compare to OpenIV)"
                  onClick={() => { setSectionDebug((s) => { const ns = !s; viewerRef.current?.setSectionDebug(ns); return ns; }); }}
                  className={`p-1.5 rounded ${sectionDebug ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'text-surface-500 hover:text-surface-200 hover:bg-overlay-4'}`}>
                  <Grid3x3 size={13} />
                </button>
              </>)}
            </div>

            {/* Viewer mount — always present so the canvas has somewhere to live */}
            <div ref={viewerMount} className={`flex-1 relative overflow-hidden cursor-grab active:cursor-grabbing ${!geometry ? 'hidden' : ''}`} />

            {/* Shown only when no geometry yet */}
            {!geometry && (
              <div className="flex-1 flex flex-col">
                <div className="flex-1 flex items-center justify-center p-5">
                  {curEdit ? (
                    <div className="w-full">
                      <p className="text-[10px] uppercase tracking-widest text-surface-600 mb-2 text-center">Live texture preview</p>
                      <LivePreview edit={curEdit} />
                    </div>
                  ) : <Box size={40} className="text-surface-700" />}
                </div>
                <div className="shrink-0 border-t border-overlay-6 px-4 py-3 bg-amber-500/5">
                  <div className="flex items-start gap-2">
                    <Wand2 size={14} className="text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-semibold text-surface-200">Vehicle model parsing</p>
                      <p className="text-[10px] text-surface-500 leading-relaxed mt-0.5">
                        {geomReason || 'Building mesh from .yft…'} Open <button onClick={() => setShowDiag(true)} className="text-cyan-400 underline">Diagnostics</button> for details.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Material / texture diagnostics */}
            {geometry && (() => {
              const inYtd = (n?: string) => !!n && targets.some((t) => t.name.toLowerCase() === n.toLowerCase());
              const picked = pickedSlotId ? geometry.slots.find((s) => s.id === pickedSlotId) : null;
              const sel = selected ? targets.find((t) => t.id === selected) : null;
              // Materials/meshes that reference the selected texture.
              const usingSel = sel
                ? geometry.slots.filter((s) =>
                    s.textureHint?.toLowerCase() === sel.name.toLowerCase() ||
                    s.textures.some((tx) => tx.toLowerCase() === sel.name.toLowerCase()))
                : [];
              const meshCount = usingSel.reduce((n, s) => n + s.meshes.length, 0);
              const diffuse = picked ? (picked.textureHint || picked.textures[0]) : undefined;
              const normal = picked?.textures.find((t) => /normal|_n$|_nrm|blank_normal/i.test(t));
              const spec = picked?.textures.find((t) => /spec|_s$/i.test(t));
              const curEditCanvas = selected ? edits.current.get(selected)?.canvas : null;
              const diffuseTarget = diffuse ? targets.find((t) => t.name.toLowerCase() === diffuse.toLowerCase()) : undefined;
              const texSize = diffuseTarget ? `${diffuseTarget.w}×${diffuseTarget.h}` : (inYtd(diffuse) ? '?' : '—');
              const texSource = picked && edits.current.get(diffuseTarget?.id || '') ? 'edited canvas' : (inYtd(diffuse) ? 'original YTD' : 'none');
              return (
                <div className="shrink-0 border-t border-overlay-6 px-3 py-2 space-y-2 max-h-72 overflow-y-auto text-[10px]">
                  {/* Manual override — normal painting no longer needs this.
                      Auto Sync (see the toolbar badge above the canvas)
                      already applies a texture to every material automatically
                      whenever it has no direct material match, so this is only
                      for manually forcing ALL materials regardless of mapping
                      (debugging a specific vehicle's material setup). */}
                  <button
                    disabled={!curEditCanvas}
                    onClick={() => {
                      const nv = !forceTexOn;
                      setForceTexOn(nv);
                      viewerRef.current?.forceTextureOnAll(nv && curEditCanvas ? curEditCanvas : null);
                    }}
                    className={`w-full px-2 py-1.5 rounded font-semibold ${forceTexOn ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400/40' : curEditCanvas ? 'bg-overlay-6 text-surface-200 hover:bg-overlay-8' : 'bg-overlay-4 text-surface-600 cursor-not-allowed'}`}
                    title="Debug override: force EVERY material to show the selected texture, ignoring material mapping entirely"
                  >
                    {forceTexOn ? '● Debug override active — click to restore normal mapping' : 'Debug: force selected texture on ALL materials'}
                  </button>

                  {/* Selected-texture usage */}
                  {sel && (
                    <div className="rounded bg-surface-900/50 px-2 py-1.5">
                      <p className="text-surface-300 font-semibold truncate">Texture: {sel.name}</p>
                      <p className={meshCount > 0 ? 'text-emerald-400' : 'text-red-400'}>
                        used by {usingSel.length} material(s) · {meshCount} mesh(es)
                        {meshCount === 0 && ' — no mesh uses this texture (mapping miss)'}
                      </p>
                      <button
                        onClick={() => viewerRef.current?.highlightSlot(usingSel.length ? usingSel.map((s) => s.id) : null)}
                        className="mt-1 text-cyan-400 underline">Highlight {meshCount} mesh(es)</button>
                    </div>
                  )}

                  {/* Picked-mesh material inspector */}
                  {picked ? (
                    <div className="rounded bg-surface-900/50 px-2 py-1.5 space-y-0.5">
                      <p className="text-surface-500 uppercase tracking-wider text-[9px]">Selected mesh material</p>
                      <Row k="Mesh" v={pickedMesh || '—'} />
                      <Row k="Shader" v={picked.name} />
                      <Row k="Shader#" v={picked.shaderHash} />
                      <Row k="Mat index" v={picked.materialIndex !== undefined ? String(picked.materialIndex) : '—'} />
                      <Row k="UV channel" v={picked.uvChannel !== undefined ? `texcoord${picked.uvChannel}` : '—'} />
                      <Row k="Section" v={picked.section} />
                      <Row k="Meshes" v={String(picked.meshes.length)} />
                      <Row k="Diffuse" v={diffuse} ok={inYtd(diffuse)} />
                      <Row k="Tex size" v={texSize} />
                      <Row k="Source" v={texSource} />
                      <Row k="Normal" v={normal} ok={inYtd(normal)} />
                      <Row k="Specular" v={spec} ok={inYtd(spec)} />
                      {picked.textures.length > 0 && (
                        <p className="text-[9px] text-surface-500 pt-0.5 break-all">all: {picked.textures.join(', ')}</p>
                      )}
                      <p className="text-[9px] text-surface-600 pt-0.5">✓ = name resolves to a decoded YTD texture</p>
                    </div>
                  ) : (
                    <p className="text-surface-600">Click a mesh part to inspect its material → texture mapping.</p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ASSET LIBRARY PANEL */}
      {showAssets && phase === 'edit' && (
        <div className="fixed inset-0 z-40 flex" onClick={() => setShowAssets(false)}>
          <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
            <motion.div initial={{ x: 320 }} animate={{ x: 0 }} exit={{ x: 320 }} transition={{ type: 'spring', damping: 28 }}
              className="w-72 h-full bg-surface-900 border-l border-overlay-6 flex flex-col shadow-2xl">
              <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-overlay-6">
                <Grid3x3 size={14} className="text-emerald-400" />
                <span className="text-sm font-semibold text-surface-100 flex-1">Asset Library</span>
                <button onClick={() => setShowAssets(false)} className="p-1 text-surface-500 hover:text-surface-200"><X size={14} /></button>
              </div>
              {/* Category tabs */}
              <div className="shrink-0 flex gap-0.5 px-3 py-2 border-b border-overlay-6 flex-wrap">
                {(['police','fire','ems','racing','patterns','badges','numbers'] as const).map((cat) => (
                  <button key={cat} onClick={() => setAssetCat(cat)}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize transition-all ${assetCat === cat ? 'bg-primary-600/30 text-primary-200' : 'text-surface-500 hover:text-surface-300 hover:bg-overlay-4'}`}>
                    {cat}
                  </button>
                ))}
              </div>
              {!curTarget && <div className="flex-1 flex items-center justify-center p-5 text-[11px] text-surface-600 text-center">Select a texture first, then click an asset to apply it.</div>}

              {/* Number Generator (special panel for 'numbers' category) */}
              {assetCat === 'numbers' && (
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  <p className="text-[10px] text-surface-500">Generate a number or text sticker as a new layer.</p>
                  <div>
                    <label className="text-[10px] text-surface-500 block mb-1">Text / Number</label>
                    <input value={numText} onChange={(e) => setNumText(e.target.value)} maxLength={6}
                      className="w-full px-2 py-1 text-sm bg-overlay-4 border border-overlay-6 rounded text-surface-100 focus:outline-none font-mono text-center" />
                  </div>
                  <div>
                    <label className="text-[10px] text-surface-500 block mb-1">Style</label>
                    <select value={numStyle} onChange={(e) => setNumStyle(e.target.value as NumberStyle)}
                      className="w-full px-2 py-1 text-xs bg-overlay-4 border border-overlay-6 rounded text-surface-200 focus:outline-none">
                      <option value="block">Block (bold, outlined)</option>
                      <option value="outline">Outline only</option>
                      <option value="racing">Racing (italic)</option>
                      <option value="badge">Badge (rounded bg)</option>
                      <option value="jersey">Jersey (rect bg)</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><label className="text-[9px] text-surface-600 block mb-0.5">Fill</label><input type="color" value={numFill} onChange={(e) => setNumFill(e.target.value)} className="w-full h-7 rounded border border-overlay-6 cursor-pointer" /></div>
                    <div><label className="text-[9px] text-surface-600 block mb-0.5">Outline</label><input type="color" value={numOutline} onChange={(e) => setNumOutline(e.target.value)} className="w-full h-7 rounded border border-overlay-6 cursor-pointer" /></div>
                    {(numStyle === 'badge' || numStyle === 'jersey') && <div><label className="text-[9px] text-surface-600 block mb-0.5">Background</label><input type="color" value={numBg} onChange={(e) => setNumBg(e.target.value)} className="w-full h-7 rounded border border-overlay-6 cursor-pointer" /></div>}
                  </div>
                  <div>
                    <label className="text-[10px] text-surface-500 block mb-1">Size <span className="font-mono">{Math.round(numScale * 100)}%</span></label>
                    <input type="range" min={20} max={200} value={Math.round(numScale * 100)} onChange={(e) => setNumScale(Number(e.target.value) / 100)} className="w-full accent-pink-500" />
                  </div>
                  {/* Live preview */}
                  {curTarget && (() => {
                    const c = renderNumberSticker(128, 128, { text: numText || '99', style: numStyle, fillColor: numFill, outlineColor: numOutline, bgColor: numBg, posX: 0.5, posY: 0.5, scale: numScale });
                    return <div className="rounded-lg overflow-hidden border border-overlay-6 bg-[repeating-conic-gradient(#1a1c26_0_90deg,#232533_90deg_180deg)] bg-[length:12px_12px]"><img src={c.toDataURL()} className="w-full" style={{ imageRendering: 'pixelated' }} /></div>;
                  })()}
                  <button onClick={applyNumberSticker} disabled={!curTarget}
                    className="w-full py-2 rounded-lg text-xs font-semibold bg-emerald-600/25 text-emerald-200 border border-emerald-500/30 hover:bg-emerald-600/40 disabled:opacity-40 transition-all">
                    Apply to Texture
                  </button>
                </div>
              )}

              {assetCat !== 'numbers' && (
                <div className="flex-1 overflow-y-auto p-3 grid grid-cols-3 gap-2 content-start">
                  {LIVERY_ASSETS.filter((a) => a.category === assetCat).map((asset) => {
                    const thumb = assetThumbnail(asset);
                    return (
                      <button key={asset.id} onClick={() => { applyLiveryAsset(asset.id); }}
                        disabled={!curTarget} title={asset.name}
                        className="flex flex-col items-center gap-1 p-1.5 rounded-lg border border-overlay-6 bg-surface-800/40 hover:bg-overlay-6 hover:border-emerald-500/30 disabled:opacity-30 transition-all group">
                        <div className="w-full aspect-square rounded overflow-hidden bg-surface-700 border border-overlay-6">
                          <img src={thumb} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />
                        </div>
                        <span className="text-[9px] text-surface-500 group-hover:text-surface-200 leading-tight text-center truncate w-full">{asset.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="shrink-0 border-t border-overlay-6 px-4 py-2.5">
                <p className="text-[10px] text-surface-600">Click any asset to add it as a layer on the selected texture. Adjust opacity in the Layers panel.</p>
              </div>
            </motion.div>
          </div>
        </div>
      )}

      {/* DIAGNOSTICS MODAL */}
      {showDiag && diagnostics && <DiagnosticsPanel diag={diagnostics} onClose={() => setShowDiag(false)} />}

      {/* GENERATE UV TEMPLATE MODAL */}
      {showUVGen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={() => !uvGenBusy && setShowUVGen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[80vh] flex flex-col bg-surface-900 border border-overlay-6 rounded-2xl shadow-2xl overflow-hidden">
            <div className="shrink-0 flex items-center gap-2 px-5 py-3.5 border-b border-overlay-6 bg-surface-950/50">
              <Scan size={16} className="text-sky-400" />
              <div className="flex-1">
                <h2 className="text-sm font-bold text-surface-100">Generate UV Template</h2>
                <p className="text-[10px] text-surface-500">Select the body panels to include — a clean UV layout is generated and a new paintable texture is created for them.</p>
              </div>
              <button onClick={() => setShowUVGen(false)} disabled={uvGenBusy} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-4 disabled:opacity-30"><X size={16} /></button>
            </div>
            <div className="shrink-0 flex items-center gap-2 px-5 py-2.5 border-b border-overlay-6">
              <button onClick={() => setUvGenSelected(new Set(uvGenPanels.map((p) => p.name)))} disabled={uvGenBusy} className="text-xs text-primary-300 hover:text-primary-200 font-medium disabled:opacity-40">Select All</button>
              <button onClick={() => setUvGenSelected(new Set())} disabled={uvGenBusy} className="text-xs text-surface-500 hover:text-surface-300 font-medium disabled:opacity-40">Select None</button>
              <span className="ml-auto text-[11px] text-surface-500">{uvGenSelected.size} of {uvGenPanels.length} selected</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {uvGenPanels.length === 0 && <p className="text-xs text-surface-500 p-3">No mesh panels found on this vehicle.</p>}
              {uvGenPanels.map((p) => {
                const checked = uvGenSelected.has(p.name);
                return (
                  <label key={p.name} className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all ${checked ? 'bg-sky-500/10 border border-sky-500/25' : 'hover:bg-overlay-4 border border-transparent'} ${uvGenBusy ? 'opacity-50 pointer-events-none' : ''}`}>
                    <input type="checkbox" checked={checked} disabled={uvGenBusy} onChange={(e) => {
                      setUvGenSelected((prev) => { const n = new Set(prev); if (e.target.checked) n.add(p.name); else n.delete(p.name); return n; });
                    }} className="w-4 h-4 accent-sky-500" />
                    <span className="text-sm text-surface-200 flex-1 truncate">{p.name}</span>
                    <span className="text-[10px] text-surface-600 font-mono">{p.vertexCount.toLocaleString()} verts</span>
                  </label>
                );
              })}
            </div>
            <div className="shrink-0 border-t border-overlay-6 p-4">
              <button onClick={generateUVTemplate} disabled={uvGenSelected.size === 0 || uvGenBusy} className="w-full py-2.5 rounded-xl text-sm font-semibold bg-sky-600/25 text-sky-200 border border-sky-500/30 hover:bg-sky-600/40 disabled:opacity-40 transition-all flex items-center justify-center gap-2">
                {uvGenBusy ? <><Loader2 size={15} className="animate-spin" /> Generating…</> : <><Scan size={15} /> Generate UV Template for {uvGenSelected.size} panel{uvGenSelected.size !== 1 ? 's' : ''}</>}
              </button>
              <p className="text-[10px] text-surface-600 mt-2 text-center">A real box-projection unwrap — not a placeholder. Saving writes the new layout back into the real .yft; the new texture is saved as a .yft-ready YTD replacement when one exists, or exported as PNG otherwise.</p>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

// Standalone page (the old /livery route, and the per-server "Tools" tab
// shortcut both still land here) — unchanged behavior, no auto-scan.
export default function LiveryEditor() {
  return <LiveryWorkspace />;
}

// ── Diagnostics panel ─────────────────────────────────────────────────────────
function DiagnosticsPanel({ diag, onClose }: { diag: VehicleDiagnostics; onClose: () => void }) {
  const s = diag.summary;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-3xl max-h-full flex flex-col bg-surface-900 border border-overlay-6 rounded-2xl shadow-2xl overflow-hidden">
        <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-b border-overlay-6 bg-surface-950/50">
          <Stethoscope size={16} className="text-cyan-400" />
          <div className="flex-1">
            <h2 className="text-sm font-bold text-surface-100">Vehicle Diagnostics — {diag.vehicle}</h2>
            <p className="text-[10px] text-surface-500 truncate">{diag.dir}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-surface-500 hover:text-surface-200 hover:bg-overlay-4"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Summary */}
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Textures" value={s.totalTexturesFound} />
            <Stat label="Decoded" value={s.totalEditable} good={s.totalEditable > 0} />
            <Stat label="Meshes" value={s.meshCount} good={s.meshCount > 0} />
            <Stat label="Materials" value={s.materialCount} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <Stat label="Vertices" value={s.vertexCount} />
            <Stat label="Triangles" value={s.triangleCount} />
            <Stat label="Shaders" value={s.shaderCount} />
            <Stat label={s.geometryDecoded ? '3D ready' : '3D pending'} value={s.geometryDecoded ? 1 : 0} good={s.geometryDecoded} bad={!s.geometryDecoded} />
          </div>

          {/* Verdict helper */}
          <div className="text-[11px] rounded-lg border border-overlay-6 bg-surface-950/40 p-3 text-surface-400 leading-relaxed">
            <b className="text-surface-200">Where's the problem?</b>{' '}
            {s.totalEditable > 0
              ? 'Editable textures decoded — the parser is working for this vehicle.'
              : s.ytdCount === 0
                ? 'No YTD files were attached to this vehicle → this is a resource-scanning issue.'
                : diag.ytds.every((y) => !y.isRSC7)
                  ? 'YTDs found but none are RSC7 → the YTD parser can\'t recognise this container format.'
                  : diag.ytds.every((y) => y.isRSC7 && !y.inflated)
                    ? 'RSC7 detected but decompression failed → decompression/parser layer.'
                    : diag.ytds.some((y) => y.declaredCount > 0 && y.textures.every((t) => !t.decoded))
                      ? 'Dictionary entries were read but every texture was rejected → the YTD parser offsets/format mapping need adjusting (see per-texture reasons below).'
                      : 'Dictionary parsing produced no entries → YTD parser layer.'}
          </div>

          {/* YFT files + geometry diagnostics */}
          <Section title={`YFT model files (${diag.yfts.length})`}>
            {diag.yfts.length === 0 && <Empty>No .yft files detected for this vehicle.</Empty>}
            {diag.yfts.map((y, i) => {
              const gd = y.geometryDiag;
              return (
                <div key={i} className="border-b border-overlay-4 last:border-0 py-2">
                  <div className="flex items-center gap-2 px-3 text-[11px]">
                    <FileText size={12} className="text-blue-400 shrink-0" />
                    <span className="text-surface-200 font-medium truncate flex-1">{y.fileName}</span>
                    {y.isHi && <span className="text-[9px] px-1 rounded bg-indigo-500/15 text-indigo-300">hi</span>}
                    <span className="text-[9px] px-1 rounded bg-surface-700/40 text-surface-400">{fmtBytes(y.fileSize)}</span>
                    <span className={`text-[9px] px-1 rounded ${y.isRSC7 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{y.isRSC7 ? 'RSC7' : 'non-RSC7'}</span>
                    {gd && <span className={`text-[9px] px-1 rounded ${gd.geometryCount > 0 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{gd.geometryCount > 0 ? `${gd.geometryCount} geos` : 'parse failed'}</span>}
                  </div>
                  {gd && (
                    <div className="px-3 mt-1 space-y-0.5">
                      {/* RSC7 + decompress summary */}
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-surface-500 font-mono">
                        <span className={`font-semibold ${gd.rsc7Magic ? 'text-emerald-300' : 'text-red-300'}`}>RSC7:{gd.rsc7Magic ? 'yes' : 'NO'}</span>
                        <span>v{gd.rsc7Version}</span>
                        <span className={`font-semibold ${gd.decompressMethod !== 'failed' && gd.decompressMethod !== 'uncompressed' ? 'text-emerald-300' : gd.decompressMethod === 'uncompressed' ? 'text-amber-300' : 'text-red-300'}`}>
                          decompress:{gd.decompressMethod}
                        </span>
                        <span>sys 0x{gd.rsc7SystemSize.toString(16)} · gfx 0x{gd.rsc7GraphicsSize.toString(16)} · inflated {fmtBytes(gd.decompressedSize)}</span>
                      </div>
                      {gd.payloadPeekHex && (
                        <p className="text-[9px] text-surface-600 font-mono">payload[0..31]: <span className="text-amber-200">{gd.payloadPeekHex}</span></p>
                      )}
                      {gd.failReason && (
                        <p className="text-[9px] text-red-300/80 font-mono">fail: {gd.failReason}</p>
                      )}
                      {/* Ptr scan stats */}
                      {(gd as any).sysPtrCount !== undefined && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-surface-500 font-mono mt-0.5">
                          <span className={(gd as any).sysPtrCount > 0 ? 'text-cyan-300' : 'text-red-300'}>
                            sysPtrs:{(gd as any).sysPtrCount} maxOff:0x{((gd as any).maxSysPtrOff||0).toString(16)}
                          </span>
                          <span>gfxPtrs:{(gd as any).gfxPtrCount} maxOff:0x{((gd as any).maxGfxPtrOff||0).toString(16)}</span>
                          {(gd as any).sysSizeUsed > 0 && <span>sysSizeUsed:0x{(gd as any).sysSizeUsed.toString(16)} ({(gd as any).sysSizeSource})</span>}
                        </div>
                      )}
                      {/* Geometry parse details */}
                      {gd.decompressMethod !== 'failed' && (
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-surface-500 font-mono mt-0.5">
                          <span className={gd.drawableBase >= 0 ? 'text-emerald-300' : 'text-red-300'}>drawable@0x{gd.drawableBase >= 0 ? gd.drawableBase.toString(16) : 'NOT FOUND'}</span>
                          {gd.drawableLodUsed && <span>lod:{gd.drawableLodUsed}</span>}
                          <span>{gd.shaderCount} shaders · {gd.modelsFound} models · {gd.geometryCount} geos</span>
                          <span>{gd.totalVertices.toLocaleString()} verts · {gd.totalTriangles.toLocaleString()} tris</span>
                          {gd.vertexStrides.length > 0 && <span>strides: {gd.vertexStrides.join(', ')}</span>}
                        </div>
                      )}
                      {/* INVESTIGATION LOG — always shown, scrollable */}
                      {(gd as any).investigationLog?.length > 0 && (
                        <details className="mt-1" open={gd.geometryCount === 0}>
                          <summary className="text-[9px] text-cyan-300 cursor-pointer font-semibold">
                            Investigation log ({(gd as any).investigationLog.length} lines)
                          </summary>
                          <pre className="text-[8px] leading-tight text-surface-300 bg-black/50 rounded p-2 overflow-auto font-mono mt-1 max-h-80 whitespace-pre-wrap">
                            {(gd as any).investigationLog.join('\n')}
                          </pre>
                        </details>
                      )}
                      {/* Top probe results */}
                      {gd.probeResults.length > 0 && (
                        <details className="mt-1">
                          <summary className="text-[9px] text-cyan-300 cursor-pointer">All probe candidates (top 20)</summary>
                          <div className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                            {gd.probeResults.slice(0, 20).map((p, k) => (
                              <p key={k} className={`text-[9px] font-mono ${p.score >= 50 ? 'text-emerald-300' : p.score >= 20 ? 'text-yellow-300' : 'text-surface-500'}`}>
                                base=0x{p.base.toString(16).padStart(4,'0')} score={String(p.score).padStart(3,' ')} {p.desc}
                              </p>
                            ))}
                          </div>
                        </details>
                      )}
                      {gd.shaders.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {gd.shaders.slice(0, 6).map((sh, k) => (
                            <p key={k} className="text-[9px] text-surface-500 font-mono">
                              <span className="text-blue-300">{sh.filename || `shader_${k}`}</span>
                              {sh.textureParams.length > 0 && <span className="text-surface-400"> → {sh.textureParams.join(', ')}</span>}
                            </p>
                          ))}
                          {gd.shaders.length > 6 && <p className="text-[9px] text-surface-600">…{gd.shaders.length - 6} more shaders</p>}
                        </div>
                      )}
                      {gd.notes.map((n, k) => <p key={k} className="text-[9px] text-cyan-300/80">{n}</p>)}
                      {gd.warnings.slice(0, 15).map((n, k) => <p key={k} className="text-[9px] text-amber-300/80">⚠ {n}</p>)}
                      {gd.errors.map((n, k) => <p key={k} className="text-[9px] text-red-300/80">✕ {n}</p>)}
                      {/* Raw hex dumps */}
                      {((gd as any).bufferHex || gd.drawableHeaderHex) && (
                        <details className="mt-1">
                          <summary className="text-[9px] text-cyan-300 cursor-pointer">Raw byte inspection</summary>
                          <div className="mt-1 space-y-2">
                            {(gd as any).bufferHex && (
                              <div>
                                <p className="text-[8px] text-surface-600 mb-0.5">Decompressed buffer (first 0x200 bytes) — check for 0x5XXXXXXX / 0x6XXXXXXX RAGE ptr patterns:</p>
                                <pre className="text-[8px] leading-tight text-surface-400 bg-black/40 rounded p-1.5 overflow-auto font-mono max-h-64">{(gd as any).bufferHex}</pre>
                              </div>
                            )}
                            {gd.drawableHeaderHex && (
                              <div>
                                <p className="text-[8px] text-surface-600 mb-0.5">Drawable header @ 0x{gd.drawableBase.toString(16)} (+0x10=ShaderGroup, +0x50=ModelsHigh):</p>
                                <pre className="text-[8px] leading-tight text-surface-400 bg-black/40 rounded p-1.5 overflow-auto font-mono max-h-48">{gd.drawableHeaderHex}</pre>
                              </div>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                  {!gd && <p className="px-3 mt-0.5 text-[9px] text-surface-600">{y.note}</p>}
                </div>
              );
            })}
          </Section>
          <p className="text-[10px] text-surface-600 -mt-3">{diag.materials.note}</p>

          {/* YTD files */}
          <Section title={`YTD texture dictionaries (${diag.ytds.length})`}>
            {diag.ytds.length === 0 && <Empty>No .ytd files were attached to this vehicle (resource-scanning issue).</Empty>}
            {diag.ytds.map((y, i) => (
              <div key={i} className="border-b border-overlay-4 last:border-0 py-2">
                <div className="flex items-center gap-2 px-3 text-[11px]">
                  <ImageIcon size={12} className="text-pink-400 shrink-0" />
                  <span className="text-surface-200 font-medium truncate flex-1">{y.fileName}</span>
                  <span className="text-[9px] px-1 rounded bg-surface-700/40 text-surface-400">{fmtBytes(y.fileSize)}</span>
                  <span className={`text-[9px] px-1 rounded ${y.isRSC7 ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{y.isRSC7 ? 'RSC7' : 'non-RSC7'}</span>
                  <span className="text-[9px] px-1 rounded bg-cyan-500/15 text-cyan-300">{y.method}</span>
                </div>
                <div className="px-3 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-surface-500 font-mono">
                  {y.inflated && <span>sys {fmtBytes(y.systemSize || 0)} · gfx {fmtBytes(y.graphicsSize || 0)} · inflated {fmtBytes(y.decompressedSize || 0)}</span>}
                  <span>declared count: {y.declaredCount}</span>
                  <span>entries @ {y.entriesOffset != null && y.entriesOffset >= 0 ? `0x${y.entriesOffset.toString(16)}` : 'unresolved'}</span>
                </div>
                {y.notes.map((n, j) => (
                  <p key={j} className="px-3 mt-1 text-[10px] text-amber-300/80">⚠ {n}</p>
                ))}
                {/* per-texture table */}
                {y.textures.length > 0 && (
                  <div className="mt-2 mx-3 rounded-lg border border-overlay-6 overflow-hidden">
                    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 px-2 py-1 bg-surface-950/50 text-[9px] uppercase tracking-wide text-surface-600">
                      <span>Texture</span><span>Size</span><span>Format</span><span>Fmt@</span><span>Status</span>
                    </div>
                    {y.textures.map((t, k) => (
                      <div key={k} className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-2 px-2 py-1 text-[10px] border-t border-overlay-4 items-center">
                        <span className="text-surface-300 truncate" title={t.reason}>{t.name}</span>
                        <span className="text-surface-500 font-mono">{t.width}×{t.height}</span>
                        <span className="text-surface-500 font-mono">{t.format || `0x${t.formatCode.toString(16)}`}</span>
                        <span className="text-surface-600 font-mono">{t.formatFieldOffset != null ? `+0x${t.formatFieldOffset.toString(16)}` : '—'}</span>
                        <span className="flex items-center gap-1">
                          {t.decoded
                            ? <><CheckCircle2 size={11} className="text-emerald-400" /><span className="text-emerald-300">ok</span></>
                            : <><XCircle size={11} className="text-red-400" /><span className="text-red-300 truncate" title={t.reason}>rej</span></>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* rejection reasons */}
                {y.textures.some((t) => !t.decoded) && (
                  <div className="mt-1.5 mx-3 space-y-0.5">
                    {y.textures.filter((t) => !t.decoded).slice(0, 12).map((t, k) => (
                      <p key={k} className="text-[9px] text-surface-500"><span className="text-red-300/80">{t.name}:</span> {t.reason}</p>
                    ))}
                  </div>
                )}
                {/* RAW INSPECTION */}
                {(y.dictHeaderHex || y.textures.some((t) => t.rawHex)) && (
                  <details className="mt-2 mx-3">
                    <summary className="text-[10px] text-cyan-300 cursor-pointer hover:text-cyan-200">Raw byte inspection (dictionary header + first textures)</summary>
                    <div className="mt-1.5 space-y-2">
                      {y.dictHeaderHex && (
                        <div>
                          <p className="text-[9px] text-surface-500 mb-0.5">Dictionary header @ system 0x0 (Textures ptr @0x30, count @0x38):</p>
                          <pre className="text-[9px] leading-tight text-surface-400 bg-black/40 rounded p-2 overflow-x-auto font-mono">{y.dictHeaderHex}</pre>
                        </div>
                      )}
                      {y.textures.filter((t) => t.rawHex).map((t, k) => (
                        <div key={k}>
                          <p className="text-[9px] text-surface-500 mb-0.5">
                            <span className="text-surface-300">{t.name}</span> @ 0x{(t.texOffset ?? 0).toString(16)} —
                            Format <span className="text-cyan-300">{t.format || `0x${t.formatCode.toString(16)}`}</span> @ +0x{(t.formatFieldOffset ?? 0).toString(16)},
                            dims {t.width}×{t.height}, derived Width@+0x{((t.formatFieldOffset ?? 8) - 8).toString(16)}
                          </p>
                          <pre className="text-[9px] leading-tight text-surface-400 bg-black/40 rounded p-2 overflow-x-auto font-mono">{t.rawHex}</pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, good, bad }: { label: string; value: number; good?: boolean; bad?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 text-center ${good ? 'border-emerald-500/30 bg-emerald-500/5' : bad ? 'border-red-500/30 bg-red-500/5' : 'border-overlay-6 bg-surface-950/40'}`}>
      <p className={`text-lg font-bold ${good ? 'text-emerald-300' : bad ? 'text-red-300' : 'text-surface-200'}`}>{value}</p>
      <p className="text-[9px] uppercase tracking-wide text-surface-600">{label}</p>
    </div>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-widest text-surface-600 mb-1.5">{title}</p>
      <div className="rounded-lg border border-overlay-6 bg-surface-950/30 overflow-hidden">{children}</div>
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-[11px] text-surface-500">{children}</p>;
}
function fmtBytes(n: number): string {
  if (n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function ThumbCanvas({ source }: { source: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const c = ref.current; if (!c) return; c.width = 56; c.height = 56; const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, 56, 56); try { ctx.drawImage(source, 0, 0, 56, 56); } catch { /* */ } });
  return <canvas ref={ref} className="w-full h-full object-cover" style={{ imageRendering: 'pixelated' }} />;
}
function ThumbImageData({ id, large }: { id: ImageData; large?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const px = large ? 256 : 56;
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const tmp = document.createElement('canvas'); tmp.width = id.width; tmp.height = id.height;
    tmp.getContext('2d')!.putImageData(id, 0, 0);
    c.width = px; c.height = px;
    const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, px, px);
    // preserve aspect ratio for the large browser thumbnails
    if (large) {
      const s = Math.min(px / id.width, px / id.height);
      const dw = id.width * s, dh = id.height * s;
      ctx.drawImage(tmp, (px - dw) / 2, (px - dh) / 2, dw, dh);
    } else {
      ctx.drawImage(tmp, 0, 0, px, px);
    }
  }, [id, px, large]);
  return <canvas ref={ref} className="w-full h-full object-contain" style={{ imageRendering: 'pixelated' }} />;
}
function LivePreview({ edit }: { edit: TargetEdit }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return; const size = 240; c.width = size; c.height = size;
    const ctx = c.getContext('2d')!; ctx.clearRect(0, 0, size, size);
    const scale = Math.min(size / edit.w, size / edit.h); const dw = edit.w * scale, dh = edit.h * scale;
    ctx.drawImage(edit.canvas, (size - dw) / 2, (size - dh) / 2, dw, dh);
  });
  return <canvas ref={ref} className="w-full rounded-lg border border-overlay-6" style={{ imageRendering: 'pixelated' }} />;
}
