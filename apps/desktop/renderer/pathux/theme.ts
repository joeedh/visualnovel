import { CSSFont, setTheme } from 'pathux';
import { TOKENS, alpha } from './tokens.js';

/**
 * `tokens.css` re-expressed as a path.ux theme. path.ux applies `DefaultTheme` at module
 * load and `setTheme` **merges** two levels deep over it, so this file is an override tree,
 * not a fork of the 524-line default — but that same shallowness means a sub-record
 * (`button.disabled`, `menu.MenuSeparator`) is replaced wholesale rather than merged into,
 * so a key it drops falls all the way back to the style class's own top level rather than to
 * the default's sub-record. Style classes absent here keep path.ux's own values.
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

/** Every widget's resting state is a raised surface; the three below vary from it. */
const surface = {
  'background-color': TOKENS.inkRaised,
  'border-color': TOKENS.inkLine,
  'border-radius': TOKENS.radiusChrome,
  'border-style': 'solid',
  'border-width': 1,
};

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
    'box-shadow': '0 18px 50px -22px rgba(0, 0, 0, 0.8)',
  },

  notification: {
    DefaultText: small,
    'background-color': alpha(TOKENS.inkRaised, 0),
    'border-color': TOKENS.inkLine,
    // The one place both accents appear at once: the bar is machine progress, the fill is
    // the run itself — warm because a run is the author's act.
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
