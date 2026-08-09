// خدمة بسيطة (Service Worker) هدفها الوحيد: عرض إشعارات حقيقية على مستوى النظام
// (تطلع في شريط الإشعارات بالشاشة) حتى وقت ما تكون الصفحة نفسها مو بالواجهة الأمامية،
// طالما التطبيق مفتوح أو شغال بالخلفية (مو مقفول تمامًا). لا يوجد أي Push حقيقي هنا؛
// كل الإشعارات تنطلق من الصفحة نفسها عبر postMessage.

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

// لما المستخدم يضغط على الإشعار، نرجّعه لصفحة التطبيق مباشرة
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
