/**
 * Double-action protection for poll-request actions (Approve, Dismiss,
 * Withdraw), mirroring `useAdvanceAction`'s two layers for Next Speaker /
 * Next Agenda Item:
 *
 * - **Debounce** (DEBOUNCE_MS): rapid repeated fires are ignored, and
 *   `disabled` is true for the window so the button visibly greys out.
 * - **Cooldown** (COOLDOWN_MS): when the pending-request list changes by
 *   someone *else's* hand — a request was added, replaced (the requester
 *   revised it, which gives it a new id), or removed by another chair or
 *   by the agenda advancing — the actions are disabled for a beat. Without
 *   it a chair can approve or dismiss the wrong request when rows shift
 *   under the cursor, or approve a revision they haven't actually read.
 *   Changes we caused ourselves (a dismiss/approve we fired, or our own
 *   request) skip the cooldown; the debounce already covers those.
 *
 * `guard(id, fn)` runs `fn` unless the guard is active, and remembers `id`
 * as "ours" so its disappearance from the list doesn't trigger a cooldown.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { userKey } from '@tcq/shared';
import { useMeetingState } from '../contexts/MeetingContext.js';

const DEBOUNCE_MS = 400;
const COOLDOWN_MS = 2000;

/** User-facing explanation shown next to disabled actions while cooling down. */
export const POLL_REQUEST_COOLDOWN_REASON = 'Poll requests just changed — check the list before continuing.';

export interface PollRequestGuard {
  /** True while the debounce or cooldown window is active. */
  disabled: boolean;
  /** True specifically because of a cooldown (someone else changed the list). */
  coolingDown: boolean;
  /** Run `fn` for request `id` unless the guard is active. */
  guard: (id: string, fn: () => void) => void;
}

export function usePollRequestGuard(): PollRequestGuard {
  const { meeting, user } = useMeetingState();
  const pollRequests = meeting?.pollRequests;
  const me = user ? userKey(user) : null;

  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [debounceActive, setDebounceActive] = useState(false);
  const lastFireRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Ids whose removal we initiated (dismiss/approve). Their disappearance
  // is expected and must not pause us.
  const ownRemovalsRef = useRef<Set<string>>(new Set());

  // Previous snapshot of the list: id → requesterId. `undefined` until the
  // first state is seen so the initial load never triggers a cooldown.
  const prevRef = useRef<Map<string, string> | undefined>(undefined);

  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map((pollRequests ?? []).map((r) => [r.id, r.requesterId] as const));
    prevRef.current = next;
    if (prev === undefined) return;

    let foreignChange = false;
    for (const [id, requesterId] of prev) {
      if (next.has(id)) continue;
      if (ownRemovalsRef.current.delete(id)) continue; // we removed it
      if (requesterId === me) continue; // our own request (we withdrew/replaced it)
      foreignChange = true;
    }
    if (!foreignChange) {
      for (const [id, requesterId] of next) {
        if (prev.has(id)) continue;
        if (requesterId === me) continue; // our own new/revised request
        foreignChange = true;
        break;
      }
    }
    if (!foreignChange) return;

    // Defer the setState out of the effect body. Not cancelled on re-run:
    // a burst of deltas must not drop a legitimately triggered cooldown.
    const deadline = Date.now() + COOLDOWN_MS;
    const timer = setTimeout(() => {
      pendingTimersRef.current.delete(timer);
      setCooldownUntil((cur) => Math.max(cur, deadline));
    }, 0);
    pendingTimersRef.current.add(timer);
  }, [pollRequests, me]);

  // Single timer that ends the cooldown; keyed on the deadline so an
  // extended window reschedules and unrelated renders leave it alone.
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const pending = pendingTimersRef.current;
    const deadline = cooldownUntil;
    const timer = setTimeout(
      () => {
        pending.delete(timer);
        // Only clear the window this timer was armed for. If a later
        // change extended the deadline in the same batch, a stale timer
        // must not drop it.
        setCooldownUntil((cur) => (cur === deadline ? 0 : cur));
      },
      Math.max(cooldownUntil - Date.now(), 0),
    );
    pending.add(timer);
    return () => {
      clearTimeout(timer);
      pending.delete(timer);
    };
  }, [cooldownUntil]);

  useEffect(() => {
    const pending = pendingTimersRef.current;
    return () => {
      clearTimeout(debounceTimerRef.current);
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const guard = useCallback(
    (id: string, fn: () => void) => {
      const now = Date.now();
      if (now < cooldownUntil) return;
      if (now - lastFireRef.current < DEBOUNCE_MS) return;
      lastFireRef.current = now;

      ownRemovalsRef.current.add(id);
      fn();

      setDebounceActive(true);
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => setDebounceActive(false), DEBOUNCE_MS);
    },
    [cooldownUntil],
  );

  const coolingDown = cooldownUntil > 0;
  return { disabled: coolingDown || debounceActive, coolingDown, guard };
}
