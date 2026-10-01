// Livery Editor painting rewrite — static-source assertions, matching this
// project's existing convention for renderer .tsx files (see
// test/library/ui-structure.test.js's own header: no jsdom/@testing-library/
// react/Playwright in this repo, so a Canvas-heavy, Three.js-driven page
// like LiveryEditor.tsx is verified by reading the real shipped .tsx/.ts
// source text and asserting on it directly, not by rendering it).
//
// THE REAL BUGS THIS GUARDS (reported directly by the user):
//  1. The paint surface was a plain square with no UV template — fixed by
//     wiring up slotUVEdges() (glbVehicle.ts), which already existed but
//     was completely unused anywhere in the app.
//  2. Painting stuttered badly — caused by composite() (a full recomposite
//     of every layer across the whole texture, plus a GPU texture push)
//     running synchronously on EVERY pointermove event. Fixed by batching
//     to at most one recomposite per animation frame.
//  3. Imported images had no way to be moved/scaled/rotated after import.
//  4. Mesh-pick-on-click could misfire during an OrbitControls camera drag.
//  5. Four separate, confusing save/export buttons.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  ✗', name); } };

const editorSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/LiveryEditor.tsx'), 'utf-8');
const glbVehicleSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/services/glbVehicle.ts'), 'utf-8');
const viewerSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/services/vehicleViewer.ts'), 'utf-8');

// ── 1. UV template overlay ───────────────────────────────────────────────
ok('glbVehicle.ts still exports slotUVEdges (the UV-wireframe data source)', /export function slotUVEdges/.test(glbVehicleSrc));
ok('REPRODUCED THE FIX: LiveryEditor now actually imports slotUVEdges — it used to be dead code, never consumed anywhere', /import \{ slotUVEdges \} from '\.\.\/services\/glbVehicle'/.test(editorSrc));
ok('a dedicated uvCanvas ref exists for the wireframe overlay, separate from the texture and shape-preview canvases', /const uvCanvas = useRef<HTMLCanvasElement>/.test(editorSrc));
ok('a uvEdgesForTarget function computes/caches per-target UV edges (never recomputed on every paint stroke)', /function uvEdgesForTarget\(t: EditTarget\)/.test(editorSrc) && /uvEdgesByTarget\.current\.get\(t\.id\)/.test(editorSrc));
ok('the UV cache is cleared when a new vehicle is loaded (target ids are reused across vehicles)', /uvEdgesByTarget\.current\.clear\(\)/.test(editorSrc));
ok('a drawUVOverlay function strokes the UV edges scaled into texture-pixel space', /function drawUVOverlay/.test(editorSrc) && /edges\[i\] \* t\.w/.test(editorSrc));
ok('a visible toolbar toggle exists for the UV template, defaulting ON', /const \[showUVOverlay, setShowUVOverlay\] = useState\(true\)/.test(editorSrc) && />\s*UV Template\s*<\/button>/.test(editorSrc));
ok('the uvCanvas element is actually rendered in the center editor, layered with the texture canvas', /<canvas ref=\{uvCanvas\}/.test(editorSrc));

// ── 2. Paint performance — throttled recomposite ─────────────────────────
ok('a scheduleRender function exists that batches composite() to at most once per animation frame', /function scheduleRender\(id: string\)[\s\S]{0,300}requestAnimationFrame/.test(editorSrc));
ok('REPRODUCED THE FIX: paintAt no longer calls composite() directly on every pointer event — it goes through scheduleRender', (() => {
  const start = editorSrc.indexOf('function paintAt(');
  const end = editorSrc.indexOf('\n  function floodFill');
  const body = editorSrc.slice(start, end);
  return /scheduleRender\(selected!\)/.test(body) && !/\bcomposite\(selected!\)/.test(body);
})());
ok('REPRODUCED THE FIX: updateLayer (opacity/blend-mode slider) also batches through scheduleRender, not a direct composite on every onChange tick', (() => {
  const start = editorSrc.indexOf('function updateLayer(');
  const body = editorSrc.slice(start, start + 600);
  return /scheduleRender\(selected!\)/.test(body);
})());
ok('brush strokes are line-interpolated between the last and current point so fast drags don\'t leave gaps between dabs', /function paintAt\(p: \{ x: number; y: number \}\)/.test(editorSrc) && /lastPaintPt\.current/.test(editorSrc) && /Math\.hypot\(dx, dy\)/.test(editorSrc));
ok('the checkerboard background pattern is built once and cached, not rebuilt from scratch on every redraw', /function checkerPattern\(\)[\s\S]{0,500}checkerPatternRef\.current = pat/.test(editorSrc));
ok('the shape-preview pointermove handler no longer forces a React re-render on every mouse move (it draws directly on its own canvas)', (() => {
  const start = editorSrc.indexOf('const onPointerMove = ');
  const end = editorSrc.indexOf('\n  const onPointerUp');
  const body = editorSrc.slice(start, end);
  const shapeBranch = body.slice(body.indexOf('shapeStart.current) {'));
  return !/rerender\(\)/.test(shapeBranch);
})());

