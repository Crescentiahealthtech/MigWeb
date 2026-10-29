const ids = ['server', 'key', 'by'];
chrome.storage.local.get(ids, (v) => ids.forEach((k) => { document.getElementById(k).value = v[k] || ''; }));
document.getElementById('save').onclick = async () => {
  const v = Object.fromEntries(ids.map((k) => [k, document.getElementById(k).value.trim()]));
  const msg = document.getElementById('msg');
  let origin;
  try { origin = new URL(v.server).origin; } catch { msg.textContent = 'Enter the web app address.'; return; }
  v.server = origin;
  // Lets the popup call the web app: asked once, for that address only.
  if (!(await chrome.permissions.request({ origins: [origin + '/*'] }))) { msg.textContent = 'Permission refused.'; return; }
  await chrome.storage.local.set(v);
  msg.textContent = 'Saved.';
};
