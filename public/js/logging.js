/*
 * VRCW - logging.js
 * Resident log console helper shared by feature modules.
 */

function logMsg(msg, type = "info", iconClass = "") {
  const el = document.getElementById("logConsole");
  if (!el) {
    console[type === 'error' ? 'error' : 'log'](typeof msg === 'string' ? msg : String(msg));
    return;
  }
  const row = document.createElement("div");
  row.className = `log-${type}`;

  const ts = document.createElement("span");
  ts.className = "log-ts";
  ts.textContent = `[${new Date().toLocaleTimeString(getLocale())}] `;
  row.appendChild(ts);

  if (iconClass) {
    const icon = document.createElement("i");
    icon.setAttribute("class", iconClass);
    icon.setAttribute("aria-hidden", "true");
    row.appendChild(icon);
    row.appendChild(document.createTextNode(" "));
  }

  const text = document.createElement("span");
  text.textContent = typeof msg === 'string' ? msg : String(msg);
  row.appendChild(text);

  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 500) el.removeChild(el.firstChild);
}

// Trusted HTML log — for Font Awesome icon markup that is entirely
// constructed from hardcoded template strings with no user input.
// callers: never pass user-controlled data through this function.
function logMsgHtml(trustedHtml, type = "info") {
  const el = document.getElementById("logConsole");
  if (!el) {
    console[type === 'error' ? 'error' : 'log']('[HTML log]');
    return;
  }
  const row = document.createElement("div");
  row.className = `log-${type}`;
  const ts = document.createElement("span");
  ts.className = "log-ts";
  ts.textContent = `[${new Date().toLocaleTimeString(getLocale())}] `;
  row.appendChild(ts);
  const body = document.createElement("span");
  body.innerHTML = trustedHtml; // only hardcoded icon+label strings
  row.appendChild(body);
  el.appendChild(row);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 500) el.removeChild(el.firstChild);
}

VRCW.registerService('logging', { log: logMsg });
VRCW.registerModule('logging', { logMsg, logMsgHtml });
renderAppVersionInfo();
