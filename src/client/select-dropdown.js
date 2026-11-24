const mounted = new Set();
let removalObserver;

function watchRemoval(doc) {
  if (removalObserver) return;
  removalObserver = new MutationObserver(() => {
    for (const dispose of [...mounted]) if (!dispose.select.isConnected) dispose();
  });
  removalObserver.observe(doc, {childList: true, subtree: true});
}

function labelFor(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const label = select.closest('label') || (select.id && [...document.getElementsByTagName('label')].find(node => node.htmlFor === select.id));
  if (!label) return '请选择';
  const direct = [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).join(' ').trim();
  return direct || label.querySelector('span')?.textContent.trim() || '请选择';
}

/** Keep the native select as the form/value model, but never open its OS menu. */
export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.dataset.dropdownEnhanced) return select;
  const doc = select.ownerDocument;
  const id = select.id || `select-${mounted.size + 1}`;
  let open = false, active = -1, options = [], disposed = false, typeahead = '', typeTimer;
  const listeners = new AbortController();
  const signal = listeners.signal;
  const trigger = doc.createElement('button');
  trigger.type = 'button'; trigger.id = `${id}-dropdown`; trigger.className = 'select-dropdown-trigger';
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', `${id}-dropdown-options`);
  trigger.setAttribute('aria-label', labelFor(select));
  const value = doc.createElement('span'); value.className = 'select-dropdown-value';
  const arrow = doc.createElement('span'); arrow.className = 'select-dropdown-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '⌄';
  trigger.append(value, arrow);
  const panel = doc.createElement('div'); panel.id = `${id}-dropdown-options`; panel.className = 'select-dropdown-panel';
  panel.setAttribute('role', 'listbox'); panel.setAttribute('aria-label', labelFor(select)); panel.popover = 'auto';
  const nativePopover = typeof panel.showPopover === 'function';
  if (!nativePopover) {panel.removeAttribute('popover'); panel.hidden = true;}
  const wrapper = doc.createElement('div'); wrapper.className = 'select-dropdown';
  select.before(wrapper); wrapper.append(select, trigger, panel);
  select.dataset.dropdownEnhanced = 'true'; select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  if (select.id) for (const label of [...doc.getElementsByTagName('label')].filter(node => node.htmlFor === select.id)) label.htmlFor = trigger.id;

  const descriptors = {};
  for (const property of ['value', 'disabled', 'selectedIndex']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, property);
    if (!descriptor?.get || !descriptor?.set) continue;
    descriptors[property] = descriptor;
    Object.defineProperty(select, property, {configurable: true, get() {return descriptor.get.call(this);},
      set(next) {descriptor.set.call(this, next); sync();}});
  }
  const mutations = new MutationObserver(sync);
  mutations.observe(select, {attributes: true, childList: true, characterData: true, subtree: true,
    attributeFilter: ['disabled', 'selected', 'label', 'value', 'data-dropdown-description']});

  function enabledIndexes() {return options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);}
  function highlight(index) {
    const enabled = enabledIndexes();
    active = enabled.includes(index) ? index : enabled[0] ?? -1;
    options.forEach((option, i) => option.node.classList.toggle('active', i === active));
    if (options[active]) {
      trigger.setAttribute('aria-activedescendant', options[active].node.id);
      options[active].node.scrollIntoView({block: 'nearest'});
    } else trigger.removeAttribute('aria-activedescendant');
  }
  function position() {
    if (!open) return;
    const box = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(box.width, 180), innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`;
    const below = innerHeight - box.bottom - 12, above = box.top - 12;
    const upward = below < 160 && above > below;
    const height = Math.max(72, Math.min(320, upward ? above : below));
    panel.style.maxHeight = `${height}px`;
    const actual = Math.min(panel.scrollHeight, height);
    const top = upward ? box.top - actual - 6 : box.bottom + 6;
    panel.style.top = `${Math.max(12, Math.min(top, innerHeight - actual - 12))}px`;
  }
  function close(focus = true) {
    if (!open) return;
    open = false; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
    if (nativePopover && panel.matches(':popover-open')) panel.hidePopover(); else if (!nativePopover) panel.hidden = true;
    if (focus && trigger.isConnected) trigger.focus({preventScroll: true});
  }
  function show(last = false) {
    if (select.disabled || disposed) return;
    if (!nativePopover && open) return;
    renderOptions();
    open = true; trigger.setAttribute('aria-expanded', 'true');
    if (nativePopover) {if (!panel.matches(':popover-open')) panel.showPopover();} else panel.hidden = false;
    const selected = options.findIndex(option => option.value === select.value && !option.disabled);
    const enabled = enabledIndexes();
    highlight(selected >= 0 ? selected : last ? enabled.at(-1) : enabled[0]);
    position(); trigger.focus({preventScroll: true});
  }
  function choose(index) {
    const option = options[index];
    if (!option || option.disabled || select.disabled) return;
    const changed = select.value !== option.value;
    descriptors.value?.set.call(select, option.value);
    close(); sync();
    if (changed) {
      select.dispatchEvent(new Event('input', {bubbles: true}));
      select.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }
  function renderOptions() {
    const scrollTop = panel.scrollTop;
    options = [...select.options].map((option, index) => {
      const node = doc.createElement('div'); node.id = `${id}-dropdown-option-${index}`;
      node.className = 'select-dropdown-option'; node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(option.selected)); node.setAttribute('aria-disabled', String(option.disabled));
      const description = option.dataset.dropdownDescription;
      node.setAttribute('aria-label', [option.textContent, description].filter(Boolean).join(' · '));
      node.textContent = option.textContent;
      if (description) {
        const detail = doc.createElement('span');
        detail.className = 'select-dropdown-option-description';
        detail.textContent = description;
        node.append(detail);
      }
      if (option.disabled) node.classList.add('disabled');
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => choose(index));
      return {node, value: option.value, disabled: option.disabled};
    });
    panel.replaceChildren(...options.map(option => option.node)); panel.scrollTop = scrollTop;
  }
  function sync() {
    if (disposed) return;
    const selected = select.selectedOptions[0];
    value.textContent = selected?.textContent || '请选择';
    value.title = selected?.textContent || '';
    trigger.disabled = select.disabled; trigger.setAttribute('aria-expanded', String(open && !select.disabled));
    if (select.disabled && open) close(false);
    renderOptions(); position();
  }
  function keydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault(); show(event.key === 'ArrowUp'); return;
    }
    if (!open) return;
    const enabled = enabledIndexes(), current = enabled.indexOf(active);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown' ? Math.min(current + 1, enabled.length - 1) : Math.max(current - 1, 0);
      highlight(enabled[next]);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); highlight(event.key === 'Home' ? enabled[0] : enabled.at(-1));
    } else if (event.key === 'Enter' || event.key === ' ') {event.preventDefault(); choose(active);}
    else if (event.key === 'Escape') {event.preventDefault(); close();}
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      clearTimeout(typeTimer); typeahead += event.key.toLocaleLowerCase();
      const match = [...select.options].findIndex(option => !option.disabled && option.textContent.trim().toLocaleLowerCase().startsWith(typeahead));
      if (match >= 0) highlight(match);
      typeTimer = setTimeout(() => {typeahead = '';}, 700);
    }
  }
  trigger.addEventListener('click', () => open ? close() : show());
  trigger.addEventListener('keydown', keydown);
  panel.addEventListener('toggle', event => {if (event.newState === 'closed') {open = false; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');}}, {signal});
  doc.addEventListener('pointerdown', event => {if (open && !wrapper.contains(event.target)) close(false);}, {signal});
  window.addEventListener('resize', position, {signal}); window.addEventListener('scroll', position, {capture: true, signal});
  select.addEventListener('change', sync, {signal});
  select.form?.addEventListener('reset', () => setTimeout(sync), {signal});
  function dispose() {
    if (disposed) return;
    disposed = true; close(false); clearTimeout(typeTimer); mutations.disconnect(); listeners.abort();
    for (const [property, descriptor] of Object.entries(descriptors)) Object.defineProperty(select, property, {configurable: true, ...descriptor});
    mounted.delete(dispose);
  }
  dispose.select = select; mounted.add(dispose); watchRemoval(doc); sync();
  return select;
}

export function enhanceSelects(root = document) {
  for (const select of root.querySelectorAll('select:not([data-dropdown-enhanced])')) enhanceSelect(select);
}
