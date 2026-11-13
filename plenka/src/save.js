// Сохранение файла: на Android — в «Документы/Плёнка» + меню «Поделиться», на ПК — обычное скачивание

const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function saveBlob(blob, name) {
  if (isNative()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const data = await blobToBase64(blob);
    const res = await Filesystem.writeFile({ path: 'Plenka/' + name, data, directory: 'DOCUMENTS', recursive: true });
    try {
      if (Share) await Share.share({ title: name, files: [res.uri] });
    } catch (e) { /* пользователь закрыл меню */ }
    return 'Сохранено: Документы/Plenka/' + name;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'Файл сохранён: ' + name;
}
