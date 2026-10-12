interface StyleValue { value: string; priority: string }
interface OwnedStyle { original: StyleValue; applied?: StyleValue }
/** Host injectStyle is scoped to the slot. Adapt only this card's own outer viewport. */
export function adaptEntryExtraViewport(card: HTMLElement, onExpanded: (expanded: boolean) => void): (() => void) | undefined {
  const viewport = card.closest<HTMLElement>('.pi-entry-extra-viewport');
  const directory = card.querySelector<HTMLElement>('.dv-turn-directory');
  const overflow = card.closest('.dv-turn-layout')?.querySelector<HTMLElement>('.dv-turn-overflow');
  const header = card.querySelector<HTMLElement>('.dv-turn-head');
  if (!viewport || !directory || !overflow || !header) return;
  const owned = new Map<string, OwnedStyle>();
  const read = (property: string): StyleValue => ({ value: viewport.style.getPropertyValue(property), priority: viewport.style.getPropertyPriority(property) });
  const equal = (left: StyleValue, right: StyleValue) => left.value === right.value && left.priority === right.priority;
  const restore = (property: string, value: StyleValue) => {
    if (value.value) viewport.style.setProperty(property, value.value, value.priority);
    else viewport.style.removeProperty(property);
  };
  const apply = (property: string, value?: string) => {
    const current = read(property);
    let setting = owned.get(property);
    if (!setting) {
      if (value == null) return;
      setting = { original: current }; owned.set(property, setting);
    } else if (!setting.applied || !equal(current, setting.applied)) {
      // Preserve the latest host value, including updates made while collapsed.
      setting.original = current;
    }
    if (value == null) {
      if (setting.applied && equal(current, setting.applied)) restore(property, setting.original);
      setting.applied = undefined;
      return;
    }
    const next = { value, priority: 'important' };
    if (!equal(current, next)) viewport.style.setProperty(property, next.value, next.priority);
    setting.applied = next;
  };
  let previous: boolean | undefined, frame = 0;
  const children = new Set<Element>();
  const sync = () => {
    const expanded = viewport.dataset.expanded === 'true';
    // clip, unlike hidden/auto, is not a scroll container (even for focus or scrollTop).
    apply('overflow-x', expanded ? 'visible' : 'clip');
    apply('overflow-y', expanded ? 'visible' : 'clip');
    apply('overscroll-behavior', expanded ? 'auto' : 'contain');
    apply('mask-image', 'none');
    apply('max-height', expanded ? 'none' : undefined);
    card.dataset.hostFold = expanded ? 'expanded' : 'collapsed';
    const limit = expanded ? NaN : parseFloat(getComputedStyle(viewport).maxHeight);
    const cardStyle = getComputedStyle(card);
    const bottom = parseFloat(cardStyle.borderBottomWidth) + parseFloat(cardStyle.marginBottom);
    const available = limit - (directory.getBoundingClientRect().top - viewport.getBoundingClientRect().top) - bottom;
    const maxHeight = Number.isFinite(available) ? `${Math.max(0, available)}px` : 'none';
    if (directory.style.maxHeight !== maxHeight) directory.style.maxHeight = maxHeight;
    // Retain natural content height for the host ResizeObserver's clipping test.
    // This non-interactive space sits AFTER the card, outside the visible fold.
    // The host's single toggle stays accurate without making the header scroll.
    const hiddenHeight = expanded ? 0 : Math.max(0, directory.scrollHeight - directory.clientHeight);
    const height = `${hiddenHeight}px`;
    if (overflow.style.height !== height) overflow.style.height = height;
    for (const child of children) if (child.parentElement !== directory) { resize.unobserve(child); children.delete(child); }
    for (const child of directory.children) if (!children.has(child)) { children.add(child); resize.observe(child); }
    if (expanded !== previous) {
      directory.scrollTop = 0; viewport.scrollTop = 0; previous = expanded; onExpanded(expanded);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; sync(); }); };
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport); resize.observe(header); resize.observe(directory);
  const observer = new MutationObserver(sync);
  observer.observe(viewport, { attributes: true, attributeFilter: ['data-expanded', 'style'] });
  const contentObserver = new MutationObserver(schedule);
  contentObserver.observe(directory, { childList: true, subtree: true, characterData: true });
  sync();
  return () => {
    observer.disconnect(); contentObserver.disconnect(); resize.disconnect(); cancelAnimationFrame(frame);
    delete card.dataset.hostFold; directory.style.removeProperty('max-height'); overflow.style.removeProperty('height');
    for (const [property, setting] of owned) {
      if (setting.applied && equal(read(property), setting.applied)) restore(property, setting.original);
    }
  };
}
