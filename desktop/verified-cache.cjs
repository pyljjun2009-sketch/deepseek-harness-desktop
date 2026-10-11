const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');

// Optional pnpm transport hook. Keep the original lockfile and integrity unchanged.
const url = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
module.exports = {
  fetchers: [{
    canFetch: (_id, resolution) => resolution.tarball === url && Boolean(process.env.DSH_SHEETJS_CACHE),
    fetch: (cafs, resolution, options, fetchers) => {
      const file = process.env.DSH_SHEETJS_CACHE;
      const body = readFileSync(file);
      const actual = `sha512-${createHash('sha512').update(body).digest('base64')}`;
      if (actual !== resolution.integrity) throw new Error('SheetJS local cache does not match upstream lockfile');
      return fetchers.localTarball(cafs, { ...resolution, tarball: `file:${file}` }, options);
    }
  }]
};
