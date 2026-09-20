// خدمة (Service Worker) عندها هدفين:
// 1) عرض إشعارات محلية عبر postMessage (كيما كانت من قبل) — تخدم فقط والصفحة مفتوحة/بالخلفية القريبة.
// 2) استقبال إشعارات Push حقيقية عبر Firebase Cloud Messaging (FCM) — توصل حتى والتطبيق مقفول تمامًا.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

/* نفس إعدادات Firebase المستعملة فـ index.html بالضبط */
firebase.initializeApp({
  apiKey: "AIzaSyBQrCO1BOQ-0D9isZdTtbTUE4EK6vuGppA",
  authDomain: "tajirapp-fe79d.firebaseapp.com",
  databaseURL: "https://tajirapp-fe79d-default-rtdb.firebaseio.com",
  projectId: "tajirapp-fe79d",
  storageBucket: "tajirapp-fe79d.firebasestorage.app",
  messagingSenderId: "790673886877",
  appId: "1:790673886877:web:b58c57e4e70536efab4e74"
});

const messaging = firebase.messaging();

/* لما توصل رسالة Push والتطبيق مقفول (background)، هذا الجزء كيعرض الإشعار */
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || '🏪 تطبيق التاجر';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    tag: (payload.data && payload.data.tag) || 'tajirapp-push',
    renotify: true,
    requireInteraction: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    vibrate: [250, 120, 250, 120, 250]
  });
});

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = data;
    self.registration.showNotification(title, {
      body,
      tag: tag || 'tajirapp-local',
      renotify: true,
      requireInteraction: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      vibrate: [250, 120, 250, 120, 250]
    });
  }
});

// لما المستخدم يضغط على الإشعار (محلي أو Push)، نرجّعه لصفحة التطبيق مباشرة
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});

