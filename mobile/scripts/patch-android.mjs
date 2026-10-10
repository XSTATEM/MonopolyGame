// Правки сгенерированного Android-проекта, которые нельзя задать через
// capacitor.config.json. Запускается после `cap add android` (npm run android:init).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "android", "app", "src", "main", "AndroidManifest.xml");
let xml = readFileSync(manifest, "utf8");
// Токен сессии лежит в localStorage WebView — не отдаём его в облачный бэкап Android.
xml = xml.replace(/android:allowBackup="true"/, 'android:allowBackup="false"');
if (!xml.includes('android:allowBackup="false"')) {
  console.error("Не удалось выключить allowBackup в AndroidManifest.xml");
  process.exit(1);
}
writeFileSync(manifest, xml);
console.log("AndroidManifest.xml: allowBackup=false");
