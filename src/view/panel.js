// Sidebar controls. Inputs edit the settings object in place and call `changed()`;
// only structural edits (add, remove, reorder a layer) rebuild the DOM, so a slider
// keeps focus while it is being dragged.

import { makeLayer, PRESETS } from "../core/patterns.js";

/** Control specs per layer type. `kind` is range | number | select | check. */
const PARAMS = {
  constant: [],
  zrange: [
    { k: "unit", label: "Measure in", kind: "select", options: [["layer", "layers"], ["mm", "mm"]] },
    { k: "from", label: "From", kind: "number", step: 1 },
    { k: "to", label: "To", kind: "number", step: 1 },
  ],
  spiral: [
    { k: "starts", label: "Starts", kind: "range", min: 1, max: 16, step: 1 },
    { k: "pitch", label: "Pitch (mm per turn)", kind: "range", min: 2, max: 200, step: 1 },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01 },
    { k: "hand", label: "Twist", kind: "select", options: [["right", "right-hand"], ["left", "left-hand"]] },
    { k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01 },
  ],
  stripes: [
    { k: "count", label: "Count", kind: "range", min: 1, max: 64, step: 1 },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01 },
    { k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01 },
  ],
  bands: [
    { k: "period", label: "Period (mm)", kind: "range", min: 0.4, max: 40, step: 0.2 },
    { k: "duty", label: "Width", kind: "range", min: 0.05, max: 0.95, step: 0.01 },
    { k: "phase", label: "Shift", kind: "range", min: 0, max: 1, step: 0.01 },
  ],
  checker: [
    { k: "count", label: "Columns", kind: "range", min: 2, max: 48, step: 2 },
    { k: "period", label: "Row height (mm)", kind: "range", min: 0.4, max: 40, step: 0.2 },
    { k: "phase", label: "Rotate", kind: "range", min: 0, max: 1, step: 0.01 },
  ],
  gradient: [
    { k: "from", label: "Start (% height)", kind: "range", min: 0, max: 100, step: 1 },
    { k: "to", label: "End (% height)", kind: "range", min: 0, max: 100, step: 1 },
    { k: "startAmp", label: "Amount at start", kind: "range", min: 0, max: 1, step: 0.01 },
    { k: "endAmp", label: "Amount at end", kind: "range", min: 0, max: 1, step: 0.01 },
    { k: "ease", label: "Ease", kind: "check" },
  ],
};

const TYPE_LABEL = {
  constant: "Everywhere", zrange: "Layer range", spiral: "Spiral", stripes: "Vertical stripes",
  bands: "Horizontal bands", checker: "Checker", gradient: "Height gradient",
};

const FUZZ = [
  { k: "walls", label: "Walls", kind: "select", options: [["all", "outside and holes"], ["contour", "outside only (skip holes)"]] },
  { k: "thickness", label: "Thickness (mm)", kind: "range", min: 0.05, max: 1.5, step: 0.01 },
  { k: "pointDist", label: "Point distance (mm)", kind: "range", min: 0.1, max: 3, step: 0.05 },
  { k: "noise", label: "Noise", kind: "select", options: [["classic", "classic (random)"], ["perlin", "Perlin (smooth)"]] },
  { k: "noiseScale", label: "Perlin scale (mm)", kind: "range", min: 0.2, max: 10, step: 0.1, when: (f) => f.noise === "perlin" },
  { k: "mode", label: "Direction", kind: "select", options: [["both", "in and out"], ["outward", "outward only"]] },
  { k: "seed", label: "Seed", kind: "number", step: 1 },
  { k: "maxPtsPerMm", label: "Max points per mm", kind: "range", min: 1, max: 20, step: 0.5 },
  { k: "skipFirstLayer", label: "Leave first layer smooth", kind: "check" },
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
  const id = `c${Math.random().toString(36).slice(2, 8)}`;
  const v = obj[spec.k];
  if (spec.kind === "check") {
    return h("label", { class: "row check" },
      h("input", { type: "checkbox", checked: !!v, onchange: (e) => { obj[spec.k] = e.target.checked; changed(); } }),
      spec.label);
  }
  if (spec.kind === "select") {
    const sel = h("select", { id, onchange: (e) => { obj[spec.k] = e.target.value; changed(true); } },
      spec.options.map(([val, text]) => h("option", { value: val, selected: val === v }, text)));
    return h("div", { class: "row" }, h("label", { for: id }, spec.label), sel);
  }
  if (spec.kind === "number") {
    return h("div", { class: "row" }, h("label", { for: id }, spec.label),
      h("input", { id, type: "number", step: spec.step ?? "any", value: v,
        onchange: (e) => { const n = parseFloat(e.target.value); if (!Number.isNaN(n)) { obj[spec.k] = n; changed(); } } }));
  }
  const out = h("output", {}, fmt(v));
  return h("div", { class: "row" }, h("label", { for: id }, spec.label, out),
    h("input", { id, type: "range", min: spec.min, max: spec.max, step: spec.step, value: v,
      oninput: (e) => { obj[spec.k] = parseFloat(e.target.value); out.textContent = fmt(obj[spec.k]); changed(); } }));
}