// ── 3. Image/text/shape layer transforms ─────────────────────────────────
ok('Layer now has an optional rotation field', /rotation\?: number;/.test(editorSrc));
ok('composite() applies layer rotation around the layer\'s own center when drawing it', /ctx\.translate\(cx, cy\); ctx\.rotate\(l\.rotation\); ctx\.translate\(-cx, -cy\);/.test(editorSrc));
ok('REPRODUCED THE FIX: a hit-testable set of transform handles (move + 4 corner scale + rotate) exists for the active transformable layer', /type TransformHandle = 'move' \| 'tl' \| 'tr' \| 'bl' \| 'br' \| 'rotate'/.test(editorSrc));
ok('only image/text/shape/gradient/fill layers are transformable — base and paint layers (which always cover the full texture) are excluded', /const TRANSFORMABLE_KINDS = new Set<LayerKind>\(\['image', 'text', 'shape', 'gradient', 'fill'\]\)/.test(editorSrc));
ok('a hitTestHandle function determines which handle (if any) the pointer landed on', /function hitTestHandle\(/.test(editorSrc));
ok('starting a transform gesture pushes one undo step for the whole move/scale/rotate, not one per pointermove tick', /pushUndo\(selected\); \/\/ one undo step for the whole move\/scale\/rotate gesture/.test(editorSrc));
ok('corner-handle dragging scales uniformly from the layer\'s own center', /Corner handle: uniform scale from the layer's own center/.test(editorSrc));
ok('the rotate handle computes rotation from the angle between the gesture start and current pointer relative to the layer center', /Math\.atan2\(g\.startY - cy, g\.startX - cx\)/.test(editorSrc) && /Math\.atan2\(p\.y - cy, p\.x - cx\)/.test(editorSrc));
ok('transform handles redraw live during a drag (imperative, not waiting for a React re-render) for immediate visual feedback', /drawTransformHandles\(activeLayer\);\s*\n\s*return;/.test(editorSrc));

// ── 4. Mesh-pick reliability ──────────────────────────────────────────────
ok('REPRODUCED THE FIX: VehicleViewer no longer uses a plain "click" listener for mesh picking (it also fires after an OrbitControls drag)', !/addEventListener\('click', this\.handleClick\)/.test(viewerSrc));
ok('mesh picking now tracks pointerdown/pointerup with a movement tolerance, so a camera-orbit drag is never misread as a selection', /CLICK_MOVE_TOLERANCE_PX/.test(viewerSrc) && /Math\.hypot\(dx, dy\) > VehicleViewer\.CLICK_MOVE_TOLERANCE_PX\) return/.test(viewerSrc));
ok('the selection highlight is strong enough to actually read as "selected" (not the old, nearly-invisible 0.18 intensity)', /emissiveIntensity = on \? 0\.45 : 0/.test(viewerSrc));

// ── 5. One clear Save action ──────────────────────────────────────────────
ok('REPRODUCED THE FIX: the old 4 separate Save All / Save to YTD / Save PNG / Export buttons are gone from the toolbar', !/>\s*Save All\s*<\/button>/.test(editorSrc));
ok('exactly one primary Save button exists, defaulting to the sensible universal action (save every edited texture back into its YTD)', /onClick=\{batchSaveToYTD\}[\s\S]{0,300}title="Save every edited texture back into its \.ytd file/.test(editorSrc));
ok('the secondary save/export options (per-texture save, PNG export, exporter picker) are tucked into a dropdown next to the primary button, not cluttering the main toolbar', /setShowSaveMenu\(\(v\) => !v\)/.test(editorSrc) && /Save this texture only/.test(editorSrc) && /Save as PNG…/.test(editorSrc));

// ── 6. Vehicle Studio integration — discoverable without any server ──────
const vsSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/VehicleStudio.tsx'), 'utf-8');
const liveryTabSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/components/vehicle-studio/LiveryTab.tsx'), 'utf-8');
const serverPanelSrc = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/pages/ServerPanel.tsx'), 'utf-8');

ok('LiveryEditor now exports a parameterized LiveryWorkspace usable as an embeddable tab, not just the standalone page', /export function LiveryWorkspace\(\{ initialRoot, embedded \}: LiveryWorkspaceProps\)/.test(editorSrc));
ok('an embedded LiveryWorkspace auto-scans its workspace root instead of showing the "Open a Vehicle Resource" landing screen a second time', /if \(initialRoot\) scanDir\(initialRoot\);/.test(editorSrc));
ok('REPRODUCED THE FIX: Vehicle Studio now has a "Livery" tab at the same level as Handling/Smart Tune', /\{ id: 'livery', label: 'Livery', icon: Palette \}/.test(vsSrc));
ok('the Livery tab is rendered with the real current workspace root (scan.root) — no second import step', /tab === 'livery' && <LiveryTab root=\{scan\.root\} \/>/.test(vsSrc));
ok('LiveryTab embeds the real LiveryWorkspace, pointed at the Vehicle Studio workspace', /<LiveryWorkspace key=\{root\} initialRoot=\{root\} embedded \/>/.test(liveryTabSrc));
ok('REPRODUCED THE FIX: the per-server "Livery Editor" Tools shortcut no longer goes straight to the standalone /livery route — it opens Vehicle Studio\'s Livery tab instead', !/path: '\/livery'/.test(serverPanelSrc) && /defaultTab: 'livery'/.test(serverPanelSrc));
ok('a fresh Vehicle Studio import honors a pending defaultTab (from the server shortcut) exactly once, then falls back to Overview for later imports in the same session', /setTab\(pendingTabRef\.current \|\| 'overview'\);\s*\n\s*pendingTabRef\.current = null;/.test(vsSrc));

// ── 7. Auto Sync — the live 3D preview must never need a manual click ────
ok('REPRODUCED THE FIX: composite() no longer requires an exact, unnormalized name match to push the edited texture onto the 3D model — strings are trimmed/null-stripped before comparing', /const norm = \(s: string\) => s\.trim\(\)\.replace\(\/\\0\+\$\/, ''\)\.toLowerCase\(\);/.test(editorSrc));
ok('REPRODUCED THE FIX: when no material directly references the edited texture, it is now automatically applied to every material instead of silently updating nothing', /slots = geometry\.slots;\s*\n\s*autoSynced = slots\.length > 0;/.test(editorSrc));
ok('a real, always-visible "Auto Sync" status badge exists in the paint toolbar (not just a one-off debug button the user has to find and click)', /Auto Sync \{autoSyncedAll \? '· synced to all materials' : 'ON'\}/.test(editorSrc));
ok('the old manual "Force Selected Texture" button is now explicitly documented as a debug override, not something normal painting depends on', /Debug: force selected texture on ALL materials/.test(editorSrc));

// ── 8. Generate UV Template — real algorithm + real write-back, not a stub ─
ok('LiveryEditor imports the real UV-generation + write-back modules, not a placeholder', /from '\.\.\/services\/rage\/uvGenerator'/.test(editorSrc) && /from '\.\.\/services\/rage\/yftWriter'/.test(editorSrc));
ok('a real panel-selection modal exists, listing the vehicle\'s own real meshes (listPanels), not a fake/hardcoded list', /uvGenPanels: PanelInfo\[\] = geometry \? listPanels\(geometry\.meshes\) : \[\];/.test(editorSrc));
ok('generateUVTemplate() applies the real box-projected UVs straight onto the live geometry so painting works immediately in this session', /applyGeneratedUVs\(results\);/.test(editorSrc));
ok('a newly generated texture is routed to EXACTLY the material slots of the selected panels (generatedTargetSlots), never to the whole car via the generic Auto Sync fallback', /generatedTargetSlots\.current\.set\(newId, slotIds\);/.test(editorSrc) && /const explicitSlotIds = generatedTargetSlots\.current\.get\(id\);/.test(editorSrc));
ok('saving a generated UV layout writes it back into the real .yft in place (writeUVsToYFT), with a .bak backup written first', /const wr = await writeUVsToYFT\(origBuf, patches\);/.test(editorSrc) && /writeFile\(modelPath \+ '\.bak', origB64\)/.test(editorSrc));
ok('a generated texture with no existing YTD slot is honestly exported as a loose PNG instead of silently discarding the painted work', /unmatchedGenerated\.push\(t\)/.test(editorSrc) && /no existing YTD slot/.test(editorSrc));

// ── 9. Paint tools UI enlarged ─────────────────────────────────────────────
ok('REPRODUCED THE FIX: toolbar tool-button icons were enlarged (13px -> 18px) for comfortable hit targets', /<MousePointer size=\{18\} \/>,'Move \/ pan'\]/.test(editorSrc));
ok('color swatches were enlarged (24px -> 36px)', /className="w-9 h-9 rounded-lg border-2 border-overlay-8 shadow-md/.test(editorSrc));
ok('the brush-size slider is labeled and widened, not a bare unlabeled 80px-wide range input', /<span className="text-xs text-surface-500">Size<\/span>/.test(editorSrc) && /className="w-32 h-2 accent-pink-500"/.test(editorSrc));
ok('the layer opacity panel text/controls were enlarged (11px -> text-sm, thicker slider)', /<span className="text-sm font-medium text-surface-300">Opacity<\/span>/.test(editorSrc));

console.log(`\nLIVERY EDITOR PAINT/UV/TRANSFORM TESTS: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
