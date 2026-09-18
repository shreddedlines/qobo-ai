// Applies a remembered theme before the first paint, so a dark-mode reload does not
// flash light. Kept as a file rather than an inline script so the production
// Content-Security-Policy can forbid inline scripts outright.
try {
  var choice = localStorage.getItem('qobo-theme');
  if (choice === 'light' || choice === 'dark') document.documentElement.setAttribute('data-theme', choice);
} catch {
  // A browser that refuses storage simply follows prefers-color-scheme.
}
