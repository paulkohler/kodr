import { buildSite } from './blog.mjs';

const result = await buildSite();
console.log(`Built ${result.postCount} posts into ${result.outDir}`);
