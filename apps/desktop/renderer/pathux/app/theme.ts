import { CSSFont, setTheme, BoxBorder } from 'pathux';
import { TOKENS, alpha } from './tokens.js';

/**
 * The path.ux theme for this app, built from the design tokens in `tokens.css`.
 * `setTheme` merges only two levels deep over the `DefaultTheme` applied at module load,
 * so a sub-record here (`button.disabled`, `menu.MenuSeparator`) replaces the default's
 * wholesale: a missing key resolves against the style class's top level, not the default
 * sub-record. Style classes absent here keep path.ux's own values.
 */

function font(
  size: number,
  color: string,
  weight = 'normal',
  family: string = TOKENS.sans,
): CSSFont {
  return new CSSFont({ font: family, weight, variant: 'normal', style: 'normal', size, color });
}

const body = font(14, TOKENS.paper);
const small = font(12, TOKENS.paper);
const dim = font(12, TOKENS.mist);

/** The resting state shared by widgets is a raised surface; the states below vary from it. */
const surface = {
  'background-color': TOKENS.inkRaised,
  border: BoxBorder.withVars({
    color: TOKENS.inkLine,
    radius: TOKENS.radiusChrome,
    style: 'solid',
    width: 1,
  }),
};

/**
 * Lifts a floating surface off whatever it covers. Shared with `menu`.
 *
 * Two layers and no negative spread, because the chrome underneath is already near-black: a
 * single wide shadow pulled in by its spread darkens almost nothing it is laid over. The tight
 * layer draws the edge and the wide one carries the depth.
 */
const POPUP_SHADOW = '0 2px 6px rgba(0, 0, 0, 0.7), 0 12px 32px rgba(0, 0, 0, 0.55)';

