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
  self.skipWaiting(); // Fuerza al SW a activarse de inmediato
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cacheando archivos...');
        // Usamos map para que si falla UNO (ej. fonts), no rompa toda la instalación
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
  self.clients.claim(); // Toma control de la página inmediatamente
});

self.addEventListener('push', event => {
  const data = event.data.json();
  console.log('Push recibido:', data);

  const options = {
    body: data.body,
    icon: 'logo.svg', // Asegúrate que este archivo exista
    badge: 'logo.svg',
    vibrate: [100, 50, 100], // Patrón de vibración
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {action: 'explore', title: 'Ver Monitor'}
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// --- CLIC EN LA NOTIFICACIÓN ---
self.addEventListener('notificationclick', event => {
  event.notification.close();
  // Al hacer clic, abre la ventana del monitor
  event.waitUntil(
    clients.matchAll({type: 'window'}).then( windowClients => {
      for (var i = 0; i < windowClients.length; i++) {
        var client = windowClients[i];
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
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
