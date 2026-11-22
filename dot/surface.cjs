"use strict";

// This function runs in the selected ChatGPT renderer. Keep its assumptions
// local so a changed desktop surface disables Dot without affecting Codex.
function dotSurface(command, expected = {}, input = {}) {
  const own = (object, key) => object == null ? undefined : Object.getOwnPropertyDescriptor(object, key)?.value;
  const str = (value) => typeof value === "string" ? value : "";
  const visible = (element) => Boolean(element && (element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true) &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length);
  const query = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const unique = (items) => items.length === 1 ? items[0] : null;
  const norm = (value) => str(value).replace(/\r\n?/g, "\n").trim();
  const roles = new Set(["user", "assistant", "system"]);
  const bindingFailure = (stage) => command === "bind_status" ? { stage } : null;

  function committedFiber(element) {
    const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
    const fiber = key && own(element, key);
    const alternate = own(fiber, "alternate");
    if (!alternate) return fiber;
    const committedProps = own(element, "__reactProps$" + key.slice("__reactFiber$".length));
    if (committedProps && (own(fiber, "memoizedProps") === committedProps) !== (own(alternate, "memoizedProps") === committedProps)) {
      return own(fiber, "memoizedProps") === committedProps ? fiber : alternate;
    }
    let first = fiber;
    let second = alternate;
    for (let depth = 0; depth < 2048; depth += 1) {
      const parent = own(first, "return");
      if (!parent) {
        const root = own(own(first, "stateNode"), "current");
        return root === first ? fiber : root === second ? alternate : null;
      }
      const other = own(parent, "alternate");
      if (!other) {
        first = second = own(parent, "return");
        if (!first) return null;
        continue;
      }
      if (own(parent, "child") === own(other, "child")) {
        for (let child = own(parent, "child"), count = 0; child && count < 2000; child = own(child, "sibling"), count += 1) {
          if (child === first) return fiber;
          if (child === second) return alternate;
        }
        return null;
      }
      if (own(first, "return") !== own(second, "return")) {
        first = parent;
        second = other;
        continue;
      }
      let found = false;
      for (const branch of [parent, other]) {
        for (let child = own(branch, "child"), count = 0; child && count < 2000; child = own(child, "sibling"), count += 1) {
          if (child === first || child === second) {
            const match = child === first;
            first = match ? branch : own(branch, "alternate");
            second = match ? own(branch, "alternate") : branch;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found || own(first, "alternate") !== second) return null;
    }
    return null;
  }

  function lineage(element) {
    if (!element) return [];
    const fibers = [];
    for (let node = committedFiber(element); node && fibers.length < 64; node = own(node, "return")) {
      const props = own(node, "memoizedProps");
      if (props) fibers.push({ node, props });
    }
    return fibers;
  }

  function memoValues(node) {
    const entries = own(own(own(node, "updateQueue"), "memoCache"), "data");
    return Array.isArray(entries) ? entries.filter(Array.isArray) : [];
  }

  const sidebar = query(document, '[data-sidebar-destination^="builtin:orbit:"][aria-current="page"]');
  const portraits = query(document, "[data-dot-chat-portrait]");
  const markerIDs = new Set([
    ...sidebar.map((node) => str(node.getAttribute("data-sidebar-destination")).slice("builtin:orbit:".length)),
    ...portraits.map((node) => str(node.getAttribute("data-dot-chat-portrait"))),
  ].filter(Boolean));
  if (markerIDs.size > 1) return bindingFailure("conflicting_dot_markers");

  const scroller = unique(query(document, '.messaging-root [data-role="messages-scroll"]'));
  const fallbackComposer = scroller ? null
    : unique(query(document, '.messaging-root [data-codex-composer-root]')) ||
      unique(query(document, '.messaging-root [data-role="composer"]'));
  const roomRoot = (scroller || fallbackComposer)?.closest(".messaging-root");
  if (!roomRoot) return bindingFailure("no_visible_conversation");
  const list = unique(query(scroller || roomRoot, ".message-list"));
  if (!scroller && !list) return bindingFailure("no_visible_transcript");
  const owners = [...lineage(scroller || list), ...lineage(fallbackComposer)];
  // The Dot profile portrait and sidebar may both be absent. In that layout,
  // only a committed, active Orbit owner can provide the native identity.
  const scopes = owners.flatMap((owner) => {
    const { props } = owner;
    const orbitID = str(own(props, "orbitId"));
    const dotID = str(own(props, "dotId"));
    const roomID = str(own(props, "roomId"));
    const conversationID = str(own(props, "conversationId"));
    if (!roomID || !(orbitID || dotID)) return [];
    return [{ owner, dotID: orbitID || dotID, roomID, conversationID, conflict: Boolean(orbitID && dotID && orbitID !== dotID) }];
  });
  const orbitScopes = scopes.filter(({ owner, conversationID }) =>
    own(owner.props, "isOrbit") === true && own(owner.props, "active") !== false && conversationID);
  const orbit = orbitScopes[0];
  if (orbit && orbitScopes.some((candidate) => candidate.conflict ||
    candidate.dotID !== orbit.dotID || candidate.roomID !== orbit.roomID || candidate.conversationID !== orbit.conversationID)) return bindingFailure("conflicting_native_conversations");
  const dotID = markerIDs.values().next().value || orbit?.dotID;
  if (!dotID) return bindingFailure("no_native_dot_identity");
  if ((orbit && orbit.dotID !== dotID) || (expected.dotID && expected.dotID !== dotID)) return bindingFailure("conflicting_dot_markers");

  const nativeRooms = owners.flatMap((owner) => {
    const room = own(owner.props, "room");
    const roomID = str(own(room, "id"));
    const roomDotID = str(own(room, "aeon_id"));
    return roomID && roomDotID ? [{ owner, room, roomID, dotID: roomDotID }] : [];
  });
  const nativeOwners = nativeRooms.filter((entry) => entry.dotID === dotID && own(entry.owner.props, "roomId") === entry.roomID);
  const matchingScopes = scopes.filter((entry) => !entry.conflict && entry.dotID === dotID && entry.conversationID);
  const ownership = orbit ? [orbit] : nativeOwners.length ? nativeOwners : matchingScopes;
  const roomID = unique([...new Set(ownership.map((entry) => entry.roomID))]);
  if (!ownership.length) return bindingFailure("no_native_room_owner");
  if (!roomID) return bindingFailure("ambiguous_native_room");
  if (expected.roomID && expected.roomID !== roomID) return bindingFailure("different_room");
  if (nativeOwners.some((entry) => entry.roomID !== roomID)) return bindingFailure("conflicting_room_ids");
  if (nativeRooms.some((entry) => entry.roomID === roomID && entry.dotID !== dotID)) return bindingFailure("conflicting_room_dot");
  const nativeOwner = nativeOwners[0];
  const owner = nativeOwner?.owner || ownership[0]?.owner;
  if (!owner) return bindingFailure("no_matching_native_room");
  const room = nativeOwner?.room;
  const nativeScope = orbit?.owner || matchingScopes.find((entry) => entry.roomID === roomID)?.owner;
  const workspace = str(own(room, "account_id")) || str(own(nativeScope?.props, "accountId"));
  if (expected.workspace !== undefined && expected.workspace !== workspace) return bindingFailure("different_workspace");
  if (command === "bind_status") return { dotID, roomID, workspace };

  const editorSelector = '[contenteditable="true"], [contenteditable="plaintext-only"], textarea';
  const pane = roomRoot.closest("main.thread-pane");
  const paneComposer = (selector) => pane && unique(query(pane, ".conversation-footer " + selector)
    .filter((node) => node.closest("main.thread-pane") === pane));
  const composer = unique(query(roomRoot, '[data-role="composer"]')) ||
    unique(query(roomRoot, "[data-codex-composer-root]")) ||
    paneComposer('[data-role="composer"]') || paneComposer("[data-codex-composer-root]");
  const editor = composer && unique(query(composer, editorSelector)
    .filter((node) => !node.closest('[aria-disabled="true"], [contenteditable="false"]') && !node.disabled && !node.readOnly));
  const mainEditor = !visible(composer?.querySelector('[data-action="clear-reply"]')) && editor;

  function sendButton() {
    if (!composer) return null;
    return unique(query(composer, 'button').filter((button) => {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
      return button.hasAttribute("data-composer-submit") || button.id === "composer-submit-button" ||
        /^(?:send|send message(?: \(enter\))?|发送|发送消息(?:[（(]Enter[）)])?)$/iu.test(button.getAttribute("aria-label") || "");
    }));
  }

  const indicator = list?.querySelector(':scope > .typing-indicator[data-visible="true"][data-dot-typing]');
  const typing = Boolean(indicator && visible(indicator));
  const identity = { dotID, roomID, workspace, canSend: Boolean(mainEditor), typing };
  if (command === "inspect_status") return identity;

  const viewport = own(owner.props, "viewportState");
  const readViewport = own(viewport, "getSnapshot");
  const thread = own(owner.props, "thread") || (typeof readViewport === "function" ? readViewport.call(viewport) : null);

  if (["fill", "preflight", "send", "restore_draft"].includes(command)) {
    if (!mainEditor) return { stage: "editor_unavailable" };
    const readDraft = () => editor.value ?? editor.innerText ?? editor.textContent ?? "";
    const focused = () => editor === document.activeElement || editor.contains(document.activeElement);
    const hasAttachments = () => query(composer, ".composer-attachment-surface").length > 0 ||
      [...composer.querySelectorAll('input[type="file"]')].some((node) => node.files?.length);

    function writeDraft(text, replacing) {
      editor.focus({ preventScroll: true });
      if (!focused()) return { stage: "editor_not_focused" };
      if (replacing) {
        if (editor.value != null) {
          editor.select();
        } else {
          const selection = document.getSelection();
          if (!selection) return { stage: "editor_not_focused" };
          const range = document.createRange();
          range.selectNodeContents(editor);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      if (!text) return document.execCommand("delete") || { stage: "insertion_rejected" };
      if (editor.value == null && text.includes("\n")) {
        // A single escaped fragment keeps blank lines and sends one input event.
        const literal = document.createElement("span");
        literal.textContent = text;
        return document.execCommand("insertHTML", false, literal.innerHTML.replaceAll("\n", "<br>")) ||
          { stage: "insertion_rejected" };
      }
      return document.execCommand("insertText", false, text) || { stage: "insertion_rejected" };
    }

    const draft = readDraft();
    if (command === "restore_draft") {
      if (draft === input.previousDraft) return "restored";
      // Once submission was attempted, wait for the composer to clear before
      // restoring. Any unrelated edit takes precedence over the saved draft.
      if (hasAttachments() || (norm(draft) && draft !== input.writtenDraft)) return "changed";
      if (input.submitted && norm(draft)) return "pending";
      return writeDraft(input.previousDraft, Boolean(draft)) === true ? "restored" : "unavailable";
    }
    if (typing) return { stage: "reply_in_progress" };
    if (hasAttachments()) return { stage: "draft_attachments" };
    if (command === "fill") {
      const result = writeDraft(input.text, Boolean(norm(draft)));
      return result === true ? { previousDraft: draft, writtenDraft: readDraft() } : result;
    }
    if (norm(draft) !== norm(input.text)) return { stage: "draft_mismatch" };
    const button = sendButton();
    if (!button) return { stage: "send_button_unavailable" };
    if (command === "preflight") return true;
    button.click();
    return true;
  }

  if (command === "older" || command === "restore") {
    if (!scroller) return false;
    if (command === "older" && own(own(thread, "cursors"), "before") == null) return false;
    if (command === "restore" && input.anchorID) {
      const anchor = [...list?.children || []].find((row) => row.getAttribute("data-message-id") === input.anchorID);
      if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - input.anchorOffset;
      return Boolean(anchor);
    }
    scroller.scrollTop = command === "older" ? 0 : input.scrollTop;
    scroller.dispatchEvent(new Event("scroll"));
    return true;
  }

  const services = own(owner.props, "services");
  const handoffStore = own(own(services, "typing"), "handoff");
  const handoffRead = own(handoffStore, "getSnapshot");
  const handoff = typeof handoffRead === "function" ? handoffRead.call(handoffStore) : null;
  const messages = [];
  let approvalPending = false;
  function isPendingApproval(button, id) {
    const owner = lineage(button).find(({ props }) =>
      own(props, "roomId") === roomID && own(props, "messageId") === id && own(own(props, "request"), "request_id"));
    if (!owner) return false;
    const request = own(owner.props, "request");
    const evidence = memoValues(owner.node).flat().findLast((value) => {
      const elicitation = own(value, "elicitation");
      return own(elicitation, "request_id") === own(request, "request_id") &&
        own(elicitation, "thread_id") === own(request, "thread_id") &&
        own(elicitation, "turn_id") === own(request, "turn_id") && str(own(value, "request_fingerprint"));
    });
    return own(evidence, "runtime_status") === "pending";
  }

  const rows = [...list?.children || []].filter((row) => row.matches('.message-row[data-message-id], .system-message[data-message-id]'));
  for (const row of rows.slice(-320)) {
    const id = row.getAttribute("data-message-id");
    const messageOwner = lineage(row).find(({ props }) => own(own(props, "message"), "id") === id &&
      own(own(props, "message"), "roomId") === roomID);
    if (!messageOwner) continue;
    const native = own(messageOwner.props, "message");
    const role = own(native, "role");
    if (!roles.has(role) || own(native, "deletedAt")) continue;
    const delivery = own(messageOwner.props, "deliveryState") ?? own(native, "deliveryState");
    const sender = str(own(native, "senderAeonId"));
    messages.push({
      id, role, text: str(own(native, "text") || own(native, "preview")).slice(0, 32000),
      self: own(native, "self") === true, dot: sender === dotID,
      confirmed: delivery === "" && own(native, "storageConfirmed") !== false,
      requestID: str(own(native, "requestId")), replyTo: str(own(own(native, "replyTo"), "messageId")),
      replyRoot: str(own(native, "replyRootMessageId")),
      external: Boolean(own(native, "externalSource")), taskUpdate: own(native, "isTaskUpdate") === true,
      createdAt: str(own(native, "createdAt")), updatedAt: str(own(native, "updatedAt")),
    });

    // An approval can block the composer even though Prism cannot act on it.
    if (!approvalPending) {
      approvalPending = query(row, 'button[data-option-picker-choice], button[type="submit"], button[aria-label]')
        .some((button) => /^(?:allow(?: once)?|deny|decline|允许|仅允许一次|拒绝)$/iu.test(
          (button.getAttribute("aria-label") || button.textContent).trim()) && isPendingApproval(button, id));
    }
  }

  const hasNativeCursor = Boolean(scroller && thread && own(thread, "cursors"));
  const anchor = scroller && rows.find((row) => row.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
  return {
    ...identity, approvalPending, messages,
    handoff: { requestID: str(own(handoff, "requestId")), messageID: str(own(handoff, "messageId")), final: own(handoff, "hideIndicator") === true },
    history: { loaded: hasNativeCursor ? own(thread, "loaded") === true : Boolean(list),
      hasBefore: hasNativeCursor ? Boolean(own(own(thread, "cursors"), "before")) : null,
      loading: own(thread, "olderLoading") === true, failed: Boolean(own(thread, "error")),
      scrollTop: scroller?.scrollTop || 0, anchorID: str(anchor?.getAttribute("data-message-id")),
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top : 0 },
  };
}

function expression(command = "inspect", expected = {}, input = {}) {
  return `(${dotSurface.toString()})(${JSON.stringify(command)}, ${JSON.stringify(expected)}, ${JSON.stringify(input)})`;
}

module.exports = { expression };
