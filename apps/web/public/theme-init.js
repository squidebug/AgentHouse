// Applies the saved light/dark choice before the app loads, so there is no flash.
// A file rather than an inline script, so the page's CSP can forbid inline scripts.
try {
  var mode = localStorage.getItem('mui-mode') || 'system';
  var dark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.add(dark ? 'dark' : 'light');
} catch (e) {
  document.documentElement.classList.add('light');
}
