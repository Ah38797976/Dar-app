# عزل المتاجر (Multi-Tenant Security) — دليل مختصر

## ما تغيّر
- تسجيل دخول حقيقي لكل متجر (بريد/كلمة سر) بدل الدخول المجهول.
- كل بيانات القاعدة أصبحت تحت `stores/{storeId}/...` بدل الجذر المشترك.
- `storeId` يُشتق فقط من `custom claim` الموجودة في توكن Firebase الموثّق من
  السيرفر — لا يمكن للمستخدم تزويرها من المتصفح.
- `database.rules.json` يفرض `auth.token.storeId === $storeId` على كل قراءة/كتابة.
- `api/send-to-all.js` يتحقق من هوية المتصل عبر `verifyIdToken` ويحصر الإشعارات
  في توكنات متجره فقط.
- مفاتيح `localStorage` الخاصة بالمنتجات/المخزون أصبحت مربوطة بـ storeId
  (حماية إضافية عند استخدام نفس الجهاز لأكثر من متجر) — المخزون بقي محليًا
  كما هو، لم يُنقل لـ Firebase.

## خطوات يجب أن تقوم بها أنت (ممنوع عليّ الـ Deploy)
1. **الصق `database.rules.json`** في Firebase Console → Realtime Database → Rules، واضغط نشر.
2. **أنشئ حسابات المتاجر**:
   ```
   npm install
   node scripts/create-store.js create \
     --service-account ./serviceAccountKey.json \
     --database-url https://dar-app-be4ed-default-rtdb.asia-southeast1.firebasedatabase.app \
     --store-id store_default \
     --email your-store@example.com \
     --password "كلمة سر قوية"
   ```
3. **انقل البيانات القديمة** (نسخ فقط، بدون حذف) لأول متجر:
   ```
   node scripts/migrate-root-to-store.js \
     --service-account ./serviceAccountKey.json \
     --database-url https://dar-app-be4ed-default-rtdb.asia-southeast1.firebasedatabase.app \
     --store-id store_default --dry-run   # جرّبها أولًا بـ dry-run
   ```
   بعد التأكد، أعد الأمر بدون `--dry-run`.
4. **ارفع الملفات** (`index.html`, `api/send-to-all.js`) لمكان الاستضافة الحالي بنفسك.
5. احذف بيانات الجذر القديمة يدويًا من الكونسول فقط بعد التأكد أن كل شيء يعمل
   (السكريبتات هنا لا تحذف أي شيء أبدًا).

## الاختبارات
- `node tests/inventory-logic.test.js` — **تم تشغيله فعليًا هنا، 16/16 ناجح.**
  يغطي منطق المخزون (غير المُعدَّل) + عزل مفاتيح localStorage الجديد.
- `tests/security-rules.test.js` — اختبار قواعد الأمان الحقيقي (عزل السيرفر،
  محاولات تغيير store_id). لم يُشغَّل هنا (لا يوجد إنترنت/Firebase CLI في بيئة
  التنفيذ). شغّله عندك:
  ```
  npm install
  npm run test:rules
  ```

## فحص يدوي موصى به قبل الاعتماد النهائي (متصفح حقيقي)
- تسجيل الدخول بحساب متجر A ثم محاولة الوصول لبيانات متجر B عبر تعديل الرابط/الكونسول يدويًا.
- تسجيل خروج ودخول بمتجر مختلف على نفس الجهاز، والتأكد أن قسم المنتجات فارغ (لا يرى بيانات المتجر السابق).
- التأكد أن وظائف المخزون (إضافة/خصم/بحث/تنبيه النفاد) تعمل كالمعتاد.
- إرسال إشعار جماعي من حساب متجر A والتأكد أنه يصل فقط لهواتف مسجَّلة بمتجر A.
