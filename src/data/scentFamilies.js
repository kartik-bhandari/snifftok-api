/**
 * src/data/scentFamilies.js
 * The 5 fixed product categories (scent families) — the single source of truth.
 * Written to the Category collection by `npm run seed:categories`; the admin
 * panel and storefront both read them from the API.
 *
 * To change wording, edit here and re-run the seed (it upserts by slug).
 */

export const SCENT_FAMILIES = [
  {
    slug:        'floral',
    name:        'Floral',
    sortOrder:   1,
    smellsLike:  'Fresh-cut flowers, soft petals, and dewy or powdery bouquets.',
    notes:       ['Rose', 'Jasmine', 'Orange blossom', 'Lily'],
    subfamilies: ['Fruity floral', 'Soft floral', 'Floral green', 'Floral woody musk'],
    bestFor:     'Everyday wear, office settings, and romantic or daytime occasions.',
  },
  {
    slug:        'amber',
    name:        'Amber',
    aka:         'Formerly Oriental',
    sortOrder:   2,
    smellsLike:  'Warm, opulent, sensual, and spicy notes with resinous depth.',
    notes:       ['Vanilla', 'Amber resin', 'Myrrh', 'Cinnamon', 'Cardamom'],
    subfamilies: ['Soft amber', 'Woody amber', 'Floral amber', 'Spicy amber'],
    bestFor:     'Evening events, cooler weather, and long-lasting performance.',
  },
  {
    slug:        'woody',
    name:        'Woody',
    sortOrder:   3,
    smellsLike:  'Grounded, earthy, warm, and rich forest-floor elements.',
    notes:       ['Sandalwood', 'Cedarwood', 'Vetiver', 'Patchouli', 'Oud'],
    subfamilies: [],
    bestFor:     'Versatile daily use, formal occasions, and long-lasting wear.',
  },
  {
    slug:        'fresh',
    name:        'Fresh',
    sortOrder:   4,
    smellsLike:  'Clean, bright, crisp, and cooling energy.',
    notes:       ['Bergamot', 'Lemon', 'Sea notes', 'Green tea', 'Mint'],
    subfamilies: [],
    bestFor:     'Hot weather, morning wear, and sports.',
  },
  {
    slug:        'gourmand',
    name:        'Gourmand',
    sortOrder:   5,
    smellsLike:  'Edible, sweet, and dessert-like treats that evoke a culinary warmth.',
    notes:       ['Vanilla', 'Caramel', 'Chocolate', 'Praline', 'Cotton candy', 'Coffee', 'Honey'],
    subfamilies: ['Fruity gourmand', 'Woody gourmand', 'Spicy gourmand'],
    bestFor:     'Cold weather, cozy evening wear, and anyone who loves ultra-sweet or comforting scents.',
  },
]

export const SCENT_FAMILY_SLUGS = SCENT_FAMILIES.map(f => f.slug)
