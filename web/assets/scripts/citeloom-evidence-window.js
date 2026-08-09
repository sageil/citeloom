const evidenceWindowGap = 10;
const evidenceWindowLayoutAttempts = 3;
const evidenceWindowViewportPadding = 16;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

function readViewport() {
  return {
    height: window.innerHeight,
    width: window.innerWidth,
  };
}

function hasRenderedBounds(bounds) {
  return bounds.height > 0 && bounds.width > 0;
}

function waitForAnimationFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export async function waitForEvidenceWindowLayout(panel) {
  if (!(panel instanceof HTMLElement)) {
    return false;
  }
  for (let attempt = 0; attempt < evidenceWindowLayoutAttempts; attempt += 1) {
    if (hasRenderedBounds(panel.getBoundingClientRect())) {
      return true;
    }
    await waitForAnimationFrame();
  }
  return hasRenderedBounds(panel.getBoundingClientRect());
}

export function createEvidenceWindowState() {
  return {
    dragSession: null,
    pinned: false,
    position: null,
    size: null,
    trigger: null,
  };
}

export function resetEvidenceWindow(state) {
  state.dragSession = null;
  state.pinned = false;
  state.position = null;
  state.size = null;
  state.trigger = null;
}

export function prepareEvidenceWindow(state, trigger) {
  resetEvidenceWindow(state);
  state.trigger = trigger instanceof HTMLElement ? trigger : null;
}

export function readEvidenceWindowPlacement(
  triggerBounds,
  panelBounds,
  viewport,
) {
  const availableWidth = Math.max(
    0,
    viewport.width - evidenceWindowViewportPadding * 2,
  );
  const width = Math.min(panelBounds.width, availableWidth);
  const availableHeight = Math.max(
    0,
    viewport.height - evidenceWindowViewportPadding * 2,
  );
  const maxHeight = Math.min(panelBounds.height, availableHeight);
  const maximumLeft = Math.max(
    evidenceWindowViewportPadding,
    viewport.width - evidenceWindowViewportPadding - width,
  );
  const left = clamp(
    triggerBounds.left,
    evidenceWindowViewportPadding,
    maximumLeft,
  );
  const top = triggerBounds.top - evidenceWindowGap - maxHeight;
  return { left, maxHeight, top, width };
}

export function evidenceWindowStyle(state, visible = true) {
  if (!visible || state.position === null) {
    return { visibility: "hidden" };
  }
  return {
    left: `${state.position.left}px`,
    maxHeight: `${state.position.maxHeight}px`,
    top: `${state.position.top}px`,
    visibility: "visible",
    width: `${state.position.width}px`,
  };
}

export function positionEvidenceWindow(
  state,
  panel,
  viewport = readViewport(),
) {
  if (state.pinned || !(panel instanceof HTMLElement)) {
    return false;
  }
  const panelBounds = panel.getBoundingClientRect();
  if (!hasRenderedBounds(panelBounds)) {
    state.position = null;
    state.size = null;
    return false;
  }
  if (state.size === null) {
    state.size = {
      height: panelBounds.height,
      width: panelBounds.width,
    };
  }
  if (state.trigger instanceof HTMLElement) {
    if (!state.trigger.isConnected) {
      state.trigger = null;
    } else {
      const triggerBounds = state.trigger.getBoundingClientRect();
      if (!hasRenderedBounds(triggerBounds)) {
        state.trigger = null;
      } else {
        const availableHeight = Math.max(
          0,
          triggerBounds.top
            - evidenceWindowGap
            - evidenceWindowViewportPadding,
        );
        if (availableHeight === 0) {
          state.position = null;
          return false;
        }
        const availablePanelSize = {
          height: Math.min(state.size.height, availableHeight),
          width: state.size.width,
        };
        state.position = readEvidenceWindowPlacement(
          triggerBounds,
          availablePanelSize,
          viewport,
        );
        return true;
      }
    }
  }
  const availableWidth = Math.max(
    0,
    viewport.width - evidenceWindowViewportPadding * 2,
  );
  const availableHeight = Math.max(
    0,
    viewport.height - evidenceWindowViewportPadding * 2,
  );
  const width = Math.min(state.size.width, availableWidth);
  const maxHeight = Math.min(state.size.height, availableHeight);
  state.position = {
    left: Math.round((viewport.width - width) / 2),
    maxHeight,
    top: Math.round((viewport.height - maxHeight) / 2),
    width,
  };
  return true;
}

