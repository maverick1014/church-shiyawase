/**
 * Put a string on the clipboard, and say whether it landed.
 *
 * Every "copy this link" button in the app went through
 * `navigator.clipboard?.writeText(...)` directly. That optional chain is the
 * problem: where the async Clipboard API does not exist — an in-app browser, a
 * page not served over a secure context — the whole expression is `undefined`,
 * the `.then()` never runs, and the button does nothing at all. No copy, and no
 * message either, which reads as a broken button rather than an unsupported
 * one.
 *
 * So: try the async API, fall back to a hidden textarea + `execCommand('copy')`
 * (deprecated, still the only thing those browsers have), and return a boolean
 * the caller can turn into a message. Nothing here throws — a copy that failed
 * is an answer, not an error.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied or unavailable — the fallback below may still work.
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen but focusable, and `position: fixed` so selecting it cannot
    // scroll the page out from under the button that was just tapped.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
