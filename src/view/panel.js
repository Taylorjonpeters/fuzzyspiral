// Sidebar controls. Inputs edit the settings object in place and call `changed()`;
// only structural edits (add, remove, reorder a layer) rebuild the DOM, so a slider
// keeps focus while it is being dragged.
//
// The main view keeps only the controls most people touch. Explanations live in tooltips
// (`tip`), and fine-tuning sits in collapsed "More" sections.

import { makeLayer, PRESETS } from "../core/patterns.js";
import { createSwatch } from "./fuzzSwatch.js";

/** Control specs per layer type. `kind` is range | number | select | check. */
const PARAMS = {
  constant: [],
  zrange: [
    { k: "unit", label: "Measure in", kind: "select", options: [["layer", "layers"], ["mm", "mm"]] },
    { k: "from", label: "From", kind: "number", step: 1, tip: "First layer (or height) that gets fuzz, inclusive." },
    { k: "to", label: "To", kind: "number", step: 1, tip: "Last layer (or height) that gets fuzz, inclusive." },
  ],
  radius: [
    { k: "min", label: "Inner edge (mm from center)", kind: "range", min: 0, max: 150, step: 0.5, tip: "Walls closer to the center than this stay smooth." },
    { k: "max", label: "Outer edge (mm, 0 = none)", kind: "range", min: 0, max: 300, step: 0.5, tip: "Walls further out than this stay smooth. 0 means no outer limit." },
  ],
  spiral: [
    { k: "starts", label: "Starts", kind: "range", min: 1, max: 16, step: 1, tip: "How many separate spiral stripes wind around the part." },
    { k: "pitch", label: "Pitch (mm)", kind: "range", min: 2, max: 500, step: 1, tip: "Height a stripe climbs in one full turn. Smaller is steeper." },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01, tip: "Share of each repeat that is fuzzed." },
  ],
  stripes: [
    { k: "count", label: "Count", kind: "range", min: 1, max: 64, step: 1, tip: "Number of vertical stripes around the part." },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01, tip: "Share of each repeat that is fuzzed." },
  ],
  bands: [
    { k: "period", label: "Spacing (mm)", kind: "range", min: 0.4, max: 40, step: 0.2, tip: "Height of one fuzzed band plus one smooth band." },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01, tip: "Share of each repeat that is fuzzed." },
  ],
  checker: [
    { k: "count", label: "Columns", kind: "range", min: 2, max: 48, step: 2, tip: "Number of checker columns around the part." },
    { k: "period", label: "Row height (mm)", kind: "range", min: 0.4, max: 40, step: 0.2 },
  ],
  gradient: [
    { k: "startAmp", label: "Bottom", kind: "range", min: 0, max: 1, step: 0.01, tip: "Fuzz amount at the start height." },
    { k: "endAmp", label: "Top", kind: "range", min: 0, max: 1, step: 0.01, tip: "Fuzz amount at the end height." },
  ],
};

/** Per-type settings that are useful but rarely changed; shown under "More". */
const MORE_PARAMS = {
  spiral: [
    { k: "hand", label: "Twist", kind: "select", options: [["right", "right-hand"], ["left", "left-hand"]], tip: "Which way the spiral winds as it rises." },
    { k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01, tip: "Turns the pattern around the part." },
  ],
  stripes: [{ k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01, tip: "Turns the pattern around the part." }],
  bands: [{ k: "phase", label: "Shift", kind: "range", min: 0, max: 1, step: 0.01, tip: "Moves the bands up or down." }],
  checker: [{ k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01, tip: "Turns the pattern around the part." }],
  gradient: [
    { k: "from", label: "Start (% height)", kind: "range", min: 0, max: 100, step: 1 },
    { k: "to", label: "End (% height)", kind: "range", min: 0, max: 100, step: 1 },
    { k: "ease", label: "Ease", kind: "check", tip: "Smooth S-curve instead of a straight ramp." },
  ],
};

const TYPE_LABEL = {
  constant: "Everywhere", zrange: "Layer range", radius: "Distance from center", spiral: "Spiral", stripes: "Vertical stripes",
  bands: "Horizontal bands", checker: "Checker", gradient: "Height gradient",
};

const TYPE_TIP = {
  constant: "Fuzz the whole outer wall, like the slicer's own fuzzy skin.",
  zrange: "Fuzz only between two layers or heights.",
  radius: "Keep the middle smooth: fuzz only walls far enough from the center.",
  spiral: "Stripes that wind around the part as it rises.",
  stripes: "Vertical stripes evenly spaced around the part.",
  bands: "Horizontal rings at a fixed spacing.",
  checker: "Alternating squares around and up the part.",
  gradient: "Fuzz that fades in or out with height.",
};

