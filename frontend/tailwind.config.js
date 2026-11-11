/**
 * Tailwind is here for the shared company theme in src/theme/ (its button, card
 * and tag primitives are written in Tailwind classes). Page-specific styles live
 * in plain CSS files that read the same --rhodex-* theme variables.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
