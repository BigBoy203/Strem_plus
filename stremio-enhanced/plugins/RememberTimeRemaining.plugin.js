/**
 * @name RememberTimeRemaining
 * @description Remembers whether the player's end time shows the total length or the time remaining (click the end time to switch), and restores that choice every time the player opens.
 * @updateUrl https://raw.githubusercontent.com/BigBoy203/Strem_plus/main/stremio-enhanced/plugins/RememberTimeRemaining.plugin.js
 * @source https://github.com/BigBoy203/Strem_plus
 * @version 1.0.0
 * @author kingkiller6203
 */

(() => {
    const STORE_KEY = "rememberTimeRemaining.mode"; // "remaining" | "total"
    const BUTTON_SELECTOR = '[class*="seek-bar-container-"] [class*="button-container-"]';

    // Stremio's own toggle lives in React state, so it resets to "total" on every player mount.
    // Remaining time is rendered with a minus sign; total length never has one.
    const isRemaining = (button) => (button.textContent || "").includes("-");

    const savedMode = () => {
        try { return localStorage.getItem(STORE_KEY) || "total"; } catch (_) { return "total"; }
    };

    // Record the user's choice after Stremio has re-rendered the label.
    document.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        const button = e.target.closest && e.target.closest(BUTTON_SELECTOR);
        if (!button) return;
        setTimeout(() => {
            try { localStorage.setItem(STORE_KEY, isRemaining(button) ? "remaining" : "total"); } catch (_) {}
        }, 50);
    }, true);

    // Each new player mount creates a fresh button: flip it once if it doesn't match the saved mode.
    const restore = () => {
        const button = document.querySelector(BUTTON_SELECTOR);
        if (!button || button.dataset.rtrApplied) return;
        if (!/\d/.test(button.textContent || "")) return; // label not filled in yet
        button.dataset.rtrApplied = "1";
        if ((savedMode() === "remaining") !== isRemaining(button)) button.click();
    };

    new MutationObserver(restore).observe(document.body, { childList: true, subtree: true });
    restore();
})();
