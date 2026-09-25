/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Theme accent, driven by CSS variables set in src/themes.js
        accent: {
          ...Object.fromEntries([200, 300, 400, 500, 600, 800, 950]
            .map(shade => [shade, `rgb(var(--accent-${shade}) / <alpha-value>)`])),
          on: 'rgb(var(--accent-on) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
