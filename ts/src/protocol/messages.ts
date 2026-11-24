/**
 * Typed RBA messages.
 *
 * Every frame the terminal sends is classified here, in the receive layer, into an `Inbound`
 * value. 23.x card-read replies carry track data with the card number: they are reduced to the
 * exit type and the reader letter (or key data) on arrival, and the raw text is never stored,
 * logged or put in an error. Messages with ids we don't know (for example EMV messages from a
 * payment flow the terminal starts by itself) are reduced to their id for the same reason.
 */

import { pyRepr } from "../util/py-repr.js";
import { FS } from "./framing.js";

/** Message ids this project sends or expects back. */
export const MESSAGE_IDS = [
  "00", // Offline
  "01", // Online
  "07", // Unit data
  "10", // Hard reset
  "11", // Status
  "15", // Soft reset (15.0) / Stop action (15.6)
  "22", // Application id
  "23", // Card read
  "24", // Form entry
  "26", // Run script
  "28", // Set variable
  "51", // Beep
  "62", // File write
  "63", // Find file
  "64", // Delete file
  "65", // Retrieve file
  "70", // Update form element
  "72", // Audio
  "92", // Lights
  "97", // Reboot
  "98", // Undefined-message reply
] as const;
export type MessageId = (typeof MESSAGE_IDS)[number];

export function isMessageId(s: string): s is MessageId {
  return MESSAGE_IDS.some((id) => id === s);
}

/** A message the host sends: "<id>." followed by the body. */
export type Outbound = `${MessageId}.${string}`;

/** Validate text typed on a command line as an outbound message. */
export function isOutbound(s: string): s is Outbound {
  return s.charAt(2) === "." && isMessageId(s.slice(0, 2));
}

// ---- keys -------------------------------------------------------------------------------

/** Keys reported by our full-screen GAME.K3Z layout: F1-F4, green, yellow, red. */
export const GAME_KEYS = ["L", "U", "D", "R", "\r", "\b", "\x1b"] as const;
export type GameKey = (typeof GAME_KEYS)[number];
/** Keys reported by the stock BAMTV.K3Z form: F1-F4 = C P Y N, green, red. */
export const BAMTV_KEYS = ["C", "P", "Y", "N", "\r", "\x1b"] as const;
export type BamtvKey = (typeof BAMTV_KEYS)[number];
export type KeyCode = GameKey | BamtvKey;

export function isKeyCode(s: string): s is KeyCode {
  return GAME_KEYS.some((k) => k === s) || BAMTV_KEYS.some((k) => k === s);
}

export function isGameKey(s: string): s is GameKey {
  return GAME_KEYS.some((k) => k === s);
}

export function isBamtvKey(s: string): s is BamtvKey {
  return BAMTV_KEYS.some((k) => k === s);
}

// ---- 23.x card read ---------------------------------------------------------------------

/** 23.x exit types seen or documented. `N` is undocumented: "card left before the read finished". */
export const CARD_EXIT_TYPES = ["0", "1", "2", "3", "6", "7", "9", "A", "R", "N"] as const;
export type CardExitType = (typeof CARD_EXIT_TYPES)[number];

/** Reader letters in a good-read (23.0) reply. */
export const CARD_READERS = ["C", "E", "M", "S", "Q", "c", "m", "H"] as const;
export type CardReader = (typeof CARD_READERS)[number];

/** What a game does with a card: the three physical gestures. */
export type CardEvent = "swipe" | "tap" | "insert";

/**
 * A classified 23.x reply. Only the exit type and the reader letter (or, for key presses, the
 * three key characters) survive; the track data is dropped in `parseCardReply`.
 */
export type CardReply =
  | { readonly exit: "0"; readonly reader: CardReader | null; readonly letter: string }
  | { readonly exit: "3"; readonly keyField: string }
  | { readonly exit: Exclude<CardExitType, "0" | "3"> }
  | { readonly exit: "other"; readonly code: string };

function isCardExitType(s: string): s is CardExitType {
  return CARD_EXIT_TYPES.some((e) => e === s);
}

