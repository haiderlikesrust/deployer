// The landing serves at the APEX (yourdomain.com); docs and the dashboard live
// on sibling subdomains. Rewrite the links from the current hostname so the
// same static page works on any base domain (tenku.xyz, localhost, sslip.io).
(function rewriteLinks() {
  const host = location.hostname;
  const base = host.startsWith('www.') ? host.slice(4) : host;
  for (const a of document.querySelectorAll('[data-docs]')) a.href = `${location.protocol}//docs.${base}`;
  for (const a of document.querySelectorAll('[data-dashboard]')) a.href = `${location.protocol}//deploy.${base}`;
})();

// Copy the install command.
const copyBtn = document.getElementById('copyInstall');
copyBtn?.addEventListener('click', async () => {
  const text = document.getElementById('installCmd').innerText;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
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
  copyBtn.classList.add('done');
  setTimeout(() => {
    copyBtn.textContent = 'Copy';
    copyBtn.classList.remove('done');
  }, 2000);
});

// Terminal typing effect: reveal the demo log line by line on first view.
(function animateTerminal() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pre = document.getElementById('termDemo');
  if (!pre) return;

  // split rendered content into line wrappers we can reveal one at a time
  const html = pre.innerHTML.split('\n');
  pre.innerHTML = html.map((l) => `<span class="line line-hidden">${l || ' '}</span>`).join('\n');
  const lines = [...pre.querySelectorAll('.line')];

  const reveal = () => {
    let i = 0;
    const tick = () => {
      if (i >= lines.length) return;
      lines[i].classList.remove('line-hidden');
      // builds take a beat; the git push is instant
      const delay = i === 0 ? 500 : i === 4 ? 900 : 340;
      i += 1;
      setTimeout(tick, delay);
    };
    tick();
  };

  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        reveal();
      }
    },
    { threshold: 0.4 }
  );
  io.observe(pre);
})();
