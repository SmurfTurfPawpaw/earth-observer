import { createIcon } from './icons.js';

/** One source-list surface. It owns only its page requests; full source proof
 * and native selection remain the shared scene renderer's responsibility. */
export function createSceneMembersPanel({ documentRef = globalThis.document, windowRef = documentRef?.defaultView,
  onOpen = () => {}, onClose = () => {} } = {}) {
  const element = (tag, className, text) => { const node = documentRef.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text; return node; };
  const panel = element('section', 'floating-panel side-panel scene-members'); panel.id = 'scene-members'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'scene-members-title');
  const header = element('header', 'panel-header'), heading = element('div', 'panel-heading');
  const eyebrow = element('span', 'panel-eyebrow'), title = element('h2', '', 'Reports in this area'); title.id = 'scene-members-title';
  heading.append(eyebrow, title);
  const refreshButton = element('button', 'icon-button scene-members-refresh'); refreshButton.type = 'button'; refreshButton.hidden = true;
  refreshButton.setAttribute('aria-label', 'Show latest reports in this area'); refreshButton.title = 'Show latest reports in this area';
  refreshButton.append(createIcon('refresh', documentRef));
  const closeButton = element('button', 'icon-button'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close area reports');
  closeButton.append(createIcon('close', documentRef)); header.append(heading, refreshButton, closeButton);
  const content = element('div', 'panel-content'), status = element('p', 'scene-members-status'); status.setAttribute('role', 'status');
  const list = element('div', 'scene-members-list'), more = element('button', 'scene-members-more', 'More reports'); more.type = 'button'; more.hidden = true;
  content.append(status, list, more); panel.append(header, content);
  (documentRef.getElementById('app') || documentRef.querySelector('main') || documentRef.body).append(panel);
  let destroyed = false, revision = 0, context, controller, cursor = null, busy = false, contextStop, stopLatest, recoveryNeeded = false;
  const emit = open => { try { documentRef.dispatchEvent(new windowRef.CustomEvent('earth-observer:panel', { detail: { panel: 'scene-members', open } })); } catch {} };
  const active = token => !destroyed && !panel.hidden && revision === token && !controller?.signal.aborted && context?.isCurrent?.() !== false;
  function close({ restoreFocus = false } = {}) {
    ++revision; const previous = context; context = null;
    stopLatest?.(); stopLatest = null;
    if (contextStop) previous?.signal?.removeEventListener('abort', contextStop); contextStop = null;
    controller?.abort(); controller = null; busy = false; panel.hidden = true;
    documentRef.body.classList.remove('scene-members-open'); previous?.onClose?.(); emit(false); onClose();
    if (restoreFocus) documentRef.getElementById('open-sidebar')?.focus();
  }
  async function select(item, button, token) {
    if (!active(token) || busy) return; const previousStatus = status.textContent;
    busy = true; button.disabled = true; status.textContent = 'Opening source report…';
    try { const opened = await context.inspectMember(item, { signal: controller.signal });
      if (!active(token)) return;
      if (opened === false) { status.textContent = previousStatus; return; }
      close();
    } catch (error) { if (active(token)) {
      status.textContent = error?.refreshRequired ? 'This edition has expired. Show the latest reports to continue.' : 'The source report could not open. Try again.';
      if (error?.refreshRequired && typeof context.refresh === 'function') { recoveryNeeded = true; refreshButton.hidden = false; }
    } }
    finally { if (active(token)) { busy = false; button.disabled = false; } }
  }
  async function load(token) {
    if (!active(token) || busy) return; busy = true; more.disabled = true; panel.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading source reports…';
    try { const page = await context.loadPage(cursor, { signal: controller.signal });
      if (!active(token)) return;
      if (!page || !Array.isArray(page.members) || page.members.length > 50 || !Number.isSafeInteger(page.count) || page.count !== context.cluster.count ||
        page.clusterId !== context.cluster.id || page.viewVersion !== context.viewVersion) throw new TypeError('Unverified source list');
      for (const member of page.members) {
        const button = element('button', 'scene-member-row'); button.type = 'button';
        button.append(element('span', 'scene-member-title', member.display?.title || member.title || 'Source report'));
        button.append(element('span', 'scene-member-action', '↗'));
        button.addEventListener('click', () => { void select(member, button, token); }); list.append(button);
      }
      cursor = page.nextCursor || null; more.hidden = !cursor; more.textContent = 'More reports';
      status.textContent = `${list.children.length} of ${page.count} reports · ${context.sourceLabel || context.sourceKey}`;
    } catch (error) { if (active(token)) {
      status.textContent = error?.refreshRequired ? 'This edition has expired. Show the latest reports to continue.' : 'Reports could not load. Try again.';
      if (error?.refreshRequired && typeof context.refresh === 'function') { recoveryNeeded = true; refreshButton.hidden = false; }
      more.hidden = Boolean(error?.refreshRequired); more.textContent = 'Try again';
    } }
    finally { if (active(token)) { busy = false; more.disabled = false; panel.setAttribute('aria-busy', 'false'); } }
  }
  async function refresh() {
    const token = revision; if (!active(token) || busy || typeof context.refresh !== 'function') return;
    const previousStatus = status.textContent; busy = true; refreshButton.disabled = true; status.textContent = 'Loading latest reports…';
    try { const opened = await context.refresh({ signal: controller.signal });
      if (!active(token)) return;
      status.textContent = opened === false ? 'The latest edition has no matching group in this area.' : previousStatus;
    } catch (error) { if (active(token)) {
      if (error?.refreshRequired) { recoveryNeeded = true; refreshButton.hidden = false; }
      status.textContent = error?.code === 'latest-group-individuals' ? 'The latest view shows these reports individually. Close this list to inspect the map.' :
        error?.code === 'latest-area-empty' ? 'No reports appear in the latest view of this area. This edition remains available here.' :
        error?.refreshRequired ? 'The latest reports are not ready yet. Try again shortly.' : 'Latest reports could not load. Try again.';
    }
    } finally { if (active(token)) { busy = false; refreshButton.disabled = false; } }
  }
  const moreClick = () => { void load(revision); }, closeClick = () => close({ restoreFocus: true });
  const refreshClick = () => { void refresh(); };
  const keydown = event => { if (!panel.hidden && event.key === 'Escape') { event.preventDefault(); closeClick(); } };
  more.addEventListener('click', moreClick); refreshButton.addEventListener('click', refreshClick);
  closeButton.addEventListener('click', closeClick); documentRef.addEventListener('keydown', keydown);
  return {
    open(value) {
      if (destroyed || !value?.cluster || typeof value.loadPage !== 'function' || typeof value.inspectMember !== 'function') return false;
      close(); if (value.signal?.aborted || value.isCurrent?.() === false) return false;
      context = value; controller = new AbortController(); contextStop = () => close();
      value.signal?.addEventListener('abort', contextStop, { once: true }); cursor = null; list.replaceChildren(); more.hidden = true;
      recoveryNeeded = false; refreshButton.disabled = false; refreshButton.hidden = typeof value.refresh !== 'function' || value.isLatest?.() !== false;
      const token = revision;
      stopLatest = value.subscribeLatest?.(isLatest => { if (active(token) && typeof value.refresh === 'function') refreshButton.hidden = isLatest !== false && !recoveryNeeded; });
      eyebrow.textContent = value.sourceLabel || value.sourceKey || 'Source reports'; panel.hidden = false;
      documentRef.body.classList.add('scene-members-open'); onOpen(); emit(true); closeButton.focus();
      if (Array.isArray(value.groups) && value.groups.length > 1 && value.groups.length <= 7 && typeof value.inspectGroup === 'function') {
        status.textContent = 'Choose a report category';
        for (const group of value.groups) {
          const button = element('button', 'scene-member-row'); button.type = 'button';
          button.append(element('span', 'scene-member-title', group.label), element('span', 'scene-member-action', String(group.count)));
          button.addEventListener('click', () => { if (!active(token)) return; close(); value.inspectGroup(group.id); }); list.append(button);
        }
      } else void load(revision);
      return true;
    }, close,
    isOpen: () => !panel.hidden,
    destroy() { if (destroyed) return; close(); destroyed = true; documentRef.removeEventListener('keydown', keydown);
      more.removeEventListener('click', moreClick); refreshButton.removeEventListener('click', refreshClick);
      closeButton.removeEventListener('click', closeClick); panel.remove(); },
  };
}
