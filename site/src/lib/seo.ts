import { PRODUCT, SITE_URL, VERSION, home, product } from '../content/site';

/** The absolute, self-referencing URL of a path: no trailing slash, except the home page. */
export function absolute(path: string): string {
  if (path === '/' || path === '') return `${SITE_URL}/`;
  return `${SITE_URL}${path.replace(/\/+$/, '')}`;
}

const WEBSITE_ID = `${SITE_URL}/#website`;
const APP_ID = `${SITE_URL}/#app`;

const website = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  url: `${SITE_URL}/`,
  name: PRODUCT,
  description: product.description,
  inLanguage: 'en',
};

const app = {
  '@type': 'SoftwareApplication',
  '@id': APP_ID,
  name: PRODUCT,
  description: product.description,
  url: `${SITE_URL}/`,
  applicationCategory: 'BrowserApplication',
  operatingSystem: product.systems.join(', '),
  browserRequirements: `Requires ${product.browsers.join(', ')} (Chromium, Manifest V3)`,
  softwareVersion: VERSION,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  isBasedOn: 'https://github.com/nanobrowser/nanobrowser',
  installUrl: `${SITE_URL}/install`,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

/** One @graph for the home page: the site, the extension and its questions. */
export function homeGraph() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      website,
      app,
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: home.faq.items.map(item => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
}

/** The graph for an inner page: the site, the page and its breadcrumb trail. */
export function pageGraph(path: string, name: string, description: string, crumb: string) {
  const url = absolute(path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      website,
      {
        '@type': 'WebPage',
        '@id': `${url}#page`,
        url,
        name,
        description,
        isPartOf: { '@id': WEBSITE_ID },
        about: { '@id': APP_ID },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: PRODUCT, item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: crumb, item: url },
        ],
      },
    ],
  };
}

/** JSON for a <script type="application/ld+json">, with `<` escaped so no value can close the tag. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
