import { defineConfig } from 'vite';
const proxy = {
  '/api': 'http://127.0.0.1:3000',
  '/assets': 'http://127.0.0.1:3000',
  '/demo': 'http://127.0.0.1:3000',
};
export default defineConfig({
  root: 'frontend',
  base: '/react/',
  publicDir: 'static',
  build: { outDir: '../public/react', emptyOutDir: true },
  server: { proxy },
  preview: { proxy },
});
