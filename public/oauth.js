if (window.opener) {
    window.opener.postMessage({ type: "opl-oauth", url: location.href }, location.origin);
    setTimeout(() => window.close(), 300);
  }
