import { withCors } from "./core";

export function accountAdminPage(): Response {
  const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ChatGPT Account Pool</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#1f2328; --muted:#667085; --line:#d0d7de; --accent:#0969da; --bad:#cf222e; --ok:#1a7f37; --warn:#9a6700; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    header { padding:24px 28px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
    h1 { margin:0 0 6px; font-size:24px; font-weight:650; letter-spacing:0; }
    header p { margin:0; color:var(--muted); font-size:14px; }
    main { padding:22px 28px 36px; display:grid; grid-template-columns: minmax(280px, 380px) 1fr; gap:20px; align-items:start; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .panel-title { padding:14px 16px; border-bottom:1px solid var(--line); font-weight:650; }
    form { padding:16px; display:grid; gap:12px; }
    label { display:grid; gap:6px; font-size:13px; color:var(--muted); }
    input, select { width:100%; min-height:38px; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font:inherit; color:var(--text); background:#fff; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    button { border:1px solid var(--line); border-radius:6px; min-height:34px; padding:7px 10px; background:#fff; color:var(--text); font:inherit; cursor:pointer; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    button.danger { color:var(--bad); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .toolbar { padding:12px 16px; display:flex; gap:10px; align-items:center; border-bottom:1px solid var(--line); }
    .toolbar input { max-width:260px; }
    .status { display:inline-flex; align-items:center; min-height:24px; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:650; background:#eef2f6; }
    .status.active { color:var(--ok); background:#dafbe1; }
    .status.inactive { color:var(--muted); }
    .status.invalid { color:var(--bad); background:#ffebe9; }
    .status.rate_limited { color:var(--warn); background:#fff8c5; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:880px; }
    th, td { padding:11px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:13px; }
    th { color:var(--muted); font-weight:650; background:#fbfbfc; }
    td.actions { white-space:nowrap; }
    .muted { color:var(--muted); }
    .error { color:var(--bad); max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .message { min-height:20px; padding:0 16px 16px; color:var(--muted); font-size:13px; }
    @media (max-width: 880px) { main { grid-template-columns:1fr; padding:16px; } header { padding:20px 16px 14px; } }
  </style>
</head>
<body>
  <header>
    <h1>ChatGPT 账号池</h1>
    <p>维护 ChatGPT Web access token，供 chatgpt-web 生图任务自动选用。</p>
  </header>
  <main>
    <section>
      <div class="panel-title">账号信息</div>
      <form id="account-form">
        <input type="hidden" id="account-id">
        <label>名称<input id="label" maxlength="120" placeholder="主账号 / Plus 账号"></label>
        <label>邮箱<input id="email" maxlength="254" placeholder="name@example.com"></label>
        <label>Access token<input id="access-token" maxlength="4096" placeholder="新增必填；编辑时留空则不修改"></label>
        <div class="row">
          <label>状态<select id="status"><option value="active">active</option><option value="inactive">inactive</option><option value="invalid">invalid</option><option value="rate_limited">rate_limited</option></select></label>
          <label>剩余额度<input id="quota-remaining" type="number" min="0" placeholder="不填为未知"></label>
        </div>
        <label>额度上限<input id="quota-limit" type="number" min="0" placeholder="不填为未知"></label>
        <div class="row">
          <button class="primary" type="submit">保存</button>
          <button type="button" id="reset">清空</button>
        </div>
      </form>
      <div class="message" id="message"></div>
    </section>
    <section>
      <div class="panel-title">账号列表</div>
      <div class="toolbar">
        <input id="search" placeholder="搜索名称、邮箱、token hint">
        <select id="filter-status"><option value="">全部状态</option><option value="active">active</option><option value="inactive">inactive</option><option value="invalid">invalid</option><option value="rate_limited">rate_limited</option></select>
        <button id="refresh">刷新</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>账号</th><th>状态</th><th>Token</th><th>额度</th><th>使用</th><th>最近检查</th><th>错误</th><th>操作</th></tr></thead>
          <tbody id="accounts"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#account-form");
    const tbody = document.querySelector("#accounts");
    const msg = document.querySelector("#message");
    const fields = {
      id: document.querySelector("#account-id"),
      label: document.querySelector("#label"),
      email: document.querySelector("#email"),
      accessToken: document.querySelector("#access-token"),
      status: document.querySelector("#status"),
      quotaRemaining: document.querySelector("#quota-remaining"),
      quotaLimit: document.querySelector("#quota-limit")
    };
    let accounts = [];
    function text(value) { return value === null || value === undefined || value === "" ? "—" : String(value); }
    function setMessage(value) { msg.textContent = value || ""; }
    function formPayload() {
      const payload = {
        label: fields.label.value.trim(),
        email: fields.email.value.trim() || null,
        status: fields.status.value,
        quotaRemaining: fields.quotaRemaining.value === "" ? null : Number(fields.quotaRemaining.value),
        quotaLimit: fields.quotaLimit.value === "" ? null : Number(fields.quotaLimit.value)
      };
      if (fields.accessToken.value.trim()) payload.accessToken = fields.accessToken.value.trim();
      return payload;
    }
    async function request(path, options) {
      const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || body.message || response.statusText);
      return body;
    }
    async function loadAccounts() {
      const params = new URLSearchParams({ limit: "100" });
      const q = document.querySelector("#search").value.trim();
      const status = document.querySelector("#filter-status").value;
      if (q) params.set("q", q);
      if (status) params.set("status", status);
      const body = await request("/accounts?" + params.toString());
      accounts = body.accounts || [];
      tbody.innerHTML = accounts.map((account) => '<tr>' +
        '<td><strong>' + escapeHtml(account.label) + '</strong><div class="muted">' + escapeHtml(text(account.email)) + '</div></td>' +
        '<td><span class="status ' + account.status + '">' + account.status + '</span></td>' +
        '<td>' + escapeHtml(account.tokenHint) + '</td>' +
        '<td>' + escapeHtml(text(account.quotaRemaining)) + ' / ' + escapeHtml(text(account.quotaLimit)) + '</td>' +
        '<td>' + account.totalUses + ' 次<br><span class="muted">成功 ' + account.successCount + ' / 失败 ' + account.failureCount + '</span></td>' +
        '<td>' + escapeHtml(text(account.lastCheckedAt)) + '<br><span class="muted">使用 ' + escapeHtml(text(account.lastUsedAt)) + '</span></td>' +
        '<td class="error" title="' + escapeHtml(text(account.lastError)) + '">' + escapeHtml(text(account.lastError)) + '</td>' +
        '<td class="actions"><button data-action="edit" data-id="' + account.id + '">编辑</button> <button data-action="check" data-id="' + account.id + '">检测</button> <button class="danger" data-action="delete" data-id="' + account.id + '">删除</button></td>' +
      '</tr>').join("");
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[char]));
    }
    function resetForm() {
      fields.id.value = ""; fields.label.value = ""; fields.email.value = ""; fields.accessToken.value = ""; fields.status.value = "active"; fields.quotaRemaining.value = ""; fields.quotaLimit.value = "";
      setMessage("");
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const id = fields.id.value;
        const payload = formPayload();
        if (!id && !payload.accessToken) throw new Error("accessToken_required");
        await request(id ? "/accounts/" + id : "/accounts", { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
        resetForm();
        await loadAccounts();
        setMessage("已保存");
      } catch (error) { setMessage(error.message); }
    });
    document.querySelector("#reset").addEventListener("click", resetForm);
    document.querySelector("#refresh").addEventListener("click", () => loadAccounts().catch((error) => setMessage(error.message)));
    document.querySelector("#search").addEventListener("input", () => loadAccounts().catch((error) => setMessage(error.message)));
    document.querySelector("#filter-status").addEventListener("change", () => loadAccounts().catch((error) => setMessage(error.message)));
    tbody.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const account = accounts.find((item) => item.id === button.dataset.id);
      if (!account) return;
      try {
        if (button.dataset.action === "edit") {
          fields.id.value = account.id; fields.label.value = account.label; fields.email.value = account.email || ""; fields.accessToken.value = ""; fields.status.value = account.status; fields.quotaRemaining.value = account.quotaRemaining ?? ""; fields.quotaLimit.value = account.quotaLimit ?? "";
          setMessage("正在编辑 " + account.label);
        }
        if (button.dataset.action === "check") {
          button.disabled = true;
          await request("/accounts/" + account.id + "/check", { method: "POST", body: "{}" });
          await loadAccounts();
          setMessage("检测完成");
        }
        if (button.dataset.action === "delete" && confirm("删除账号 " + account.label + "？")) {
          await request("/accounts/" + account.id, { method: "DELETE" });
          await loadAccounts();
          setMessage("已删除");
        }
      } catch (error) { setMessage(error.message); }
      finally { button.disabled = false; }
    });
    loadAccounts().catch((error) => setMessage(error.message));
  </script>
</body>
</html>`;
  return withCors(
    new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    })
  );
}