function isCardReader(s: string): s is CardReader {
  return CARD_READERS.some((r) => r === s);
}

/** Classify the text after "23.". Never throws and never keeps more than the fields above. */
export function parseCardReply(rest: string): CardReply {
  const code = rest.slice(0, 1);
  if (!isCardExitType(code)) return { exit: "other", code };
  switch (code) {
    case "0": {
      const letter = rest.slice(1, 2);
      return { exit: "0", reader: isCardReader(letter) ? letter : null, letter };
    }
    case "3":
      // Key press while armed (23.3<key>): no card data, keep the next three characters.
      return { exit: "3", keyField: rest.slice(1, 4) };
    case "1":
    case "2":
    case "6":
    case "7":
    case "9":
    case "A":
    case "R":
    case "N":
      return { exit: code };
    default: {
      const unreachable: never = code;
      return unreachable;
    }
  }
}

/** The card event for a good read: M = swipe, S/Q = chip insert, anything else = tap. */
export function cardEventForReader(letter: string): CardEvent {
  if (letter === "M") return "swipe";
  if (letter === "S" || letter === "Q") return "insert";
  return "tap";
}

/** Short, card-data-free description of a 23.x reply, e.g. `23.0M` or `23.3'\r'`. */
export function describeCardReply(card: CardReply): string {
  switch (card.exit) {
    case "0":
      return `23.0${card.letter} [card data discarded]`;
    case "3":
      return `23.3 key ${pyRepr(card.keyField)}`;
    case "other":
      return `23.${card.code}`;
    case "1":
    case "2":
    case "6":
    case "7":
    case "9":
    case "A":
    case "R":
    case "N":
      return `23.${card.exit}`;
    default: {
      const unreachable: never = card;
      return unreachable;
    }
  }
}

// ---- 24.x form entry --------------------------------------------------------------------

/** 24.x reply `24.<exit type><key><rest>`; exit type `0` = a key closed the form. */
export interface FormExit {
  readonly exitType: string;
  /** The raw key character ("" if the reply had none). */
  readonly keyChar: string;
  /** `keyChar` when it is one of the keys our forms report. */
  readonly key: KeyCode | null;
  readonly rest: string;
}

function parseFormExit(rest: string): FormExit {
  const keyChar = rest.slice(1, 2);
  return { exitType: rest.slice(0, 1), keyChar, key: isKeyCode(keyChar) ? keyChar : null, rest: rest.slice(2) };
}

// ---- 65.x retrieve file -----------------------------------------------------------------

/** One 65.x block: `65.0<total>FS<block>FS<crc>FS<format>FS<data>`, or a non-zero status. */
export type FileReadReply =
  | {
      readonly ok: true;
      readonly total: number;
      readonly block: number;
      readonly crc: string;
      readonly format: string;
      readonly data: string;
    }
  | { readonly ok: false; readonly status: string };

function parseFileRead(rest: string): FileReadReply {
  const status = rest.slice(0, 1);
  if (status !== "0") return { ok: false, status };
  const parts = rest.slice(1).split(FS);
  const [total, block, crc, format] = parts;
  if (total === undefined || block === undefined || crc === undefined || format === undefined || parts.length < 5) {
    return { ok: false, status: "malformed" };
  }
  const totalN = Number.parseInt(total, 10);
  const blockN = Number.parseInt(block, 10);
  if (Number.isNaN(totalN) || Number.isNaN(blockN)) return { ok: false, status: "malformed" };
  // data is everything after the fourth separator (Python: split(FS, 4))
  return { ok: true, total: totalN, block: blockN, crc, format, data: parts.slice(4).join(FS) };
}

// ---- all inbound messages ---------------------------------------------------------------

type StructuredId = "23" | "24" | "62" | "65";
/** Ids whose replies are kept as plain text (none of them carry card data). */
export type TextReplyId = Exclude<MessageId, StructuredId>;

export type Inbound =
  | { readonly id: "23"; readonly card: CardReply }
  | { readonly id: "24"; readonly form: FormExit }
  | { readonly id: "62"; readonly status: string }
  | { readonly id: "65"; readonly file: FileReadReply }
  | { readonly [K in TextReplyId]: { readonly id: K; readonly body: string } }[TextReplyId]
  | { readonly id: "unknown"; readonly prefix: string; readonly length: number };

