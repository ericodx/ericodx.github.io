import type { APIRoute } from 'astro';
export const prerender = true;

import { getCollection } from 'astro:content';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SITE_TITLE } from '../../consts';

const fontRegular = await fs.readFile(
  path.resolve(process.cwd(), 'src/assets/og/iAWriterQuattroS-Regular.ttf'),
);
const fontBold = await fs.readFile(
  path.resolve(process.cwd(), 'src/assets/og/iAWriterQuattroS-Bold.ttf'),
);

export async function getStaticPaths() {
  const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const { post } = props;
  const date = new Date(post.data.pubDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const svg = await satori(
    {
      type: 'div',
      props: {
        style: {
          width: '1200px',
          height: '630px',
          background: '#ffffff',
          color: '#131623',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          fontFamily: 'iA Writer Quattro',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '32px',
                fontWeight: 500,
                letterSpacing: '-1px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      width: '6px',
                      height: '32px',
                      background: '#131623',
                      borderRadius: '2px',
                    },
                  },
                },
                'edx',
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '24px',
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '72px',
                      fontWeight: 700,
                      lineHeight: 1.1,
                      letterSpacing: '-3px',
                      maxWidth: '1040px',
                    },
                    children: post.data.title,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: '28px',
                      color: '#787878',
                      display: 'flex',
                      gap: '16px',
                    },
                    children: [date, '·', SITE_TITLE],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
      fonts: [
        {
          name: 'iA Writer Quattro',
          data: fontRegular,
          weight: 400,
          style: 'normal',
        },
        {
          name: 'iA Writer Quattro',
          data: fontBold,
          weight: 700,
          style: 'normal',
        },
      ],
    },
  );

  const png = new Resvg(svg).render().asPng();
  return new Response(png as BodyInit, {
    headers: { 'Content-Type': 'image/png' },
  });
};
