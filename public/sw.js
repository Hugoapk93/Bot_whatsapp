const CACHE_NAME = 'flow-crm-v4';
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

// --- PUSH RECIBIDO (LÓGICA EXACTA) ---
self.addEventListener('push', event => {
  console.log('🔔 Push recibido en SW');
  
  let data = { title: 'CRM Bot', body: 'Nueva notificación', url: './index.html#activity' };
  
  if (event.data) {
    try {
      const json = event.data.json();
      data.title = json.title;
      data.body = json.body;
      // Aquí tomamos la URL exacta que manda el backend. 
      // Si no viene, usamos #activity por defecto.
      data.url = json.url || './index.html#activity'; 
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: 'logo.svg', 
    badge: 'logo.svg',
    vibrate: [200, 100, 200, 100, 200, 100, 400], 
    tag: 'crm-notification', 
    renotify: true, 
    requireInteraction: true,

    // 🔥 GUARDAMOS LA URL EXACTA EN LA NOTIFICACIÓN
    data: { url: data.url } 
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// --- CLIC EN LA NOTIFICACIÓN (REDIRECCIÓN) ---
self.addEventListener('notificationclick', event => {
  console.log('👆 Click en notificación');
  event.notification.close();

  // Recuperamos la URL que guardamos en el evento push
  const targetUrl = event.notification.data.url || './index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      
      // 1. Buscar si ya hay una ventana abierta del CRM
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        
        // Si encontramos la ventana, la enfocamos y la navegamos a la sección correcta
        if (client.url.includes('index.html') && 'focus' in client) {
          client.navigate(targetUrl); // 🔄 Recarga en la sección correcta
          return client.focus();
        }
      }
      
      // 2. Si no hay ventana abierta, abrir una nueva directo en la sección
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
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
