"use strict";

// The shared navigation guard checks for drafts and active native actions first.
function dotNavigation(identity, navigationExpression) {
  return navigationExpression(identity, `
    const threadMarkers = [...document.querySelectorAll('[data-above-composer-conversation-id]')].filter((el) => visible(el.parentElement));
    const entries = nodes('[data-sidebar-destination^="builtin:orbit:"]').filter((el) =>
      !identity || el.getAttribute('data-sidebar-destination') === 'builtin:orbit:' + identity);
    const hub = nodes('[data-sidebar-destination="builtin:dot-hub"]');
    const choices = entries.length ? entries : hub.length ? hub : nodes('[data-sidebar-destination="builtin:orbit"]');
    if (!entries.length && openSidebar()) return 'sidebar_opening';
    const entry = choices.length === 1 && choices[0];
    const candidate = entry && entry.closest('button,a,[role="button"],[role="link"]');
    if (!choices.length) return 'no_dot_entry';
    if (choices.length !== 1) return 'ambiguous_dot_entry';
    if (!candidate || !visible(candidate) || candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') return 'dot_entry_unavailable';
    if (threadMarkers.length === 1) {
      const threadID = threadMarkers[0].getAttribute('data-above-composer-conversation-id');
      if (threadID) window.__prismSharedCodexThread = threadID;
    }
    candidate.click();
    return 'dot_entry_clicked';
  `);
}

module.exports = { dotNavigation };
