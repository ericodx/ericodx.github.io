// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://ericodx.io',
  integrations: [mdx(), sitemap()],

  fonts: [
    {
      provider: fontProviders.local(),
      name: 'iA Writer Quattro',
      cssVariable: '--font-iawriter-quattro',
      fallbacks: ['system-ui', 'sans-serif'],
      options: {
        variants: [
          {
            src: ['./src/assets/fonts/iawriter/iAWriterQuattroV.woff2'],
            weight: '100 900',
            style: 'normal',
            display: 'swap',
          },
          {
            src: ['./src/assets/fonts/iawriter/iAWriterQuattroV-Italic.woff2'],
            weight: '100 900',
            style: 'italic',
            display: 'swap',
          },
        ],
      },
    },
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
