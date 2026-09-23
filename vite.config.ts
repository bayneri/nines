import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build can be hosted under any path.
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
});
