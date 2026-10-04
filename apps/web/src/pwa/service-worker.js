/* global SHELL_CACHE, SHELL_ASSETS, caches, self, Request, URL, fetch, Response */
/* __IMBOX_SHELL_CONFIG__ */
const navigation =
  /^\/(?:$|(?:conversations|tasks|requests|runs|actions|grants)(?:\/[0-9a-f-]+)?\/?$|(?:resources|knowledge|recovery|governance|notifications|device|agents)\/?$)/i;
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(
        SHELL_ASSETS.map((path) => new Request(path, { cache: 'reload', credentials: 'omit' })),
      );
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('imbox-shell-') && name !== SHELL_CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API responses, downloads, OIDC and object-store requests never enter this cache.
  if (request.mode === 'navigate' && navigation.test(url.pathname)) {
    event.respondWith(
      fetch(request).catch(
        async () => (await (await caches.open(SHELL_CACHE)).match('/')) ?? Response.error(),
      ),
    );
  } else if (!url.search && SHELL_ASSETS.includes(url.pathname) && url.pathname !== '/') {
    event.respondWith(
      (async () =>
        (await (await caches.open(SHELL_CACHE)).match(url.pathname)) ?? fetch(request))(),
    );
  }
});

self.addEventListener('push', (event) => {
  let tag = 'imbox-notification';
  try {
    const payload = event.data?.json();
    if (/^[a-f0-9-]{36}$/.test(payload?.locator)) tag = `imbox-${payload.locator}`;
  } catch {
    /* A malformed payload still cannot inject private text or an external URL. */
  }
  event.waitUntil(
    self.registration.showNotification('Imbox', {
      body: '你有新的待查看事项',
      tag,
      icon: '/imbox-icon.svg',
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
      if (client) {
        await client.navigate('/notifications');
        await client.focus();
      } else await self.clients.openWindow('/notifications');
    })(),
  );
});
