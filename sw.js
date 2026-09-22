const SHELL_PATHS = Object.freeze([
  'index.html',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png'
]);

function toShellCacheKey(input, scopeUrl, isNavigation = false) {
  const scope = new URL(scopeUrl);
  const url = new URL(typeof input === 'string' ? input : input.url, scope);
  if (url.origin !== scope.origin) return null;
  if (input && typeof input !== 'string' && input.method && input.method !== 'GET') return null;
  const scopePath = scope.pathname.endsWith('/') ? scope.pathname : `${scope.pathname}/`;
  if (!url.pathname.startsWith(scopePath)) return null;
  if (isNavigation) return new URL('index.html', scope).href;
  const relative = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : null;
  if (relative === '' || relative === 'index.html') return new URL('index.html', scope).href;
  return SHELL_PATHS.includes(relative) ? new URL(relative, scope).href : null;
}

function pageHasBuildId(html, buildId) {
  return html.includes(`name="xinyu-build" content="${buildId}"`);
}

function manifestHasBuildId(text, buildId) {
  try {
    return JSON.parse(text).x_build_id === buildId;
  } catch {
    return false;
  }
}


const BUILD_ID = 'a6f349511b5c';
const SCOPE_ID = encodeURIComponent(new URL(self.registration.scope).pathname);
const CACHE_PREFIX = `xinyu-shell-${SCOPE_ID}-`;
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const shellUrls = () => SHELL_PATHS.map(path => new URL(path, self.registration.scope).href);

async function verifyShell(cache) {
  const keys = shellUrls();
  const responses = await Promise.all(keys.map(key => cache.match(key)));
  if (responses.some(response => !response || !response.ok)) return false;
  const index = await responses[0].clone().text();
  const manifest = await responses[1].clone().text();
  return pageHasBuildId(index, BUILD_ID) && manifestHasBuildId(manifest, BUILD_ID);
}

async function fillAndVerify(cache) {
  await cache.addAll(shellUrls());
  if (!await verifyShell(cache)) throw new Error('Shell build mismatch');
  return true;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await fillAndVerify(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const key = toShellCacheKey(request, self.registration.scope, request.mode === 'navigate');
  if (!key) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok && response.type !== 'opaque') {
          const text = await response.clone().text();
          if (pageHasBuildId(text, BUILD_ID)) await cache.put(key, response.clone());
        }
        return response;
      } catch {
        return (await cache.match(key)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && response.type !== 'opaque') await cache.put(key, response.clone());
    return response;
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_SHELL') return;
  event.waitUntil((async () => {
    let ready = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      ready = await verifyShell(cache);
      if (!ready) ready = await fillAndVerify(cache);
    } catch {
      ready = false;
    }
    event.ports?.[0]?.postMessage({ ready, buildId: BUILD_ID });
  })());
});
