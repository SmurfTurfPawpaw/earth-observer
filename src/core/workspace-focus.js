import { HOME_VIEW, setCameraView } from './navigation.js';

/** Coordinate visibility through the shell's existing lifecycle. Scene time,
 * selected features, requests and form values remain owned by their components. */
export function createWorkspaceFocus({ calendar, subscribePanels, closeExpandedWorkspace, closeExternalWorkspace = () => {} } = {}) {
  if (!calendar?.addEventListener || typeof subscribePanels !== 'function' || typeof closeExpandedWorkspace !== 'function' || typeof closeExternalWorkspace !== 'function')
    throw new TypeError('Workspace focus needs a calendar and shell lifecycle');
  let destroyed = false;
  const collapseCalendar = () => { if (calendar.open) calendar.open = false; };
  const focusWorkspace = () => { if (!destroyed) { closeExternalWorkspace(); collapseCalendar(); } };
  const focusExternalWorkspace = () => { if (!destroyed) { collapseCalendar(); closeExpandedWorkspace(); } };
  const calendarToggle = () => { if (!destroyed && calendar.open) { closeExternalWorkspace(); closeExpandedWorkspace(); } };
  const unsubscribe = subscribePanels(({ open }) => { if (open) focusWorkspace(); });
  calendar.addEventListener('toggle', calendarToggle);
  if (calendar.open) { closeExternalWorkspace(); closeExpandedWorkspace(); }
  return { focusWorkspace, focusExternalWorkspace,
    destroy() { if (destroyed) return; destroyed = true; unsubscribe?.(); calendar.removeEventListener('toggle', calendarToggle); } };
}

/** Ordinary place navigation does not activate a layer preset or ask location
 * permission. Explicit location actions keep their separate consent/data path. */
export function createPlaceNavigation({ viewer, cancelLocation = () => {}, closeSidebar = () => {}, navigate = setCameraView } = {}) {
  if (!viewer || typeof navigate !== 'function') throw new TypeError('Place navigation needs a viewer');
  return (place) => {
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lon) || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180) return false;
    cancelLocation(); navigate(viewer, { ...HOME_VIEW, lat: place.lat, lon: place.lon, alt: 90000 }, true); closeSidebar(); return true;
  };
}
