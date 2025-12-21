const CACHE_NAME = 'flow-crm-v3';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './logo.svg',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cacheando archivos...');
        return Promise.all(
          urlsToCache.map(url => {
            return cache.add(url).catch(err => console.log('Fallo cachear:', url));
          })
        );
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Borrando cache vieja:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// --- PUSH RECIBIDO (Segundo plano) ---
self.addEventListener('push', event => {
  console.log('🔔 Push recibido en SW'); // Log para confirmar llegada
  
  let data = { title: 'Notificación', body: 'Nuevo evento' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      console.log('Push no es JSON:', event.data.text());
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: 'logo.svg', 
    badge: 'logo.svg',
    vibrate: [100, 50, 100],
    data: { url: './index.html' }, // Guardamos la URL destino aquí
    requireInteraction: true // Mantiene la notificación hasta que el usuario la toque
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// --- CLIC EN LA NOTIFICACIÓN ---
self.addEventListener('notificationclick', event => {
  console.log('👆 Click en notificación');
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // Intentar enfocar una ventana ya abierta
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        // Verificamos si la URL contiene tu dominio base, no solo '/'
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no hay ventana, abrir una nueva
      if (clients.openWindow) {
        return clients.openWindow('./index.html');
      }
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        return response || fetch(event.request);
      })
  );
});
