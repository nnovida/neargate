import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/seo';
import { DOC_LINKS } from '@/lib/doc-links';

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = ['', '/catalog', '/activity', ...DOC_LINKS.map((l) => l.href)];
  return routes.map((path) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency: 'weekly',
    priority: path === '' ? 1 : path === '/docs' ? 0.9 : path.startsWith('/docs') ? 0.7 : 0.6,
  }));
}