const VnTheme = {
  base: {
    AreaHeaderBG: TOKENS.inkSunken,
    BoxDepressed: alpha(TOKENS.signalDeep, 0.55),
    BoxHighlight: alpha(TOKENS.signal, 0.3),
    DefaultText: body,
    LabelText: body,
    TitleText: font(12, TOKENS.mist),
    'background-color': TOKENS.ink,
    'border-color': TOKENS.inkLine,
    'border-radius': TOKENS.radiusChrome,
  },

  propLabels: {
    font: body,
  },

  button: {
    ...surface,
    DefaultText: small,
    disabled: {
      ...surface,
      DefaultText: font(12, TOKENS.mistDim),
      'background-color': TOKENS.inkSunken,
      'border-color': TOKENS.inkLineSoft,
    },
    highlight: { ...surface, DefaultText: small, 'border-color': TOKENS.signal },
    'highlight-pressed': {
      ...surface,
      DefaultText: font(12, TOKENS.ink),
      'background-color': TOKENS.signal,
      'border-color': TOKENS.signal,
    },
    pressed: {
      ...surface,
      DefaultText: font(12, TOKENS.ink),
      'background-color': TOKENS.signalDeep,
      'border-color': TOKENS.signalDeep,
    },
  },

  assetgallery: {
    'background-color': TOKENS.inkSunken,
    rowHeight: 64,
  },

  assetthumb: {
    'background-color': TOKENS.inkRaised,
    highlight: alpha(TOKENS.signal, 0.25),
    active: alpha(TOKENS.signalDeep, 0.55),
    focusRing: TOKENS.signal,
    border: { color: TOKENS.inkLine, width: 1 },
    boxPadding: 6,
    rowFont: small,
  },

  checkbox: { 'background-color': TOKENS.inkRaised },

  curvewidget: { CanvasBG: TOKENS.inkSunken },

  dropbox: { dropTextBG: TOKENS.inkRaised },

  iconbutton: {
    'background-color': alpha(TOKENS.inkRaised, 0),
    'border-color': TOKENS.inkLine,
    depressed: {
      'background-color': alpha(TOKENS.signalDeep, 0.55),
      'border-color': TOKENS.signal,
    },
    highlight: { 'background-color': alpha(TOKENS.signal, 0.25), 'border-color': TOKENS.signal },
  },

  iconcheck: {
    'background-color': alpha(TOKENS.inkRaised, 0),
    'border-color': TOKENS.inkLine,
    depressed: {
      'background-color': alpha(TOKENS.signalDeep, 0.55),
      'border-color': TOKENS.signal,
    },
    highlight: { 'background-color': alpha(TOKENS.signal, 0.25), 'border-color': TOKENS.signal },
  },

  label: { LabelText: body },

  listbox: {
    ListActive: alpha(TOKENS.signalDeep, 0.5),
    ListActiveHighlight: alpha(TOKENS.signal, 0.5),
    ListHighlight: alpha(TOKENS.signal, 0.2),
  },

  menu: {
    MenuBG: TOKENS.inkRaised,
    MenuBorder: `1px solid ${TOKENS.inkLine}`,
    MenuHighlight: alpha(TOKENS.signal, 0.28),
    MenuSeparator: {
      width: '100%',
      height: 1,
      padding: 0,
      margin: 0,
      border: 'none',
      'background-color': TOKENS.inkLine,
    },
    MenuText: small,
    'border-color': TOKENS.inkLine,
    'box-shadow': POPUP_SHADOW,
  },

  // A group instance carries the warm accent, because a group is the author's own structure;
  // the boundary nodes inside a definition are chrome, and read as such.
  nodeframe: {
    DefaultText: small,
    HeaderBG: alpha(TOKENS.inkSunken, 0.95),
    GroupAccent: TOKENS.sodium,
    GroupHeaderBG: alpha(TOKENS.sodium, 0.22),
    ProxyHeaderBG: alpha(TOKENS.mist, 0.14),
    SelectOutline: TOKENS.signal,
    SocketText: font(11, TOKENS.mist),
    SocketHitExpand: 5,
    SocketHighlightColor: alpha(TOKENS.signal, 0.25),
    SocketErrorColor: alpha(TOKENS.vermilion, 0.25),
    'background-color': alpha(TOKENS.inkRaised, 0.95),
    'border-color': TOKENS.inkLine,
    'border-radius': TOKENS.radiusChrome,
  },

  // The pan area behind the frames, sunken because the frames sit above it. The breadcrumb strip
  // above it colours the level: a definition in the warm accent, since editing one is the
  // author's act on every instance, and an instance in the dim ink of something read more than
  // written.
  nodegraphview: {
    BoxSelectBG: alpha(TOKENS.signal, 0.12),
    BoxSelectBorder: TOKENS.signal,
    CrumbBG: TOKENS.inkRaised,
    CrumbFont: font(11, TOKENS.mist),
    CrumbActiveFont: font(11, TOKENS.paper),
    ErrorColor: TOKENS.vermilion,
    LevelDefinitionColor: TOKENS.sodium,
    LevelInstanceColor: TOKENS.mistDim,
    'background-color': TOKENS.inkSunken,
  },

  nodelinkcanvas: {
    LinkColor: TOKENS.mistDim,
    LinkSelectColor: TOKENS.signal,
  },

  notification: {
    DefaultText: small,
    'background-color': alpha(TOKENS.inkRaised, 0),
    'border-color': TOKENS.inkLine,
    // The one place both accents appear at once. The track carries the machine accent and the
    // fill carries the warm one, because a run is the author's act.
    ProgressBar: TOKENS.sodium,
    ProgressBarBG: TOKENS.signalDeep,
  },

  numslider: {
    'arrow-color': TOKENS.mist,
    'background-color': TOKENS.inkRaised,
    'border-color': TOKENS.inkLine,
    highlight: {
      DefaultText: small,
      'background-color': alpha(TOKENS.signal, 0.25),
      'border-color': TOKENS.signal,
      'border-style': 'solid',
      'border-width': 1,
    },
    pressed: {
      DefaultText: font(12, TOKENS.ink),
      'arrow-color': TOKENS.ink,
      'background-color': TOKENS.signal,
      'border-color': TOKENS.signal,
      'border-style': 'solid',
      'border-width': 1,
    },
  },

  numslider_simple: { 'background-color': TOKENS.inkRaised },
  numslider_textbox: { 'background-color': TOKENS.inkRaised },

  panel: {
    TitleBackground: TOKENS.inkSunken,
    TitleBorder: TOKENS.inkLine,
    TitleText: font(14, TOKENS.paper),
    'background-color': alpha(TOKENS.inkRaised, 0.76),
    'border-color': TOKENS.inkLine,
    'border-style': 'solid',
  },

  // Every container `Screen.popup` floats: menus, dropdowns, the color picker, the asset picker.
  // The soft radius rather than the chrome one, because these sit above the chrome.
  popup: {
    'background-color': TOKENS.inkRaised,
    border: BoxBorder.withVars({
      color: TOKENS.inkLine,
      radius: TOKENS.radiusSoft,
      style: 'solid',
      width: 1,
    }),
    'box-shadow': POPUP_SHADOW,
  },

  richtext: {
    DefaultText: font(16, TOKENS.paper, 'normal', TOKENS.prose),
    'background-color': TOKENS.ink,
  },

  screenborder: {
    'border-inner': TOKENS.inkLine,
    'border-outer': TOKENS.inkSunken,
  },

  sidebar: { 'background-color': alpha(TOKENS.inkSunken, 0.7) },

  strip: {
    'background-color': alpha(TOKENS.inkRaised, 0.6),
    'border-color': TOKENS.inkLineSoft,
    'border-radius': TOKENS.radiusChrome,
  },

  tabs: {
    TabActive: TOKENS.inkRaised,
    TabHighlight: alpha(TOKENS.signal, 0.2),
    TabInactive: TOKENS.inkSunken,
    TabStrokeStyle1: TOKENS.inkLine,
    TabStrokeStyle2: TOKENS.inkLine,
    TabText: font(14, TOKENS.paper, '600', TOKENS.disp),
    'background-color': TOKENS.ink,
  },

  textbox: {
    DefaultText: font(14, TOKENS.paper, 'normal', TOKENS.mono),
    'background-color': TOKENS.inkSunken,
    'border-color': TOKENS.inkLine,
  },

  tooltip: {
    ToolTipText: dim,
    'background-color': TOKENS.inkSunken,
    'border-color': TOKENS.inkLine,
  },
};

/** Apply the shell's theme over path.ux's default. Call once, before the screen is built. */
export function installTheme(): void {
  setTheme(VnTheme);
}
