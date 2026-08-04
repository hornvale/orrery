/** Remembers the viewer's control settings per browser, so a fresh visit
 * reopens how they left it. Same payload the URL carries — the URL WINS when
 * present; this only fills in when it does not.
 *
 * Every access is guarded: Safari in private mode and a storage-disabled
 * browser both throw on plain `localStorage` access, and a planetarium
 * failing to boot because a preference could not be read would be absurd. */
const KEY = 'orrery.controls.v1';

export function loadLocalControls(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveLocalControls(encoded: string): void {
  try {
    if (encoded === '') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, encoded);
  } catch {
    /* storage unavailable — the session still works, it just won't be remembered */
  }
}

/** THE rule: a shared link must show the SENDER's view, not the recipient's
 * saved preferences. `urlControls` wins outright whenever it is non-empty;
 * `loadLocal` (deferred behind a thunk so an empty URL never touches storage
 * needlessly) is consulted only when the hash carried none at all. Pulled
 * out of `main.ts` so this precedence has a direct unit test rather than
 * living only as an inline ternary nobody can exercise in isolation. */
export function resolveControls(urlControls: string, loadLocal: () => string): string {
  return urlControls !== '' ? urlControls : loadLocal();
}