export type InboundOf<I extends MessageId> = Extract<Inbound, { readonly id: I }>;

function isTextReplyId(id: MessageId): id is TextReplyId {
  return id !== "23" && id !== "24" && id !== "62" && id !== "65";
}

function textReply(id: TextReplyId, body: string): Inbound {
  return { id, body };
}

/** Classify one frame body from the terminal (e.g. "24.0L"). */
export function parseInbound(text: string): Inbound {
  const id = text.slice(0, 2);
  if (text.charAt(2) !== "." || !isMessageId(id)) {
    return { id: "unknown", prefix: text.slice(0, 3).replace(/[^\x20-\x7e]/g, "?"), length: text.length };
  }
  const rest = text.slice(3);
  if (id === "23") return { id, card: parseCardReply(rest) };
  if (id === "24") return { id, form: parseFormExit(rest) };
  if (id === "62") return { id, status: rest.slice(0, 1) };
  if (id === "65") return { id, file: parseFileRead(rest) };
  if (isTextReplyId(id)) return textReply(id, rest);
  const unreachable: never = id;
  return unreachable;
}

/** Python-repr-like rendering for logs; card replies and unknown messages stay redacted. */
export function formatInbound(m: Inbound): string {
  switch (m.id) {
    case "23":
      return describeCardReply(m.card);
    case "24":
      return pyRepr(`24.${m.form.exitType}${m.form.keyChar}${m.form.rest}`);
    case "62":
      return pyRepr(`62.${m.status}`);
    case "65":
      return m.file.ok
        ? `65.0 block ${m.file.block}/${m.file.total} (${m.file.data.length} chars)`
        : pyRepr(`65.${m.file.status}`);
    case "unknown":
      return `${pyRepr(m.prefix)}... (${m.length} chars, not shown)`;
    case "00":
    case "01":
    case "07":
    case "10":
    case "11":
    case "15":
    case "22":
    case "26":
    case "28":
    case "51":
    case "63":
    case "64":
    case "70":
    case "72":
    case "92":
    case "97":
    case "98":
      return pyRepr(`${m.id}.${m.body}`);
    default: {
      const unreachable: never = m;
      return unreachable;
    }
  }
}

/** The reply's status character (body[0]), the `r[3]` the Python code checks. */
export function statusOf(m: Inbound): string {
  if (m.id === "23") return m.card.exit === "other" ? m.card.code : m.card.exit;
  if (m.id === "24") return m.form.exitType;
  if (m.id === "62") return m.status;
  if (m.id === "65") return m.file.ok ? "0" : m.file.status;
  if (m.id === "unknown") return "";
  return m.body.slice(0, 1);
}

// ---- 24.x request builder ---------------------------------------------------------------

/** A 24.x request must stay under 247 bytes or the terminal drops label overrides. */
export const FORM_REQUEST_LIMIT = 247;

export type FormRequest = `24.${string}`;

/**
 * Build `24.<form>[FS]T<id>,<text>...[FS]B<id>,S...[FS]t,<timeout>`.
 * Throws RangeError if the message would reach FORM_REQUEST_LIMIT bytes.
 */
export function formRequest(
  form: string,
  options: {
    readonly texts?: Readonly<Record<string, string>>;
    readonly showButtons?: readonly string[];
    readonly timeout?: number;
  } = {},
): FormRequest {
  let body: FormRequest = `24.${form}`;
  for (const [id, text] of Object.entries(options.texts ?? {})) body = `${body}${FS}T${id},${text}`;
  for (const id of options.showButtons ?? []) body = `${body}${FS}B${id},S`;
  if (options.timeout !== undefined) body = `${body}${FS}t,${options.timeout}`;
  if (body.length >= FORM_REQUEST_LIMIT) {
    throw new RangeError(`24.x request is ${body.length} bytes; it must stay under ${FORM_REQUEST_LIMIT}`);
  }
  return body;
}
