import { AppState } from '../../../platform/app_state';

/**
 * Every push this tool sends names itself, so nothing it reads afterwards can be mistaken for
 * another push.
 *
 * Titles used to end in the time of day, and the tap test's title had nothing variable in it
 * at all — `cio verify · tap me · killed` on every run — so a banner left over from an earlier
 * run matched this one. A short random tag in the title is visible everywhere the title is:
 * the OS's notification list on a simulator and on Android, the screen a person taps, and the
 * Android SDK's own lines. The delivery id is the other half: Customer.io puts one in every
 * push and the SDK prints it in nearly every line, so once a push's id is known (from the
 * line that carries both, or from the OS's stored copy) every SDK line is matched by it.
 */

/** No 0/O, 1/I/L or U, so a person reading it off a banner cannot misread it. */
const TAG_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const TAG_LENGTH = 5;

export function pushTag(random: () => number = Math.random): string {
  let tag = '';
  for (let i = 0; i < TAG_LENGTH; i++) {
    tag += TAG_ALPHABET[Math.floor(random() * TAG_ALPHABET.length)];
  }
  return tag;
}

/**
 * The tag comes straight after "cio verify": a banner truncates a long title from the end,
 * and `cio verify · tap me · background · 3X7ZS` lost exactly the part that tells pushes
 * apart. Titles stay under thirty characters; the tap test's state goes in its body.
 */
export function deliveredTitle(state: AppState, tag: string): string {
  return `cio verify ${tag} · ${state}`;
}

export function tapTitle(tag: string): string {
  return `cio verify ${tag} · tap me`;
}

export function tapBody(state: AppState): string {
  return `Tap this to verify the opened metric (${state} state).`;
}

const DELIVERY_ID = /[A-Za-z0-9_-]{8,}={0,2}/;

/**
 * The delivery id of the push with this title, from the Android SDK's account of receiving it.
 *
 * `Received notification for message:` and `Showing notification for message:` print the
 * message's data map on one line — `{…, title=<title>, CIO-Delivery-ID=<id>}` — which is the
 * one place on Android where the title and the id are written down together.
 */
export function androidIdForTitle(
  messages: string[],
  title: string
): string | undefined {
  for (const message of messages) {
    if (!/(?:Received|Showing) notification for message: \{/.test(message)) {
      continue;
    }
    if (!dataMapHas(message, 'title', title)) continue;
    const id = message.match(
      new RegExp(`[{ ,]CIO-Delivery-ID=(${DELIVERY_ID.source})[,}]`)
    );
    if (id) return id[1];
  }
  return undefined;
}

/**
 * What the Android SDK's opened line says about the push that was tapped.
 *
 * It prints the parsed payload — `CustomerIOParsedPushPayload(…, cioDeliveryId=<id>, …,
 * title=<title>, body=…)` — so the open names its push by both.
 */
export function androidOpenedIdentity(message: string): {
  deliveryId?: string;
  title?: string;
} {
  const id = message.match(
    new RegExp(`cioDeliveryId=(${DELIVERY_ID.source})[,)]`)
  );
  const title = message.match(/, title=(.*?), body=/);
  return { deliveryId: id?.[1], title: title?.[1] };
}

function dataMapHas(message: string, key: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[{ ,]${key}=${escaped}[,}]`).test(message);
}