const BLEND_TIP = "How this layer combines with the ones above it: union adds its area, intersect keeps only the overlap, subtract cuts it out.";

const FUZZ = [
  { k: "thickness", swatch: true, label: "Thickness (mm)", kind: "range", min: 0.05, max: 1.5, step: 0.01, tip: "How far the nozzle wanders from the wall. Bambu's default is 0.3." },
  { k: "pointDist", swatch: true, label: "Point distance (mm)", kind: "range", min: 0.1, max: 3, step: 0.05, tip: "Spacing between wiggles along the wall. Smaller is finer. Bambu's default is 0.8." },
  { k: "walls", label: "Walls", kind: "select", options: [["all", "every outer wall"], ["contour", "skip holes"], ["outermost", "outermost skin only"]], tip: "Skip holes leaves walls inside holes smooth, like Bambu's Contour option. Outermost skin only fuzzes just the surface you see from outside: looking out from the pattern center, only the furthest wall in each direction. A lamp's inside face, socket tube and cable slot stay smooth." },
];

const FUZZ_MORE = [
  { k: "noise", swatch: true, label: "Noise", kind: "select", options: [["classic", "classic (random)"], ["perlin", "Perlin (smooth)"]], tip: "Classic matches slicer fuzzy skin. Perlin varies smoothly, so neighbouring layers line up into a texture." },
  { k: "noiseScale", swatch: true, label: "Perlin scale (mm)", kind: "range", min: 0.2, max: 10, step: 0.1, when: (f) => f.noise === "perlin", tip: "Size of the Perlin texture's features." },
  { k: "mode", label: "Direction", swatch: true, kind: "select", options: [["both", "in and out"], ["outward", "outward only"]], tip: "Outward only never cuts into the part, so dimensions stay at least nominal." },
  { k: "seed", swatch: true, label: "Seed", kind: "number", step: 1, tip: "Change for a different random texture with the same settings." },
  { k: "maxPtsPerMm", swatch: true, label: "Max points per mm", kind: "range", min: 1, max: 20, step: 0.5, tip: "Caps detail so very fine fuzz doesn't make the printer stutter." },
  { k: "skipFirstLayer", label: "Leave first layer smooth", kind: "check", tip: "Keeps bed adhesion and elephant-foot unaffected." },
];

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c);
  return el;
};

/** One labelled control bound to obj[spec.k]. */
function control(obj, spec, changed) {
  const el = controlEl(obj, spec, changed);
  if (spec.swatch) el.dataset.swatch = "";
  return el;
}

function controlEl(obj, spec, changed) {
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  const v = obj[spec.k];
  const title = spec.tip;
  if (spec.kind === "check") {
    return h("label", { class: "row check", title },
      h("input", { type: "checkbox", checked: !!v, onchange: (e) => { obj[spec.k] = e.target.checked; changed(); } }),
      spec.label);
  }
  if (spec.kind === "select") {
    const sel = h("select", { id, onchange: (e) => { obj[spec.k] = e.target.value; changed(true); } },
      spec.options.map(([val, text]) => h("option", { value: val, selected: val === v }, text)));
    return h("div", { class: "row", title }, h("label", { for: id }, spec.label), sel);
  }
  if (spec.kind === "number") {
    return h("div", { class: "row", title }, h("label", { for: id }, spec.label),
      h("input", { id, type: "number", step: spec.step ?? "any", value: v,
        onchange: (e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) { obj[spec.k] = n; changed(); } } }));
  }
  const out = h("output", {}, fmt(v));
  return h("div", { class: "row", title }, h("label", { for: id }, spec.label, out),
    h("input", { id, type: "range", min: spec.min, max: spec.max, step: spec.step, value: v,
      oninput: (e) => { obj[spec.k] = parseFloat(e.target.value); out.textContent = fmt(obj[spec.k]); changed(); } }));
}

const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

/** A collapsed "More" section; returns null when it would be empty. */
const more = (kids, label = "More") => {
  const list = kids.filter(Boolean);
  return list.length ? h("details", { class: "more" }, h("summary", {}, label), list) : null;
};

