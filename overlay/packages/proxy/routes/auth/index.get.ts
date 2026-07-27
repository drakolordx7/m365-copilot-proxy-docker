export default defineEventHandler(async (event) => {
  setHeader(event, "content-type", "text/html; charset=utf-8");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M365 Copilot Proxy — Sign in</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --card:#fff; --ink:#15202b; --muted:#5b6b7c; --accent:#0f6cbd; --ok:#0e7a3d; --err:#b10e1c; --line:#d8dee6; }
    * { box-sizing: border-box; }
    body { margin:0; font:16px/1.5 system-ui,Segoe UI,sans-serif; background:var(--bg); color:var(--ink); }
    main { max-width:680px; margin:48px auto; padding:0 20px; }
    h1 { font-size:1.4rem; margin:0 0 8px; }
    p { color:var(--muted); margin:0 0 16px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin:16px 0; }
    .warn { background:#fff8e6; border-color:#f0d88a; color:#6b4e00; }
    ol { margin:0; padding-left:1.25rem; }
    li { margin:8px 0; }
    button, a.btn { appearance:none; border:0; border-radius:8px; background:var(--accent); color:#fff; padding:10px 14px; font:inherit; cursor:pointer; text-decoration:none; display:inline-block; }
    a.btn.secondary, button.secondary { background:#e8eef5; color:var(--ink); }
    button:disabled { opacity:.6; cursor:not-allowed; }
    textarea, input[type=text] { width:100%; margin:12px 0; padding:10px; border:1px solid var(--line); border-radius:8px; font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    textarea { min-height:96px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .status { margin-top:12px; padding:10px 12px; border-radius:8px; background:#eef6ff; }
    .status.ok { background:#e8f7ee; color:var(--ok); }
    .status.err { background:#fdebec; color:var(--err); }
    code { background:#eef2f6; padding:1px 6px; border-radius:4px; }
    .urlBox { word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to Microsoft 365 Copilot</h1>
    <p>Sign in with your work Microsoft account. Passkeys work in a <strong>normal phone or desktop browser</strong> — not inside most Docker browsers.</p>

    <div class="card warn">
      <strong>Using Firefox in Docker?</strong> Popups and passkey/security prompts usually do not appear there.
      Open this same page on your phone or PC instead: copy the address bar URL from Firefox and paste it into Safari/Chrome/Edge on your phone.
    </div>

    <div class="card" id="statusCard">Checking auth status…</div>

    <div class="card" id="loginCard" hidden>
      <ol>
        <li>Click <strong>Get login link</strong> below.</li>
        <li>Open the Microsoft link in a <strong>normal browser</strong> (phone Safari/Chrome recommended for passkeys).</li>
        <li>Complete sign-in. When you land on a mostly blank Microsoft page, copy the <em>full</em> address bar URL (<code>?code=</code>).</li>
        <li>Come back here and paste that URL → <strong>Complete sign-in</strong>.</li>
      </ol>

      <div class="row" style="margin-top:16px">
        <button id="startBtn" type="button">Get login link</button>
        <a class="btn secondary" id="openSameTab" href="#" hidden>Open Microsoft login (this tab)</a>
        <button id="copyBtn" class="secondary" type="button" hidden>Copy login URL</button>
      </div>

      <input class="urlBox" id="authUrlField" type="text" readonly hidden placeholder="Login URL appears here…" />

      <textarea id="redirectUrl" placeholder="Paste redirect URL here after Microsoft login (https://login.microsoftonline.com/.../oauth2/nativeclient?code=...)"></textarea>
      <div class="row">
        <button id="completeBtn" type="button">Complete sign-in</button>
      </div>
      <div class="status" id="msg" hidden></div>
    </div>
  </main>
  <script>
    const statusCard = document.getElementById('statusCard');
    const loginCard = document.getElementById('loginCard');
    const msg = document.getElementById('msg');
    const openSameTab = document.getElementById('openSameTab');
    const copyBtn = document.getElementById('copyBtn');
    const authUrlField = document.getElementById('authUrlField');

    function showMsg(text, kind) {
      msg.hidden = false;
      msg.className = 'status' + (kind ? ' ' + kind : '');
      msg.textContent = text;
    }

    async function refreshStatus() {
      const res = await fetch('/auth/status');
      const data = await res.json();
      if (data.authenticated) {
        statusCard.className = 'card status ok';
        statusCard.textContent = 'Signed in as ' + (data.account || 'Microsoft account') + '. API ready at /v1';
        loginCard.hidden = true;
      } else {
        statusCard.className = 'card';
        statusCard.textContent = 'Not signed in (mode: ' + data.mode + ').';
        loginCard.hidden = false;
      }
      return data;
    }

    document.getElementById('startBtn').onclick = async () => {
      showMsg('Fetching login link…');
      const res = await fetch('/auth/start');
      const data = await res.json();
      if (data.alreadyAuthenticated) {
        showMsg('Already signed in as ' + (data.account || 'account'), 'ok');
        await refreshStatus();
        return;
      }
      authUrlField.value = data.authUrl;
      authUrlField.hidden = false;
      openSameTab.href = data.authUrl;
      openSameTab.hidden = false;
      copyBtn.hidden = false;
      showMsg('Login link ready. Open it on your phone/PC browser (not Docker Firefox). Bookmark this page so you can return and paste the redirect URL.');
    };

    copyBtn.onclick = async () => {
      const url = authUrlField.value;
      if (!url) { showMsg('Click Get login link first.', 'err'); return; }
      try {
        await navigator.clipboard.writeText(url);
        showMsg('Login URL copied. Paste into Safari/Chrome on your phone.', 'ok');
      } catch {
        authUrlField.select();
        document.execCommand('copy');
        showMsg('Login URL selected — copy manually (Ctrl/Cmd+C).', 'ok');
      }
    };

    document.getElementById('completeBtn').onclick = async () => {
      const redirectUrl = document.getElementById('redirectUrl').value.trim();
      if (!redirectUrl) { showMsg('Paste the redirect URL first.', 'err'); return; }
      showMsg('Completing sign-in…');
      const res = await fetch('/auth/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirectUrl }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMsg(data.message || data.statusMessage || 'Sign-in failed', 'err');
        return;
      }
      showMsg('Signed in as ' + (data.account || 'Microsoft account'), 'ok');
      await refreshStatus();
    };

    refreshStatus().catch((e) => {
      statusCard.textContent = 'Could not reach /auth/status: ' + e.message;
    });
  </script>
</body>
</html>`;
});
