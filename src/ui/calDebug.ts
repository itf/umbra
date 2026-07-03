/**
 * Whether calibration DEBUG logging is on. Off by default; enabled via the same
 * `?debug=1` URL signal as the debug overlay, so per-answer analysis logs
 * ([hrtf-cal], [hp-comp-ab]) are silent in normal use but available when
 * diagnosing localization behaviour offline.
 */
export function calDebugEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}
