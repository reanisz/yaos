/**
 * Server-rendered /admin page for per-vault access tokens.
 *
 * Same house style as setupPage.ts: one self-contained document, no external
 * asset, no framework, inline CSS and JS.  A Worker response is the whole
 * deliverable, so a CDN dependency here would be a third party in the path of
 * the operator's credential management.
 *
 * # Nothing secret is rendered
 * The shell contains exactly two pieces of per-request data — the server's own
 * origin and its auth mode — and neither is a secret (GET /api/capabilities
 * already publishes both, including `strictPermissions`).  Tokens reach this
 * page only as the JSON body of an issue call the operator just made, which is
 * why the "shown once" panel is built by script and never by the renderer.  In
 * strict mode that also means the ticket signing secret cannot appear here:
 * the renderer is given a host and a mode, not a config.
 *
 * # Escaping
 * `host` is interpolated through escapeHtml.  The header copy is interpolated
 * raw and may be, because it is a compile-time constant chosen by the mode —
 * no request byte reaches it.  Everything else — vault IDs, device names and
 * labels, which are operator-controlled but still arbitrary text — is written
 * into the DOM with textContent, never innerHTML, group headings included.
 * The rule is deliberately "no data ever reaches innerHTML" rather than
 * "escape data before innerHTML": the first is checkable by reading the file,
 * the second is checkable only by proving a negative about every future edit.
 */

