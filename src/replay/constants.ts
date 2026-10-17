import type {
  EventType,
  IncrementalSource,
  MouseInteractions,
} from "@rrweb/types";

/** Instrumentation scope of replay log records. @internal */
export const REPLAY_SCOPE_NAME = "rum.rr-web" as const;

/** Event number in the session, shared by all chunks of one rrweb event. @internal */
export const ATTR_RRWEB_EVENT = "rr-web.event" as const;

/** 1-based chunk index within the event. @internal */
export const ATTR_RRWEB_CHUNK = "rr-web.chunk" as const;

/** Number of chunks of the event. @internal */
export const ATTR_RRWEB_TOTAL_CHUNKS = "rr-web.total-chunks" as const;

/** Record number in the session over every chunk; the player orders by it. @internal */
export const ATTR_RRWEB_OFFSET = "rr-web.offset" as const;

/** Largest chunk body in UTF-8 bytes. @internal */
export const MAX_CHUNK_BYTES: number = 950 * 1024;

/** Replay recording stops for a session once it is this old. @internal */
export const MAX_REPLAY_PER_SESSION_MS: number = 4 * 60 * 60 * 1000;

// Copy rrweb's enum members to avoid a second copy in build
/* eslint-disable @typescript-eslint/no-unsafe-enum-assignment -- Literals stand in for rrweb's enum members on purpose (see above); the compiler still rejects a wrong value. */
/** @internal */
export const EVENT_FULL_SNAPSHOT: EventType.FullSnapshot = 2;
/** @internal */
export const EVENT_INCREMENTAL_SNAPSHOT: EventType.IncrementalSnapshot = 3;
/** @internal */
export const EVENT_META: EventType.Meta = 4;
/** @internal */
export const SOURCE_MUTATION: IncrementalSource.Mutation = 0;
/** @internal */
export const SOURCE_MOUSE_MOVE: IncrementalSource.MouseMove = 1;
/** @internal */
export const SOURCE_MOUSE_INTERACTION: IncrementalSource.MouseInteraction = 2;
/** @internal */
export const SOURCE_SCROLL: IncrementalSource.Scroll = 3;
/** @internal */
export const SOURCE_INPUT: IncrementalSource.Input = 5;
/** @internal */
export const SOURCE_TOUCH_MOVE: IncrementalSource.TouchMove = 6;
/** @internal */
export const SOURCE_DRAG: IncrementalSource.Drag = 12;
/** @internal */
export const MOUSE_FOCUS: MouseInteractions.Focus = 5;
/** @internal */
export const MOUSE_BLUR: MouseInteractions.Blur = 6;
/* eslint-enable @typescript-eslint/no-unsafe-enum-assignment -- End of the rrweb enum values. */
