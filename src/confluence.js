// The only code that talks to the network. It talks to one host: the
// Confluence site given on the command line. Redirects are refused, so the
// token can never be sent to another host.
'use strict';

const SITE_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Checks and normalises the site address: https, a host name, nothing else. */
function siteOrigin(site) {
  const s = String(site || '').trim().replace(/\/+$/, '').replace(/\/wiki$/, '');
  if (!SITE_RE.test(s.toLowerCase())) throw new Error('--site must look like https://your-site.atlassian.net (https, no path)');
  return s.toLowerCase();
}

/**
 * @param {{site:string, authHeader?:string, fetch?:Function, sleep?:Function, retries?:number}} o
 *   authHeader is built by the caller from the environment; fetch and
 *   sleep are injectable for tests.
 */
function client(o) {
  const origin = siteOrigin(o.site);
  const doFetch = o.fetch || globalThis.fetch;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 4;

  async function call(method, path, body) {
    if (!path.startsWith('/wiki/')) throw new Error('internal: path outside /wiki');
    const url = origin + path;
    for (let attempt = 0; ; attempt++) {
      const headers = { Accept: 'application/json' };
      if (o.authHeader) headers.Authorization = o.authHeader;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
      } catch (e) {
        throw new HttpError(`${method} ${path}: network error (${e && e.message ? e.message : 'unknown'})`, 0);
      }
      // Too many requests (429): Confluence did nothing, so waiting and
      // asking again is safe, for a write too. Busy (503): asked again for a
      // read only, since a gateway may answer 503 to a save that went through.
      if ((res.status === 429 || (res.status === 503 && method === "GET")) && attempt < retries) {
        const ra = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 120) * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (res.status < 200 || res.status > 299) {
        const msg = (json && (json.message || (json.errors && json.errors[0] && (json.errors[0].title || json.errors[0].detail)))) || text.slice(0, 200);
        throw new HttpError(`${method} ${path}: HTTP ${res.status}${msg ? ` (${String(msg).slice(0, 300)})` : ''}`, res.status);
      }
      return json;
    }
  }

  return {
    origin,
    /** One page of CQL search results, page type only. */
    async search(cql, cursor, limit = 50) {
      const q = `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await call('GET', q);
      const next = r && r._links && r._links.next ? new URLSearchParams(r._links.next.split('?')[1] || '').get('cursor') : null;
      return { results: (r && r.results) || [], next };
    },
    /** A page with its storage; `version` reads an older version. */
    async getPage(id, version) {
      if (!/^\d+$/.test(String(id))) throw new Error(`bad page id ${id}`);
      const v = version ? `&version=${Number(version)}` : '';
      const r = await call('GET', `/wiki/api/v2/pages/${id}?body-format=storage${v}`);
      return {
        id: String(r.id),
        title: r.title,
        status: r.status,
        spaceId: String(r.spaceId),
        version: r.version && r.version.number,
        storage: r.body && r.body.storage ? r.body.storage.value : null,
      };
    },
    async getSpaceByKey(key) {
      const r = await call('GET', `/wiki/api/v2/spaces?keys=${encodeURIComponent(key)}&limit=1`);
      return r && r.results && r.results[0] ? { id: String(r.results[0].id), key: r.results[0].key } : null;
    },
    /**
     * Saves a new version. The version number is the one read plus one, so
     * if anyone saved the page since it was read, Confluence refuses (409)
     * and nothing is written. `minorEdit` keeps watchers from being
     * notified.
     */
    async updatePage({ id, title, storage, fromVersion, message, minorEdit = true }) {
      const r = await call('PUT', `/wiki/rest/api/content/${id}`, {
        id: String(id),
        type: 'page',
        status: 'current',
        title,
        body: { storage: { value: storage, representation: 'storage' } },
        version: { number: fromVersion + 1, message, minorEdit },
      });
      return { version: r && r.version && r.version.number };
    },
  };
}

module.exports = { client, siteOrigin, HttpError };