interface AdminPageOptions {
	host: string;
	authMode: "env" | "claim" | "unclaimed" | "strict";
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const ADMIN_PAGE_STYLE = `
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      padding: 32px 24px;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(circle at 15% 0%, rgba(123, 223, 246, 0.10), transparent 45%),
        linear-gradient(180deg, #08111d 0%, #0d1725 100%);
      color: #f4f7fb;
    }
    main { width: min(760px, 100%); margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
    h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
    p { margin: 0; line-height: 1.55; color: #a9c0d8; font-size: 14px; }
    .eyebrow {
      display: inline-block;
      border-radius: 999px;
      padding: 5px 11px;
      margin-bottom: 14px;
      background: rgba(123, 223, 246, 0.1);
      border: 1px solid rgba(123, 223, 246, 0.15);
      color: #7bdff6;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .host-badge {
      display: inline-block;
      margin-top: 12px;
      padding: 6px 12px;
      background: rgba(4, 10, 18, 0.6);
      border: 1px solid rgba(161, 205, 255, 0.1);
      border-radius: 8px;
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: #7bdff6;
      word-break: break-all;
    }
    .mode-badge {
      margin-left: 8px;
      color: #ffd08a;
    }
    .card {
      background: rgba(8, 17, 29, 0.6);
      border: 1px solid rgba(161, 205, 255, 0.14);
      border-radius: 18px;
      padding: 24px;
      margin-top: 20px;
    }
    .card > p { margin-top: 6px; }
    label { display: block; font-size: 11px; color: #6984a3; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    input[type="text"] {
      width: 100%;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #f4f7fb;
      font-size: 14px;
      padding: 11px 12px;
      border-radius: 10px;
    }
    input[type="text"]:focus { outline: 2px solid rgba(123, 223, 246, 0.5); outline-offset: 1px; }
    .field-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
    .field-row > div { flex: 1 1 220px; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 11px 18px;
      background: #f4f7fb;
      color: #08111d;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { background: #ffffff; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    button.ghost {
      background: rgba(255, 255, 255, 0.05);
      color: #f4f7fb;
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 8px 12px;
      font-size: 13px;
    }
    button.ghost:hover { background: rgba(255, 255, 255, 0.1); }
    button.danger { color: #ffb4b4; border-color: rgba(255, 107, 107, 0.35); }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { text-align: left; padding: 10px 8px; font-size: 13px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
    th { color: #6984a3; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
    td.vault { font-family: ui-monospace, monospace; color: #7bdff6; word-break: break-all; }
    td.actions { text-align: right; white-space: nowrap; }
    .muted { color: #6984a3; font-size: 13px; }
    .notice {
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.5;
      background: rgba(255, 197, 90, 0.08);
      border: 1px solid rgba(255, 197, 90, 0.25);
      color: #ffd79a;
    }
    .error { color: #ff9b9b; font-size: 13px; margin-top: 12px; min-height: 18px; }
    .token-panel { display: none; margin-top: 18px; }
    .token-panel.show { display: block; }
    .token-value {
      display: block;
      width: 100%;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid rgba(123, 223, 246, 0.3);
      border-radius: 10px;
      padding: 12px;
      color: #7bdff6;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      word-break: break-all;
    }
    .token-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; align-items: center; }
    .token-actions a {
      display: inline-flex;
      align-items: center;
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #f4f7fb;
    }
    .qr { margin-top: 16px; background: #fff; padding: 8px; border-radius: 12px; display: none; width: 152px; }
    .qr.show { display: block; }
    .qr img { display: block; width: 136px; height: 136px; }
    .banner {
      margin-bottom: 18px;
      padding: 14px 16px;
      border-radius: 12px;
      background: rgba(123, 223, 246, 0.07);
      border: 1px solid rgba(123, 223, 246, 0.28);
      color: #cfeffa;
      font-size: 13px;
      line-height: 1.55;
    }
    .banner strong { color: #7bdff6; }
    .vault-group { margin-top: 22px; }
    .vault-group:first-of-type { margin-top: 8px; }
    .vault-group > h3 {
      margin: 0 0 2px;
      font-family: ui-monospace, monospace;
      font-size: 13px;
      font-weight: 600;
      color: #7bdff6;
      word-break: break-all;
    }
    .vault-group > .count { color: #6984a3; font-size: 12px; }
    .vault-group table { margin-top: 8px; }
    td.device { font-weight: 600; }
    @media (max-width: 620px) {
      body { padding: 20px 14px; }
      .card { padding: 18px; }
      td.actions { text-align: left; }
    }`;

/** The management UI, rendered only when the server is in claim mode. */
const ADMIN_APP_MARKUP = `
    <section class="card">
      <h2>Issue or rotate a token</h2>
      <p>Issuing for a vault that already has a token replaces it. The previous token stops working once the config cache turns over (up to 60 seconds).</p>
      <form id="issue-form" style="margin-top:18px">
        <div class="field-row">
          <div>
            <label for="vault-id">Vault ID</label>
            <input id="vault-id" type="text" autocomplete="off" spellcheck="false" required minlength="8" maxlength="256" placeholder="the vault's ID from the plugin settings" />
          </div>
          <div>
            <label for="token-label">Label (optional)</label>
            <input id="token-label" type="text" autocomplete="off" maxlength="64" placeholder="work laptop" />
          </div>
        </div>
        <button id="issue-button" type="submit">Issue token</button>
      </form>
      <div id="issue-error" class="error" aria-live="polite"></div>

      <div id="token-panel" class="token-panel">
        <div class="notice">This token is shown once. Copy it now — the server keeps only its hash and cannot show it again. Issue a new one if you lose it.</div>
        <div style="margin-top:14px">
          <label for="token-output">New token for <span id="token-vault"></span></label>
          <code id="token-output" class="token-value"></code>
        </div>
        <div class="token-actions">
          <button id="copy-token" class="ghost" type="button">Copy token</button>
          <a id="obsidian-link" href="#">Open in Obsidian</a>
          <span id="qr-note" class="muted"></span>
        </div>
        <div id="qr" class="qr" aria-label="YAOS mobile setup QR"></div>
      </div>
    </section>

    <section class="card">
      <h2>Existing vault tokens</h2>
      <p>One token per vault. Revoking removes it; the vault stays syncable with the global operator token.</p>
      <div id="list-error" class="error" aria-live="polite"></div>
      <div id="list-empty" class="muted" style="margin-top:14px">Loading…</div>
      <table id="token-table" style="display:none">
        <thead>
          <tr><th>Vault ID</th><th>Label</th><th>Issued</th><th></th></tr>
        </thead>
        <tbody id="token-rows"></tbody>
      </table>
    </section>`;

/**
 * The strict-mode management UI.
 *
 * Two differences from the claim-mode markup above, both of them the mode:
 * the device name is REQUIRED (it is the only handle for deciding which of a
 * vault's tokens to revoke), and issuing ADDS a token rather than replacing
 * one, so the copy says so and there is no rotation warning to give.
 */
const ADMIN_STRICT_MARKUP = `
    <div class="banner">
      <strong>Strict permissions mode is active.</strong>
      There is no server-wide token on this deployment: the claim flow is closed and
      <code>SYNC_TOKEN</code> is ignored. A vault is opened only by one of its own device
      tokens, issued here. This page works whether or not the server was ever claimed.
    </div>

    <section class="card">
      <h2>Issue a device token</h2>
      <p>Each token opens exactly one vault, from one device. Issuing another for the same vault adds it — nothing already in use stops working. Give every device its own token: sharing one across devices means revoking it logs all of them out.</p>
      <form id="issue-form" style="margin-top:18px">
        <div class="field-row">
          <div>
            <label for="vault-id">Vault ID</label>
            <input id="vault-id" type="text" autocomplete="off" spellcheck="false" required minlength="8" maxlength="256" placeholder="the vault's ID from the plugin settings" />
          </div>
          <div>
            <label for="token-label">Device name (required)</label>
            <input id="token-label" type="text" autocomplete="off" required maxlength="64" placeholder="work laptop" />
          </div>
        </div>
        <button id="issue-button" type="submit">Issue token</button>
      </form>
      <div id="issue-error" class="error" aria-live="polite"></div>

      <div id="token-panel" class="token-panel">
        <div class="notice">This token is shown once. Copy it now — the server keeps only its hash and cannot show it again. Issue a new one if you lose it.</div>
        <div style="margin-top:14px">
          <label for="token-output">New token for <span id="token-vault"></span></label>
          <code id="token-output" class="token-value"></code>
        </div>
        <div class="token-actions">
          <button id="copy-token" class="ghost" type="button">Copy token</button>
          <a id="obsidian-link" href="#">Open in Obsidian</a>
          <span id="qr-note" class="muted"></span>
        </div>
        <div id="qr" class="qr" aria-label="YAOS mobile setup QR"></div>
      </div>
    </section>

    <section class="card">
      <h2>Device tokens by vault</h2>
      <p>Revoking one device leaves every other device on that vault connected. A revoked token stops working once the config cache turns over (up to 60 seconds).</p>
      <div id="list-error" class="error" aria-live="polite"></div>
      <div id="list-empty" class="muted" style="margin-top:14px">Loading…</div>
      <div id="vault-groups"></div>
    </section>`;

/**
 * Client script for the strict-mode UI.
 *
 * Same discipline as the claim-mode script below: string concatenation rather
 * than template literals (this whole value is itself inside one), and no data
 * ever reaches innerHTML — every vault ID and device name is written with
 * textContent, including the group headings, which are built element by element
 * for exactly that reason.
 */
const ADMIN_STRICT_SCRIPT = `
    const issueForm = document.getElementById("issue-form");
    const issueButton = document.getElementById("issue-button");
    const vaultInput = document.getElementById("vault-id");
    const labelInput = document.getElementById("token-label");
    const issueError = document.getElementById("issue-error");
    const tokenPanel = document.getElementById("token-panel");
    const tokenOutput = document.getElementById("token-output");
    const tokenVault = document.getElementById("token-vault");
    const copyButton = document.getElementById("copy-token");
    const obsidianLink = document.getElementById("obsidian-link");
    const qrEl = document.getElementById("qr");
    const qrNote = document.getElementById("qr-note");
    const listError = document.getElementById("list-error");
    const listEmpty = document.getElementById("list-empty");
    const groups = document.getElementById("vault-groups");

    async function callApi(path, body) {
      const init = body === undefined
        ? { method: "GET", headers: { "Accept": "application/json" } }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      const res = await fetch(path, init);
      let data = null;
      try { data = await res.json(); } catch (err) { data = null; }
      if (!res.ok) {
        const reason = data && typeof data.error === "string" ? data.error : "request failed (" + res.status + ")";
        throw new Error(reason);
      }
      return data;
    }

    function formatDate(value) {
      if (typeof value !== "number" || !isFinite(value)) return "unknown";
      const date = new Date(value);
      return isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
    }

    function cell(text, className) {
      const td = document.createElement("td");
      if (className) td.className = className;
      td.textContent = text;
      return td;
    }

    function renderRow(entry) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(String(entry.label), "device"));
      tr.appendChild(cell(formatDate(entry.createdAt)));

      const actions = document.createElement("td");
      actions.className = "actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost danger";
      button.textContent = "Revoke";
      button.addEventListener("click", async () => {
        if (button.dataset.confirming !== "yes") {
          button.dataset.confirming = "yes";
          button.textContent = "Confirm revoke";
          setTimeout(() => {
            if (button.dataset.confirming !== "yes") return;
            button.dataset.confirming = "no";
            button.textContent = "Revoke";
          }, 5000);
          return;
        }
        button.disabled = true;
        button.textContent = "Revoking…";
        try {
          await callApi("/admin/api/vault-tokens/revoke", { tokenId: entry.tokenId });
          await loadTokens();
        } catch (err) {
          listError.textContent = err.message;
          button.disabled = false;
          button.dataset.confirming = "no";
          button.textContent = "Revoke";
        }
      });
      actions.appendChild(button);
      tr.appendChild(actions);
      return tr;
    }

    /** One section per vault. The heading is textContent — never innerHTML. */
    function renderGroup(vaultId, entries) {
      const section = document.createElement("div");
      section.className = "vault-group";

      const heading = document.createElement("h3");
      heading.textContent = vaultId;
      section.appendChild(heading);

      const count = document.createElement("div");
      count.className = "count";
      count.textContent = entries.length === 1 ? "1 device" : entries.length + " devices";
      section.appendChild(count);

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const title of ["Device", "Issued", ""]) {
        const th = document.createElement("th");
        th.textContent = title;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const entry of entries) tbody.appendChild(renderRow(entry));
      table.appendChild(tbody);
      section.appendChild(table);
      return section;
    }

    async function loadTokens() {
      listError.textContent = "";
      try {
        const data = await callApi("/admin/api/vault-tokens");
        const entries = Array.isArray(data && data.vaultTokens) ? data.vaultTokens : [];
        // The server sorts by vaultId, so a Map preserves grouping order.
        const byVault = new Map();
        for (const entry of entries) {
          const vaultId = String(entry.vaultId);
          if (!byVault.has(vaultId)) byVault.set(vaultId, []);
          byVault.get(vaultId).push(entry);
        }
        groups.replaceChildren();
        for (const [vaultId, vaultEntries] of byVault) {
          groups.appendChild(renderGroup(vaultId, vaultEntries));
        }
        listEmpty.style.display = entries.length > 0 ? "none" : "block";
        listEmpty.textContent = "No device tokens yet. Issue one above to onboard a device.";
      } catch (err) {
        groups.replaceChildren();
        listEmpty.style.display = "none";
        listError.textContent = err.message;
      }
    }

    function showIssued(data) {
      tokenVault.textContent = String(data.vaultId) + " · " + String(data.label);
      tokenOutput.textContent = String(data.token);

      const link = typeof data.obsidianUrl === "string" ? data.obsidianUrl : "";
      if (link.indexOf("obsidian://") === 0) {
        obsidianLink.href = link;
        obsidianLink.style.display = "inline-flex";
      } else {
        obsidianLink.removeAttribute("href");
        obsidianLink.style.display = "none";
      }

      qrEl.replaceChildren();
      const qr = typeof data.mobileSetupQrDataUrl === "string" ? data.mobileSetupQrDataUrl : "";
      if (qr.indexOf("data:image/svg+xml;base64,") === 0) {
        const image = document.createElement("img");
        image.src = qr;
        image.alt = "YAOS mobile setup QR";
        qrEl.appendChild(image);
        qrEl.classList.add("show");
        qrNote.textContent = "Scan on a phone to finish mobile setup.";
      } else {
        qrEl.classList.remove("show");
        qrNote.textContent = "QR rendering unavailable — use the link or copy the token.";
      }
      tokenPanel.classList.add("show");
    }

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(tokenOutput.textContent || "");
        copyButton.textContent = "Copied!";
        setTimeout(() => { copyButton.textContent = "Copy token"; }, 2000);
      } catch (err) {
        copyButton.textContent = "Copy failed — select it manually";
      }
    });

    issueForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      issueError.textContent = "";
      const vaultId = vaultInput.value.trim();
      const label = labelInput.value.trim();
      if (vaultId.length < 8) {
        issueError.textContent = "A vault ID is at least 8 characters.";
        return;
      }
      if (label.length === 0) {
        issueError.textContent = "A device name is required — it is how you tell this token from the vault's others.";
        return;
      }
      issueButton.disabled = true;
      issueButton.textContent = "Issuing…";
      try {
        const data = await callApi("/admin/api/vault-tokens", { vaultId: vaultId, label: label });
        showIssued(data);
        labelInput.value = "";
        await loadTokens();
      } catch (err) {
        issueError.textContent = err.message;
      } finally {
        issueButton.disabled = false;
        issueButton.textContent = "Issue token";
      }
    });

    loadTokens();`;

/**
 * Client script for the claim-mode UI.
 *
 * Written with string concatenation rather than template literals because the
 * whole thing is itself inside a template literal — an unescaped interpolation
 * here would be evaluated by the Worker at render time, which is exactly the
 * mistake that turns a page into a template injection.
 */
const ADMIN_APP_SCRIPT = `
    const issueForm = document.getElementById("issue-form");
    const issueButton = document.getElementById("issue-button");
    const vaultInput = document.getElementById("vault-id");
    const labelInput = document.getElementById("token-label");
    const issueError = document.getElementById("issue-error");
    const tokenPanel = document.getElementById("token-panel");
    const tokenOutput = document.getElementById("token-output");
    const tokenVault = document.getElementById("token-vault");
    const copyButton = document.getElementById("copy-token");
    const obsidianLink = document.getElementById("obsidian-link");
    const qrEl = document.getElementById("qr");
    const qrNote = document.getElementById("qr-note");
    const listError = document.getElementById("list-error");
    const listEmpty = document.getElementById("list-empty");
    const table = document.getElementById("token-table");
    const rows = document.getElementById("token-rows");

    /** Vault IDs that currently hold a token — drives the rotation warning. */
    let knownVaults = new Set();

    async function callApi(path, body) {
      const init = body === undefined
        ? { method: "GET", headers: { "Accept": "application/json" } }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      const res = await fetch(path, init);
      let data = null;
      try { data = await res.json(); } catch (err) { data = null; }
      if (!res.ok) {
        const reason = data && typeof data.error === "string" ? data.error : "request failed (" + res.status + ")";
        throw new Error(reason);
      }
      return data;
    }

    function formatDate(value) {
      if (typeof value !== "number" || !isFinite(value)) return "unknown";
      const date = new Date(value);
      return isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
    }

    function cell(text, className) {
      const td = document.createElement("td");
      if (className) td.className = className;
      td.textContent = text;
      return td;
    }

    function renderRow(entry) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(String(entry.vaultId), "vault"));
      tr.appendChild(cell(entry.label ? String(entry.label) : "—"));
      tr.appendChild(cell(formatDate(entry.createdAt)));

      const actions = document.createElement("td");
      actions.className = "actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost danger";
      button.textContent = "Revoke";
      button.addEventListener("click", async () => {
        if (button.dataset.confirming !== "yes") {
          button.dataset.confirming = "yes";
          button.textContent = "Confirm revoke";
          setTimeout(() => {
            if (button.dataset.confirming !== "yes") return;
            button.dataset.confirming = "no";
            button.textContent = "Revoke";
          }, 5000);
          return;
        }
        button.disabled = true;
        button.textContent = "Revoking…";
        try {
          await callApi("/admin/api/vault-tokens/revoke", { vaultId: entry.vaultId });
          await loadTokens();
        } catch (err) {
          listError.textContent = err.message;
          button.disabled = false;
          button.dataset.confirming = "no";
          button.textContent = "Revoke";
        }
      });
      actions.appendChild(button);
      tr.appendChild(actions);
      return tr;
    }

    async function loadTokens() {
      listError.textContent = "";
      try {
        const data = await callApi("/admin/api/vault-tokens");
        const entries = Array.isArray(data && data.vaultTokens) ? data.vaultTokens : [];
        knownVaults = new Set(entries.map((entry) => String(entry.vaultId)));
        rows.replaceChildren();
        for (const entry of entries) rows.appendChild(renderRow(entry));
        table.style.display = entries.length > 0 ? "table" : "none";
        listEmpty.style.display = entries.length > 0 ? "none" : "block";
        listEmpty.textContent = "No vault tokens yet.";
      } catch (err) {
        table.style.display = "none";
        listEmpty.style.display = "none";
        listError.textContent = err.message;
      }
    }

    function showIssued(data) {
      tokenVault.textContent = String(data.vaultId);
      tokenOutput.textContent = String(data.token);

      const link = typeof data.obsidianUrl === "string" ? data.obsidianUrl : "";
      if (link.indexOf("obsidian://") === 0) {
        obsidianLink.href = link;
        obsidianLink.style.display = "inline-flex";
      } else {
        obsidianLink.removeAttribute("href");
        obsidianLink.style.display = "none";
      }

      qrEl.replaceChildren();
      const qr = typeof data.mobileSetupQrDataUrl === "string" ? data.mobileSetupQrDataUrl : "";
      if (qr.indexOf("data:image/svg+xml;base64,") === 0) {
        const image = document.createElement("img");
        image.src = qr;
        image.alt = "YAOS mobile setup QR";
        qrEl.appendChild(image);
        qrEl.classList.add("show");
        qrNote.textContent = "Scan on a phone to finish mobile setup.";
      } else {
        qrEl.classList.remove("show");
        qrNote.textContent = "QR rendering unavailable — use the link or copy the token.";
      }
      tokenPanel.classList.add("show");
    }

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(tokenOutput.textContent || "");
        copyButton.textContent = "Copied!";
        setTimeout(() => { copyButton.textContent = "Copy token"; }, 2000);
      } catch (err) {
        copyButton.textContent = "Copy failed — select it manually";
      }
    });

    issueForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      issueError.textContent = "";
      const vaultId = vaultInput.value.trim();
      const label = labelInput.value.trim();
      if (vaultId.length < 8) {
        issueError.textContent = "A vault ID is at least 8 characters.";
        return;
      }
      if (knownVaults.has(vaultId)) {
        const proceed = window.confirm(
          "This vault already has a token. Issuing a new one replaces it, and the old token stops working. Continue?"
        );
        if (!proceed) return;
      }
      issueButton.disabled = true;
      issueButton.textContent = "Issuing…";
      try {
        const body = label ? { vaultId: vaultId, label: label } : { vaultId: vaultId };
        const data = await callApi("/admin/api/vault-tokens", body);
        showIssued(data);
        labelInput.value = "";
        await loadTokens();
      } catch (err) {
        issueError.textContent = err.message;
      } finally {
        issueButton.disabled = false;
        issueButton.textContent = "Issue token";
      }
    });

    loadTokens();`;

/**
 * Explanation shown instead of the UI when this server cannot hold vault
 * tokens.  Both cases are real operator situations, and a broken form would be
 * a worse answer than a sentence saying why there is none.
 */
function renderUnavailableState(authMode: "env" | "unclaimed"): string {
	const body = authMode === "unclaimed"
		? `<h2>This server is not claimed yet</h2>
      <p>Vault tokens are issued against a claimed server. Open the server's home page, claim it to create the operator token, then come back here.</p>`
		: `<h2>Vault tokens are unavailable in environment-token mode</h2>
      <p>This deployment authenticates with the <code>SYNC_TOKEN</code> environment variable. That mode makes no Durable Object call per request by design, and the vault-token map lives in the config Durable Object — so honouring per-vault tokens here would put a config read back on every authenticated request.</p>
      <p style="margin-top:10px">To use per-vault tokens, remove <code>SYNC_TOKEN</code> and claim the server through its home page instead. The environment token keeps opening every vault until you do.</p>`;
	return `
    <section class="card">
      ${body}
    </section>`;
}

/**
 * Human-readable label for the server's current auth mode, shown as a badge in
 * the header so an operator can tell at a glance which regime this deployment
 * is running — strict is visually loud elsewhere, but the other three were
 * previously only implied by which UI happened to render.
 *
 * Compile-time constants chosen by the mode; nothing here is user input, so no
 * escaping is required (same reasoning as the markup blocks above).
 */
function modeLabel(authMode: AdminPageOptions["authMode"]): string {
	switch (authMode) {
		case "strict": return "strict permissions";
		case "claim": return "standard (claimed)";
		case "env": return "environment token";
		case "unclaimed": return "standard (unclaimed)";
	}
}

/** Header copy.  Strict mode manages devices; claim mode manages vaults. */
function renderHeaderCopy(authMode: AdminPageOptions["authMode"]): { title: string; blurb: string } {
	if (authMode === "strict") {
		return {
			title: "Device access tokens",
			blurb: "Issue and revoke the per-device tokens for this sync server. "
				+ "This page is reachable only through your Cloudflare Access policy, "
				+ "and it is the only way to issue a credential on this deployment.",
		};
	}
	return {
		title: "Vault access tokens",
		blurb: "Issue, rotate and revoke the per-vault tokens for this sync server. "
			+ "This page is reachable only through your Cloudflare Access policy.",
	};
}

export function renderAdminPage(options: AdminPageOptions): string {
	const safeHost = escapeHtml(options.host);
	// A script is emitted only for the two modes that have a UI for it to drive.
	// In env mode and on an unclaimed non-strict server there is none, and
	// shipping one would have the page fire an API call it already knows will be
	// refused.  Strict mode is deliberately NOT gated on the claim state: /admin
	// is the only surface that can issue a strict token, so a never-claimed
	// strict server must render the full form.
	const body = options.authMode === "strict"
		? ADMIN_STRICT_MARKUP
		: options.authMode === "claim"
			? ADMIN_APP_MARKUP
			: renderUnavailableState(options.authMode);
	const script = options.authMode === "strict"
		? `\n  <script>${ADMIN_STRICT_SCRIPT}\n  </script>`
		: options.authMode === "claim"
			? `\n  <script>${ADMIN_APP_SCRIPT}\n  </script>`
			: "";
	const { title, blurb } = renderHeaderCopy(options.authMode);

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>YAOS Admin</title>
  <style>${ADMIN_PAGE_STYLE}
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Cloudflare Access</div>
      <h1>${title}</h1>
      <p>${blurb}</p>
      <div class="host-badge">${safeHost}</div>
      <div class="host-badge mode-badge">mode: ${modeLabel(options.authMode)}</div>
    </header>
${body}
  </main>${script}
</body>
</html>`;
}
