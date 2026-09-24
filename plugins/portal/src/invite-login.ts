import { createHash } from "node:crypto";

export const INVITE_LOGIN_SCRIPT = `(function () {
  var token = new URLSearchParams(location.hash.slice(1)).get("token");
  history.replaceState(null, "", location.pathname);
  if (token && token.length <= 4096) {
    try {
      var payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      var claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), function(c) { return c.charCodeAt(0); })));
      if (typeof claims.email !== "string") throw new Error();
      document.getElementById("invite-status").textContent = "Sign in as " + claims.email;
    } catch (e) { return; }
    document.getElementById("invite-token").value = token;
    document.getElementById("invite-confirm").disabled = false;
  } else {
    document.getElementById("invite-status").textContent = "This invitation is missing or invalid. Ask your administrator for a new one.";
  }
})();`;
export const INVITE_LOGIN_SCRIPT_HASH = `sha256-${createHash("sha256").update(INVITE_LOGIN_SCRIPT).digest("base64")}`;
