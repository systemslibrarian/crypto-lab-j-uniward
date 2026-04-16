/**
 * theme.ts — Dark/light theme toggle
 */

export function applyTheme(theme: string): void {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle') as HTMLButtonElement | null;
  if (!btn) return;
  if (theme === 'dark') {
    btn.textContent = '🌙';
    btn.setAttribute('aria-label', 'Switch to light mode');
  } else {
    btn.textContent = '☀️';
    btn.setAttribute('aria-label', 'Switch to dark mode');
  }
}

export function setupThemeToggle(): void {
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') ?? 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', next);
    applyTheme(next);
  });

  applyTheme(document.documentElement.getAttribute('data-theme') ?? 'dark');
}