export function toggleEvidenceWindowPin(state) {
  state.pinned = !state.pinned;
  if (!state.pinned) {
    state.position = null;
  }
}

export function beginEvidenceWindowDrag(state, event, panel) {
  if (
    event.button !== 0
    || state.dragSession !== null
    || !(panel instanceof HTMLElement)
  ) {
    return false;
  }
  if (event.target instanceof Element && event.target.closest("button, a")) {
    return false;
  }
  const panelBounds = panel.getBoundingClientRect();
  state.pinned = true;
  state.dragSession = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLeft: panelBounds.left,
    startTop: panelBounds.top,
  };
  return true;
}

export function continueEvidenceWindowDrag(
  state,
  event,
  panel,
  viewport = readViewport(),
) {
  const session = state.dragSession;
  if (
    session === null
    || session.pointerId !== event.pointerId
    || !(panel instanceof HTMLElement)
  ) {
    return;
  }
  const panelBounds = panel.getBoundingClientRect();
  const maximumLeft = Math.max(
    evidenceWindowViewportPadding,
    viewport.width - evidenceWindowViewportPadding - panelBounds.width,
  );
  const maximumTop = Math.max(
    evidenceWindowViewportPadding,
    viewport.height - evidenceWindowViewportPadding - panelBounds.height,
  );
  const left = clamp(
    session.startLeft + event.clientX - session.startClientX,
    evidenceWindowViewportPadding,
    maximumLeft,
  );
  const top = clamp(
    session.startTop + event.clientY - session.startClientY,
    evidenceWindowViewportPadding,
    maximumTop,
  );
  state.position = {
    left,
    maxHeight: Math.min(
      panelBounds.height,
      viewport.height - evidenceWindowViewportPadding * 2,
    ),
    top,
    width: panelBounds.width,
  };
}

export function finishEvidenceWindowDrag(state, pointerId) {
  if (
    state.dragSession === null
    || state.dragSession.pointerId !== pointerId
  ) {
    return false;
  }
  state.dragSession = null;
  return true;
}

export function findEvidenceCitationTrigger(
  root,
  citationId,
  messageId = null,
  viewportHeight = window.innerHeight,
) {
  const triggers = root.querySelectorAll("[data-evidence-citation-id]");
  let firstRenderedMatch = null;
  for (const trigger of triggers) {
    if (!(trigger instanceof HTMLElement)) {
      continue;
    }
    if (trigger.dataset.evidenceCitationId !== citationId) {
      continue;
    }
    if (
      messageId !== null
      && trigger.dataset.evidenceMessageId !== messageId
    ) {
      continue;
    }
    const bounds = trigger.getBoundingClientRect();
    if (!hasRenderedBounds(bounds)) {
      continue;
    }
    if (firstRenderedMatch === null) {
      firstRenderedMatch = trigger;
    }
    if (bounds.top >= 0 && bounds.bottom <= viewportHeight) {
      return trigger;
    }
  }
  return firstRenderedMatch;
}

export function readEvidenceClaimIndex(trigger) {
  if (!(trigger instanceof HTMLElement)) {
    return null;
  }
  const encodedClaimIndex = trigger.dataset.evidenceClaimIndex;
  if (encodedClaimIndex === undefined) {
    return null;
  }
  const claimIndex = Number(encodedClaimIndex);
  if (!Number.isInteger(claimIndex) || claimIndex < 0) {
    return null;
  }
  return claimIndex;
}

export function revealEvidenceCitationTrigger(
  trigger,
  scrollContainer = null,
) {
  const triggerBounds = trigger.getBoundingClientRect();
  if (scrollContainer instanceof HTMLElement) {
    const containerBounds = scrollContainer.getBoundingClientRect();
    const targetBottom = containerBounds.bottom - evidenceWindowViewportPadding;
    scrollContainer.scrollTo({
      behavior: "instant",
      top: scrollContainer.scrollTop + triggerBounds.bottom - targetBottom,
    });
    return;
  }
  const targetBottom = window.innerHeight - evidenceWindowViewportPadding;
  window.scrollBy({
    behavior: "instant",
    top: triggerBounds.bottom - targetBottom,
  });
}
