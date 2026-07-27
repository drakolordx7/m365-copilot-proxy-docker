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
    main { max-width:640px; margin:48px auto; padding:0 20px; }
    h1 { font-size:1.4rem; margin:0 0 8px; }
    p { color:var(--muted); margin:0 0 16px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:20px; margin:16px 0; }
    ol { margin:0; padding-left:1.25rem; }
    li { margin:8px 0; }
    button, a.btn { appearance:none; border:0; border-radius:8px; background:var(--accent); color:#fff; padding:10px 14px; font:inherit; cursor:pointer; text-decoration:none; display:inline-block; }
    button.secondary { background:#e8eef5; color:var(--ink); }
    button:disabled { opacity:.6; cursor:not-allowed; }
    textarea { width:100%; min-height:96px; margin:12px 0; padding:10px; border:1px solid var(--line); border-radius:8px; font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .status { margin-top:12px; padding:10px 12px; border-radius:8px; background:#eef6ff; }
    .status.ok { background:#e8f7ee; color:var(--ok); }
    .status.err { background:#fdebec; color:var(--err); }
    code { background:#eef2f6; padding:1px 6px; border-radius:4px; }
  </style>
</head>
<body>
  <main>
    <h1>Sign in to Microsoft 365 Copilot</h1>
    <p>Use your work account in a normal browser. <strong>Passkeys are supported</strong> — no TOTP seed required.</p>

    <div class="card" id="statusCard">Checking auth status…</div>

    <div class="card" id="loginCard" hidden>
      <ol>
        <li>Click <strong>Start Microsoft login</strong>.</li>
        <li>Sign in with your work account (passkey / Authenticator / whatever your org requires).</li>
        <li>When the browser lands on a mostly blank Microsoft page, copy the <em>full</em> address bar URL (it contains <code>?code=</code>).</li>
        <li>Paste that URL below and click <strong>Complete sign-in</strong>.</li>
      </ol>
      <div class="row" style="margin-top:16px">
        <button id="startBtn" type="button">Start Microsoft login</button>
        <a class="btn secondary" id="openLink" href="#" target="_blank" rel="noopener" hidden>Open login page</a>
      </div>
      <textarea id="redirectUrl" placeholder="Paste redirect URL here (https://login.microsoftonline.com/.../oauth2/nativeclient?code=...)"></textarea>
      <div class="row">
        <button id="completeBtn" type="button">Complete sign-in</button>
        <button id="deviceBtn" class="secondary" type="button">Try device code instead</button>
      </div>
      <div class="status" id="msg" hidden></div>
    </div>
  </main>
  <script>
    const statusCard = document.getElementById('statusCard');
    const loginCard = document.getElementById('loginCard');
    const msg = document.getElementById('msg');
    const openLink = document.getElementById('openLink');

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
      showMsg('Starting login…');
      const res = await fetch('/auth/start');
      const data = await res.json();
      if (data.alreadyAuthenticated) {
        showMsg('Already signed in as ' + (data.account || 'account'), 'ok');
        await refreshStatus();
        return;
      }
      openLink.href = data.authUrl;
      openLink.hidden = false;
      window.open(data.authUrl, '_blank', 'noopener');
      showMsg('Login page opened. After Microsoft finishes, paste the final redirect URL below.');
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

    document.getElementById('deviceBtn').onclick = async () => {
      showMsg('Starting device code… (this request waits until you finish or it fails)');
      const res = await fetch('/auth/device', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMsg((data.message || 'Device code failed') + ' — use browser login instead.', 'err');
        return;
      }
      showMsg('Device code OK: ' + (data.account || 'signed in'), 'ok');
      await refreshStatus();
    };

    refreshStatus().catch((e) => {
      statusCard.textContent = 'Could not reach /auth/status: ' + e.message;
    });
  </script>
</body>
</html>`;
});
