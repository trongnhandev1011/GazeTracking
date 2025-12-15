import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm"], // IMPORTANT
  },
  build: {
    commonjsOptions: {
      include: [/web-llm/, /node_modules/],
    },
  },
})
