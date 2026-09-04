/**
 * The design contract in TypeScript, holding the same palette as `styles/tokens.css`. `--sodium`
 * (warm) is the authored/human side and `--signal` (cool) is the machine/pipeline side, and the
 * rule "no new accent hues" holds here too. The two files must move together until the React
 * shell and its stylesheets are deleted, after which this file alone carries the contract.
 */
export const TOKENS = {
  ink: '#0e1116',
  inkRaised: '#161a22',
  inkSunken: '#0a0d12',
  inkLine: '#232a35',
  inkLineSoft: '#1b212b',

  paper: '#e8e6df',
  mist: '#8a93a3',
  mistDim: '#5a6271',

  sodium: '#f4a24c',
  signal: '#45c8d6',
  signalDeep: '#2e8c99',
  jade: '#5fb58c',
  vermilion: '#e5534b',

  radiusChrome: 4,
  radiusSoft: 10,

  sans: 'Archivo, system-ui, sans-serif',
  disp: '"Archivo Expanded", Archivo, sans-serif',
  prose: 'Newsreader, Georgia, serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

/** `rgba()` over a `#rrggbb` token, for the places a theme key wants transparency. */
export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
