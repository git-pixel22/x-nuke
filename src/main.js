import './style.css';
import scriptSource from '../script/x-nuke.js?raw';

/* ---------- fill the terminal with the real script ---------- */
const preview = document.querySelector('#script-preview code');
if (preview) preview.textContent = scriptSource;

const sizeEl = document.getElementById('script-size');
if (sizeEl) {
  const lines = scriptSource.split('\n').length;
  const kb = (new Blob([scriptSource]).size / 1024).toFixed(1);
  sizeEl.textContent = `${lines} lines · ${kb} KB`;
}

/* ---------- copy to clipboard ---------- */
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toast-msg');
let toastTimer;

function showToast(message, ok = true) {
  if (!toast) return;
  toastMsg.textContent = message;
  toast.style.background = ok ? 'var(--lime)' : 'var(--orange)';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

async function copyScript(button) {
  try {
    await navigator.clipboard.writeText(scriptSource);
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = scriptSource;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      showToast('Could not copy. Use the Download button.', false);
      ta.remove();
      return;
    }
    ta.remove();
  }

  showToast('Script copied. Paste it into your console.');
  if (button) {
    const label = button.querySelector('span');
    const original = label ? label.textContent : null;
    button.classList.add('copied');
    if (label) label.textContent = 'COPIED ✔';
    setTimeout(() => {
      button.classList.remove('copied');
      if (label && original) label.textContent = original;
    }, 2000);
  }
}

for (const id of ['copy-hero', 'copy-step', 'copy-term', 'copy-foot']) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', (e) => { e.preventDefault(); copyScript(el); });
}

/* ---------- scroll reveals ---------- */
const revealables = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry, i) => {
      if (!entry.isIntersecting) return;
      setTimeout(() => entry.target.classList.add('in'), i * 70);
      io.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  revealables.forEach((el) => io.observe(el));
} else {
  revealables.forEach((el) => el.classList.add('in'));
}

/* ---------- the hero counter running down to zero ---------- */
const counter = document.getElementById('counter');
const bar = document.getElementById('counter-bar');
const START = 5852;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function runCounter() {
  if (!counter) return;
  if (reduced) {
    counter.textContent = '0';
    if (bar) bar.style.width = '0%';
    return;
  }
  const duration = 2600;
  const t0 = performance.now();

  function frame(now) {
    const p = Math.min((now - t0) / duration, 1);
    const eased = 1 - Math.pow(1 - p, 3);        // ease-out cubic
    const value = Math.round(START * (1 - eased));
    counter.textContent = value.toLocaleString();
    if (bar) bar.style.width = `${(1 - eased) * 100}%`;
    if (p < 1) requestAnimationFrame(frame);
    else counter.textContent = '0';
  }
  requestAnimationFrame(frame);
}

setTimeout(runCounter, 700);
