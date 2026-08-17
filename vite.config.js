import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ORS_KEY = env.VITE_ORS_KEY || env.ORS_KEY
  const isCI = process.env.CI === 'true'

  return {
    base: '/BikeSafe/', // project site lives at /BikeSafe/
    plugins: [react()],
    server: {
      proxy: {
        '/ors': {
          target: 'https://api.openrouteservice.org',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/ors/, ''),
          headers: ORS_KEY ? { Authorization: ORS_KEY } : {},
        },
      },
    },
    build: { outDir: 'dist', sourcemap: isCI }
  }
})
