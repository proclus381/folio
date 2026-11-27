// Folio's line icons (20 × 20, drawn in currentColor, like the reader bar's tools). Controls show these instead of
// words; each keeps its name for VoiceOver (aria-label) and, with a mouse, a tooltip (title). See docs/UI-TEXT.md.

const svg = (d, w = 1.2) =>
  `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICON = {
  // the library
  plus: svg('<path d="M10 4v12M4 10h12"/>'),
  file: svg('<path d="M5 2.5h6.5l3.5 3.5v11.5H5z"/><path d="M11.5 2.5V6H15"/><path d="M7.5 11h5M10 8.5v5"/>'),
  folder: svg('<path d="M2.5 5.5V15.5h15V7.5H9.5L8 5.5z"/><path d="M7.5 11.5h5M10 9v5"/>'),
  stack: svg('<path d="M3.5 4h3v12h-3zM7.5 4h2.5v12H7.5z"/><path d="M11.2 4.6l2.6-.8 3.3 11.6-2.6.8z"/>'),
  sort: svg('<path d="M4 5h8M4 10h6M4 15h4"/><path d="M15 4v12M12.5 13.5L15 16l2.5-2.5"/>'),
  list: svg('<path d="M7 5h10M7 10h10M7 15h10"/><circle cx="3.8" cy="5" r=".6"/><circle cx="3.8" cy="10" r=".6"/><circle cx="3.8" cy="15" r=".6"/>'),
  info: svg('<circle cx="10" cy="10" r="7"/><path d="M10 9v5M10 6.3v.2"/>'),
  help: svg('<circle cx="10" cy="10" r="7"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3 2.2c-.6.2-.8.6-.8 1.2v.6M10 14.2v.2"/>'),
  close: svg('<path d="M5 5l10 10M15 5L5 15"/>'),
  yes: svg('<path d="M4 10.5l4 4 8-9"/>'),
  no: svg('<path d="M5 5l10 10M15 5L5 15"/>'),
  bin: svg('<path d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5"/>'),
  ticks: svg('<path d="M3 5.5l1.5 1.5L7 4.5M3 10.5l1.5 1.5L7 9.5M3 15.5l1.5 1.5L7 14.5M10 6h7M10 11h7M10 16h7"/>'),
  all: svg('<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M6.5 10l2.5 2.5 4.5-5"/>'),
  // a book
  play: svg('<path d="M6.5 4.5v11l9-5.5z"/>'),
  ribbon: svg('<path d="M6 3h8v14l-4-3.5L6 17z"/>'),
  book: svg('<path d="M3 4.5c2.5-.8 5-.6 7 .9 2-1.5 4.5-1.7 7-.9v11c-2.5-.8-5-.6-7 .9-2-1.5-4.5-1.7-7-.9z"/><path d="M10 5.4v11"/>'),
  contents: svg('<path d="M4 4.5h12M6 8.5h10M6 12.5h10M4 16.5h12"/>'),
  flag: svg('<path d="M6 17V3.5"/><path d="M6 4h8.5l-2 3 2 3H6"/>'),
  ink: svg('<path d="M4 16.5l1-4L13.8 3.7l3 3L8 15.5z"/><path d="M12 5.5l3 3"/>'),
  export: svg('<path d="M10 3v10M6.5 6.5L10 3l3.5 3.5"/><path d="M4.5 11v5.5h11V11"/>'),
  edit: svg('<path d="M4 16l1-3.8L13.2 4l2.8 2.8L7.8 15z"/><path d="M3.5 16.5h13"/>'),
  shelf: svg('<path d="M2.5 15.5h15"/><path d="M4 15.5V6h2.5v9.5M7.5 15.5V4.5H10v11M11.6 6.4l2.4-.7 2.6 9.1-2.4.7"/>'),
  paper: svg('<path d="M5 3h7.5L15 5.5V17H5z"/><path d="M7.5 8h5M7.5 10.5h5M7.5 13h3.5"/>'),
  binding: svg('<path d="M5 3h9.5v14H5a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 5 3z"/><path d="M6.5 3v14"/>'),
  wear: svg('<path d="M10 17c-3.5 0-5-2.4-5-5.2V7.4a1.2 1.2 0 0 1 2.4 0v3"/><path d="M7.4 9V4.6a1.2 1.2 0 0 1 2.4 0V9M9.8 8.6V4a1.2 1.2 0 0 1 2.4 0v5M12.2 9V5.4a1.2 1.2 0 0 1 2.4 0V12c0 2.8-1.6 5-4.6 5"/>'),
  storage: svg('<ellipse cx="10" cy="5" rx="6" ry="2.2"/><path d="M4 5v10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2V5M4 10c0 1.2 2.7 2.2 6 2.2s6-1 6-2.2"/>'),
  keys: svg('<rect x="2.5" y="5.5" width="15" height="9" rx="1.2"/><path d="M5.5 8.5h.1M8.5 8.5h.1M11.5 8.5h.1M14.5 8.5h.1M7 11.5h6"/>'),
  // go to a page
  hash: svg('<path d="M8 3.5l-1.5 13M13.5 3.5l-1.5 13M4 7.5h12.5M3.5 12.5H16"/>'),
  enter: svg('<path d="M15.5 4v6.5H5"/><path d="M8 7.5l-3 3 3 3"/>'),
  // arranging the shelf
  group: svg('<rect x="3" y="3.5" width="6" height="5.5" rx=".8"/><rect x="11" y="3.5" width="6" height="5.5" rx=".8"/><rect x="3" y="11" width="6" height="5.5" rx=".8"/><rect x="11" y="11" width="6" height="5.5" rx=".8"/>'),
  reverse: svg('<path d="M6.5 3.5v13M4 6l2.5-2.5L9 6M13.5 16.5v-13M11 14l2.5 2.5L16 14"/>'),
  plank: svg('<path d="M2.5 12h15v2.5h-15z"/><path d="M5 12V7.5M8 12V6M11 12V8"/>'),
  // reading light
  light: svg('<path d="M10 3c-2.8 2.4-4 4.5-4 6.6a4 4 0 0 0 8 0C14 7.5 12.8 5.4 10 3z"/><path d="M10 10.5c-.9.8-1.3 1.5-1.3 2.2a1.3 1.3 0 0 0 2.6 0c0-.7-.4-1.4-1.3-2.2z"/>'),
  warm: svg('<path d="M8.5 11.5V4.5a1.5 1.5 0 0 1 3 0v7a3 3 0 1 1-3 0z"/><path d="M10 12.5v-5"/>'),
  sun: svg('<circle cx="10" cy="10" r="3.2"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>'),
  lively: svg('<path d="M2.5 10c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0"/>'),
  clock: svg('<circle cx="10" cy="10" r="7"/><path d="M10 5.5V10l3 2"/>'),
  side: svg('<path d="M3 10h14M6 7l-3 3 3 3M14 7l3 3-3 3"/>'),
  left: svg('<path d="M12.5 4.5L7 10l5.5 5.5"/>'),
  right: svg('<path d="M7.5 4.5L13 10l-5.5 5.5"/>'),
  timer: svg('<circle cx="10" cy="11" r="6"/><path d="M10 11V7.5M8 2.5h4"/>'),
  snuff: svg('<path d="M3 6.5h7l2.5 3.5"/><path d="M12.5 10a2.5 2.5 0 1 0 2.5-2.5"/><path d="M6 15.5c1-1.2 1-2.3 0-3.5"/>'),
  power: svg('<path d="M10 3v7"/><path d="M6.2 5.8a6 6 0 1 0 7.6 0"/>'),
  // the ink tools
  colour: svg('<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2.5" fill="currentColor"/>'),
  lead: svg('<path d="M4 16l1-3.8L13.2 4l2.8 2.8L7.8 15z"/><path d="M4 16l1.6-.4L4.4 14.4z" fill="currentColor"/>'),
  size: svg('<path d="M3 5h14" stroke-width="1"/><path d="M3 10h14" stroke-width="2"/><path d="M3 15.5h14" stroke-width="3"/>'),
  pressure: svg('<path d="M10 3v8M7 8l3 3 3-3"/><path d="M3 15c3.5-1.5 10.5-1.5 14 0"/>'),
  opacity: svg('<path d="M10 3c3 3.6 4.5 6.1 4.5 8.3a4.5 4.5 0 0 1-9 0C5.5 9.1 7 6.6 10 3z"/><path d="M5.6 11.5h8.8" stroke-dasharray="1.2 1.6"/>'),
  steady: svg('<path d="M2.5 13c2-4 3.5-4 5 0s3 4 5 0"/><path d="M12.5 9.5h5" />'),
  chisel: svg('<path d="M7 3.5h6v8l-3 5-3-5z"/><path d="M7 11.5h6"/>'),
  round: svg('<path d="M7 3.5h6v8a3 3 0 0 1-6 0z"/>'),
  reset: svg('<path d="M4.5 9.5a5.5 5.5 0 1 1 1.6 4.1"/><path d="M4.5 4.5v5h5"/>'),
};

/** Put an icon on a control in place of its words; its name goes to VoiceOver and the mouse's tooltip. */
export function iconize(el, name, label, { tip = true, keep = '' } = {}) {
  if (!el) return;
  el.innerHTML = ICON[name] + keep;
  el.setAttribute('aria-label', label);
  if (tip) el.title = label;
  el.classList.add('iconized');
}

/** A label: just its icon, named for VoiceOver. */
export function iconLabel(name, label) {
  return `<span class="ilabel" role="img" aria-label="${label}" title="${label}">${ICON[name]}</span>`;
}