/**
 * @param {HTMLElement} root
 * @param {{settings: any}} state
 * @param {{changed: () => void, pickCenter: () => void, savePattern: () => void, loadPattern: () => void,
 *          drawSpiral: (layer: import('../core/patterns.js').MaskLayer) => void}} actions
 */
export function mountPanel(root, state, actions) {
  const stackHost = h("div", { class: "stack" });
  const fuzzHost = h("div");

  // Close-up of the fuzz beside the slider being hovered or dragged.
  const swatch = createSwatch();
  let swatchRow = null;
  let dragging = false;
  const showSwatch = (row) => { swatchRow = row; swatch.draw(state.settings.fuzz); swatch.showAt(row); };
  const hideSwatch = () => { if (!dragging) { swatchRow = null; swatch.hide(); } };
  fuzzHost.addEventListener("pointerover", (e) => { const r = e.target.closest("[data-swatch]"); if (r && r !== swatchRow) showSwatch(r); });
  fuzzHost.addEventListener("pointerleave", hideSwatch);
  fuzzHost.addEventListener("pointerover", (e) => { if (!e.target.closest("[data-swatch]")) hideSwatch(); });
  fuzzHost.addEventListener("focusin", (e) => { const r = e.target.closest("[data-swatch]"); if (r) showSwatch(r); });
  fuzzHost.addEventListener("focusout", hideSwatch);
  fuzzHost.addEventListener("pointerdown", (e) => { if (e.target.closest("[data-swatch]")) dragging = true; });
  addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    // Keep it up if the pointer is still over a fuzz control.
    if (!fuzzHost.matches(":hover")) hideSwatch();
  });

  const rebuildStack = () => {
    const stack = state.settings.stack;
    // Keep open "More" sections open across rebuilds.
    const open = new Set([...stackHost.querySelectorAll("details[open]")].map((d) => d.dataset.id));
    stackHost.replaceChildren(...stack.map((L, i) => layerCard(L, i, stack.length, open.has(L.id))));
    if (!stack.length) stackHost.append(h("p", { class: "hint" }, "Nothing is fuzzed. Pick a preset or add a layer with +."));
  };

  const structural = () => { rebuildStack(); actions.changed(); };

  const layerCard = (L, i, n, moreOpen) => {
    const stack = state.settings.stack;
    const move = (d) => { const j = i + d; [stack[i], stack[j]] = [stack[j], stack[i]]; structural(); };
    const changedP = (rebuild) => (rebuild ? structural() : actions.changed());
    const head = h("div", { class: "card-head" },
      h("input", { type: "checkbox", title: "Turn this layer on or off", checked: L.enabled, onchange: (e) => { L.enabled = e.target.checked; structural(); } }),
      h("strong", { title: TYPE_TIP[L.type] }, TYPE_LABEL[L.type]),
      i > 0
        ? h("select", { title: BLEND_TIP, onchange: (e) => { L.blend = e.target.value; actions.changed(); } },
            [["max", "union"], ["multiply", "intersect"], ["subtract", "subtract"], ["add", "add"], ["min", "min"]]
              .map(([v, t]) => h("option", { value: v, selected: L.blend === v }, t)))
        : null,
      h("span", { class: "grow" }),
      n > 1 ? h("button", { class: "icon", title: "Move up", disabled: i === 0, onclick: () => move(-1) }, "↑") : null,
      n > 1 ? h("button", { class: "icon", title: "Move down", disabled: i === n - 1, onclick: () => move(1) }, "↓") : null,
      h("button", { class: "icon", title: "Remove layer", onclick: () => { stack.splice(i, 1); structural(); } }, "×"));

    const mmFeather = L.type === "zrange" || L.type === "radius";
    const feathers = L.type !== "gradient" && L.type !== "constant" && !(L.type === "zrange" && L.params.unit === "layer");
    const extra = more([
      ...(MORE_PARAMS[L.type] ?? []).map((p) => control(L.params, p, changedP)),
      feathers
        ? control(L, { k: "feather", label: mmFeather ? "Soft edge (mm)" : "Soft edge", kind: "range", min: 0, max: mmFeather ? 10 : 0.5, step: 0.01, tip: "Fades the pattern's edges instead of a hard line." }, actions.changed)
        : null,
      control(L, { k: "strength", label: "Strength", kind: "range", min: 0, max: 1, step: 0.01, tip: "Scales this layer's fuzz amount." }, actions.changed),
      control(L, { k: "invert", label: "Invert", kind: "check", tip: "Fuzz where the pattern isn't, and leave its area smooth." }, actions.changed),
    ]);
    if (extra) { extra.dataset.id = L.id; extra.open = moreOpen; }

    const draw = L.type === "spiral"
      ? h("button", { class: "draw", title: "Drag across the part in the preview along the line one stripe should follow. Sets pitch, twist and rotation.", onclick: () => actions.drawSpiral(L) }, "✎ Draw on model")
      : null;
    const body = h("div", { class: "card-body" }, draw, PARAMS[L.type].map((p) => control(L.params, p, changedP)), extra);
    return h("div", { class: `card${L.enabled ? "" : " off"}` }, head, L.enabled ? body : null);
  };

  const rebuildFuzz = () => {
    const f = state.settings.fuzz;
    const c = state.settings.center;
    const wasOpen = fuzzHost.querySelector("details")?.open ?? false;
    const onFuzz = (rebuild) => {
      if (rebuild) rebuildFuzz();
      if (swatchRow) swatch.draw(f);
      actions.changed();
    };
    const extra = more([
      ...FUZZ_MORE.filter((s) => !s.when || s.when(f)).map((s) => control(f, s, onFuzz)),
      control(c, { k: "mode", label: "Pattern center", kind: "select", options: [["auto", "middle of each object"], ["custom", "custom point"]], tip: "The point spirals, stripes and checkers wrap around." }, onFuzz),
      c.mode === "custom"
        ? h("div", { class: "row2" },
            control(c, { k: "x", label: "X (mm)", kind: "number", step: 0.1 }, actions.changed),
            control(c, { k: "y", label: "Y (mm)", kind: "number", step: 0.1 }, actions.changed))
        : null,
      h("button", { title: "Click a point on the bed in the preview to wrap patterns around it", onclick: actions.pickCenter }, "Pick center on bed"),
    ]);
    if (extra) extra.open = wasOpen;
    fuzzHost.replaceChildren(...FUZZ.map((s) => control(f, s, onFuzz)), extra);
  };

  const presetSel = h("select", { title: "Replace the pattern with a ready-made one" },
    h("option", { value: "" }, "Preset…"),
    Object.keys(PRESETS).map((k) => h("option", { value: k }, k)));
  presetSel.addEventListener("change", () => {
    if (!presetSel.value) return;
    state.settings.stack = PRESETS[presetSel.value]();
    presetSel.value = "";
    structural();
  });

  // "+" opens a short menu of layer types; picking one appends it to the stack.
  const addMenu = h("div", { class: "menu", role: "menu", hidden: true },
    Object.entries(TYPE_LABEL).map(([k, t]) =>
      h("button", { role: "menuitem", onclick: () => {
        closeAdd();
        state.settings.stack.push(makeLayer(k));
        structural();
      } }, h("strong", {}, t), h("span", {}, TYPE_TIP[k]))));
  const addBtn = h("button", { class: "icon add", title: "Add a pattern layer", "aria-haspopup": "menu", "aria-expanded": "false",
    onclick: (e) => { e.stopPropagation(); addMenu.hidden ? openAdd() : closeAdd(); } }, "+");
  const openAdd = () => {
    addMenu.hidden = false;
    addBtn.setAttribute("aria-expanded", "true");
    addMenu.querySelector("button")?.focus();
  };
  const closeAdd = () => { addMenu.hidden = true; addBtn.setAttribute("aria-expanded", "false"); };
  addEventListener("click", (e) => { if (!addMenu.hidden && !addMenu.contains(e.target)) closeAdd(); });
  addMenu.addEventListener("keydown", (e) => {
    const items = [...addMenu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { closeAdd(); addBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });

  root.replaceChildren(
    h("section", {}, h("h2", { title: "What the fuzz looks like. The pattern below decides where it goes." }, "Fuzzy skin"), fuzzHost),
    h("section", {},
      h("div", { class: "sec-head" },
        h("h2", { title: "Where on the outer wall the fuzz goes. Layers stack top to bottom." }, "Pattern"),
        h("span", { class: "grow" }),
        addBtn,
        h("button", { class: "icon", title: "Load a saved pattern (.json)", onclick: actions.loadPattern }, "⤒"),
        h("button", { class: "icon", title: "Save this pattern as a .json file", onclick: actions.savePattern }, "⤓"),
        addMenu),
      h("div", { class: "row1" }, presetSel),
      stackHost),
  );

  const refresh = () => { rebuildStack(); rebuildFuzz(); };
  refresh();
  return { refresh };
}