const fmt = (v) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v));

/**
 * @param {HTMLElement} root
 * @param {{settings: any}} state
 * @param {{changed: () => void, pickCenter: () => void}} actions
 */
export function mountPanel(root, state, actions) {
  const stackHost = h("div", { class: "stack" });
  const fuzzHost = h("div");
  const centerHost = h("div");

  const rebuildStack = () => {
    const stack = state.settings.stack;
    stackHost.replaceChildren(...stack.map((L, i) => layerCard(L, i, stack.length)));
    if (!stack.length) stackHost.append(h("p", { class: "hint" }, "No pattern layers, so nothing is fuzzed. Add a layer or pick a preset."));
  };

  const structural = () => { rebuildStack(); actions.changed(); };

  const layerCard = (L, i, n) => {
    const stack = state.settings.stack;
    const move = (d) => { const j = i + d; [stack[i], stack[j]] = [stack[j], stack[i]]; structural(); };
    const head = h("div", { class: "card-head" },
      h("input", { type: "checkbox", title: "Enabled", checked: L.enabled, onchange: (e) => { L.enabled = e.target.checked; actions.changed(); } }),
      h("strong", {}, TYPE_LABEL[L.type]),
      i > 0
        ? h("select", { title: "How this layer combines with the ones above", onchange: (e) => { L.blend = e.target.value; actions.changed(); } },
            [["max", "union"], ["multiply", "intersect"], ["subtract", "subtract"], ["add", "add"], ["min", "min"]]
              .map(([v, t]) => h("option", { value: v, selected: L.blend === v }, t)))
        : null,
      h("span", { class: "grow" }),
      h("button", { title: "Move up", disabled: i === 0, onclick: () => move(-1) }, "↑"),
      h("button", { title: "Move down", disabled: i === n - 1, onclick: () => move(1) }, "↓"),
      h("button", { title: "Remove", onclick: () => { stack.splice(i, 1); structural(); } }, "×"));
    const body = h("div", { class: "card-body" },
      PARAMS[L.type].map((p) => control(L.params, p, (rebuild) => (rebuild ? structural() : actions.changed()))),
      L.type !== "gradient" && L.type !== "constant" && !(L.type === "zrange" && L.params.unit === "layer")
        ? control(L, { k: "feather", label: L.type === "zrange" ? "Soft edge (mm)" : "Soft edge", kind: "range", min: 0, max: L.type === "zrange" ? 10 : 0.5, step: 0.01 }, actions.changed)
        : null,
      control(L, { k: "strength", label: "Strength", kind: "range", min: 0, max: 1, step: 0.01 }, actions.changed),
      control(L, { k: "invert", label: "Invert", kind: "check" }, actions.changed));
    return h("div", { class: `card${L.enabled ? "" : " off"}` }, head, body);
  };

  const rebuildFuzz = () => {
    const f = state.settings.fuzz;
    fuzzHost.replaceChildren(...FUZZ.filter((s) => !s.when || s.when(f)).map((s) =>
      control(f, s, (rebuild) => { if (rebuild) rebuildFuzz(); actions.changed(); })));
  };

  const rebuildCenter = () => {
    const c = state.settings.center;
    centerHost.replaceChildren(
      control(c, { k: "mode", label: "Pattern center", kind: "select", options: [["auto", "each object's middle"], ["custom", "custom point"]] },
        () => { rebuildCenter(); actions.changed(); }),
      c.mode === "custom"
        ? h("div", {},
            control(c, { k: "x", label: "X (mm)", kind: "number", step: 0.1 }, actions.changed),
            control(c, { k: "y", label: "Y (mm)", kind: "number", step: 0.1 }, actions.changed))
        : null,
      h("button", { onclick: actions.pickCenter }, "Pick center on the bed"));
  };

  const presetSel = h("select", {},
    h("option", { value: "" }, "Load a preset…"),
    Object.keys(PRESETS).map((k) => h("option", { value: k }, k)));
  presetSel.addEventListener("change", () => {
    if (!presetSel.value) return;
    state.settings.stack = PRESETS[presetSel.value]();
    presetSel.value = "";
    structural();
  });

  const addSel = h("select", {},
    h("option", { value: "" }, "Add a layer…"),
    Object.entries(TYPE_LABEL).map(([k, t]) => h("option", { value: k }, t)));
  addSel.addEventListener("change", () => {
    if (!addSel.value) return;
    state.settings.stack.push(makeLayer(addSel.value));
    addSel.value = "";
    structural();
  });

  root.replaceChildren(
    h("section", {}, h("h2", {}, "Pattern"), h("div", { class: "row2" }, presetSel, addSel), stackHost),
    h("section", {}, h("h2", {}, "Fuzzy skin"), fuzzHost),
    h("section", {}, h("h2", {}, "Center"), centerHost),
  );

  const refresh = () => { rebuildStack(); rebuildFuzz(); rebuildCenter(); };
  refresh();
  return { refresh };
}
