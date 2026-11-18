import { defineConfig, type Plugin } from 'vite';
const proxy = {
  '/api': 'http://127.0.0.1:3000',
  '/assets': 'http://127.0.0.1:3000',
};
function removeCrossoriginFromCss(): Plugin {
  return {
    name: 'remove-crossorigin-css',
    transformIndexHtml(html) {
      return html.replace(
        /<link([^>]*)\scrossorigin([^>]*)>/g,
        (match, before, after) => `<link${before}${after}>`,
      );
    },
  };
}
export default defineConfig({
  root: 'frontend',
  base: '/react/',
  publicDir: 'static',
  build: { outDir: '../public/react', emptyOutDir: true },
  plugins: [removeCrossoriginFromCss()],
  server: { proxy },
  preview: { proxy },
});
