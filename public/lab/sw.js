// Android "Share → CresRx" with a PDF posts it to /lab/share (the share_target
// in /manifest.webmanifest). This keeps the file and opens /lab/ to read it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== '/lab/share') return;
  e.respondWith((async () => {
    const file = (await e.request.formData()).get('report');
    if (file) await (await caches.open('lab-share')).put('/lab/shared.pdf', new Response(file, { headers: { 'content-type': 'application/pdf' } }));
    return Response.redirect('/lab/?shared=' + (file ? 1 : 0), 303);
  })());
});
