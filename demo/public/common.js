// Shared helpers for demo pages.
export async function submit(form, data) {
  const res = await fetch(`/api/submit?form=${encodeURIComponent(form)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export function toast(text, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

export function formToObject(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) {
    const value = v instanceof File ? v.name : v;
    if (k in out) out[k] = [].concat(out[k], value);
    else out[k] = value;
  }
  return out;
}

// Header nav on every page.
const nav = document.createElement('header');
nav.className = 'site';
nav.innerHTML = `
  <a href="/" class="brand">Demo Lab</a>
  <nav>
    <div class="menu"><button aria-haspopup="true">Pages ▾</button>
      <div class="dropdown">
        <a href="/forms.html">Forms</a><a href="/tricky-form.html">Tricky form</a><a href="/wizard.html">Wizard</a>
        <a href="/login.html">Login</a><a href="/shop.html">Shop</a><a href="/post.html">Post</a>
        <a href="/dynamic.html">Dynamic</a><a href="/data.html">Data</a><a href="/hard.html">Hard</a>
      </div>
    </div>
    <a href="/shop.html">Shop</a><a href="/cart.html">Cart (<span id="cart-count">0</span>)</a>
  </nav>`;
document.body.prepend(nav);
const count = JSON.parse(localStorage.getItem('cart') ?? '[]').reduce((n, i) => n + i.qty, 0);
document.getElementById('cart-count').textContent = count;
