// Accent colour themes. Each shade is an "R G B" triplet, applied as CSS variables
// (--accent-200 … --accent-950) that Tailwind's `accent-*` colours read (see tailwind.config.js).
// `on` is the text colour used on solid accent buttons (dark for the bright themes).

const WHITE = '255 255 255';
const DARK = '17 24 39';

export const THEMES = {
  blue: {
    label: 'Blue', on: WHITE,
    200: '186 230 253', 300: '125 211 252', 400: '56 189 248', 500: '14 165 233',
    600: '2 132 199', 800: '7 89 133', 950: '8 47 73',
  },
  orange: {
    label: 'Orange', on: WHITE,
    200: '254 215 170', 300: '253 186 116', 400: '251 146 60', 500: '249 115 22',
    600: '234 88 12', 800: '154 52 18', 950: '67 20 7',
  },
  purple: {
    label: 'Purple', on: WHITE,
    200: '199 210 254', 300: '165 180 252', 400: '129 140 248', 500: '99 102 241',
    600: '79 70 229', 800: '55 48 163', 950: '30 27 75',
  },
  pink: {
    label: 'Pink', on: WHITE,
    200: '251 207 232', 300: '249 168 212', 400: '244 114 182', 500: '236 72 153',
    600: '219 39 119', 800: '157 23 77', 950: '80 7 36',
  },
  green: {
    label: 'Green', on: DARK,
    200: '217 249 157', 300: '190 242 100', 400: '163 230 53', 500: '132 204 22',
    600: '132 204 22', 800: '54 83 20', 950: '26 46 5',
  },
  yellow: {
    label: 'Yellow', on: DARK,
    200: '254 240 138', 300: '253 224 71', 400: '250 204 21', 500: '234 179 8',
    600: '234 179 8', 800: '133 77 14', 950: '66 32 6',
  },
};

export const DEFAULT_THEME = 'blue';

export const ACCENT_SHADES = [200, 300, 400, 500, 600, 800, 950];

// Set the CSS variables for a theme on the document root
export function applyTheme(name) {
  const theme = THEMES[name] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement.style;
  for (const shade of ACCENT_SHADES) root.setProperty(`--accent-${shade}`, theme[shade]);
  root.setProperty('--accent-on', theme.on);
}
