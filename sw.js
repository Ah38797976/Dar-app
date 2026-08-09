// خدمة (Service Worker) عندها هدفين:
// 1) عرض إشعارات محلية عبر postMessage (كيما كانت من قبل) — تخدم فقط والصفحة مفتوحة/بالخلفية القريبة.
// 2) استقبال إشعارات Push حقيقية عبر Firebase Cloud Messaging (FCM) — توصل حتى والتطبيق مقفول تمامًا.

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

/* نفس إعدادات Firebase المستعملة فـ index.html بالضبط */
firebase.initializeApp({
  apiKey: "AIzaSyAhsIiLvI9ckPrpBI0aX801lJYSEVdVuYI",
  authDomain: "dar-app-be4ed.firebaseapp.com",
  databaseURL: "https://dar-app-be4ed-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dar-app-be4ed",
  storageBucket: "dar-app-be4ed.firebasestorage.app",
  messagingSenderId: "640615693338",
  appId: "1:640615693338:web:0e14d0bc544263c34d25a3"
});

const messaging = firebase.messaging();

/* لما توصل رسالة Push والتطبيق مقفول (background)، هذا الجزء كيعرض الإشعار */
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || '🏠 برنامج البيت اليومي';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body,
    tag: (payload.data && payload.data.tag) || 'daily-house-push',
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
      tag: tag || 'daily-house-turn',
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

