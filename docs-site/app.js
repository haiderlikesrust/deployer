// Copy the AI prompt extension to the clipboard.
const copyBtn = document.getElementById('copyPrompt');
copyBtn?.addEventListener('click', async () => {
  const text = document.getElementById('promptText').innerText;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs a secure context — fall back to a temp selection
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  copyBtn.textContent = 'Copied ✓';
  copyBtn.classList.add('copied');
  setTimeout(() => {
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('copied');
  }, 2000);
});

// Mobile navigation.
const sidebar = document.getElementById('sidebar');
document.getElementById('navToggle')?.addEventListener('click', () => sidebar.classList.toggle('open'));
sidebar?.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') sidebar.classList.remove('open');
});

// Highlight the section currently in view.
const links = [...document.querySelectorAll('#sidebar a')];
const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a) => a.classList.remove('active'));
      byId.get(entry.target.id)?.classList.add('active');
    }
  },
  { rootMargin: '-10% 0px -75% 0px' }
);
document.querySelectorAll('section[id]').forEach((s) => observer.observe(s));
