import type { Attributes } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace";
import {
  ATTR_USER_EMAIL,
  ATTR_USER_FULL_NAME,
  ATTR_USER_ID,
  ATTR_USER_NAME,
  ATTR_USER_ROLES,
} from "../semconv.ts";

/**
 * The signed-in user, recorded with the standard `user.*` attributes.
 *
 * @public
 */
export interface User {
  /** Stable identifier, recorded as `user.id`. */
  id?: string | undefined;
  /** Email address, recorded as `user.email`. */
  email?: string | undefined;
  /** Short name or login, recorded as `user.name`. */
  name?: string | undefined;
  /** Full name, recorded as `user.full_name`. */
  fullName?: string | undefined;
  /** Roles, recorded as `user.roles`. */
  roles?: string[] | undefined;
}

let userAttributes: Attributes = {};

/**
 * Sets the user recorded on every span and log record emitted from now on, replacing the previous
 * user. Works before `init`. Replay records carry no user attributes.
 *
 * @param user - The user, or `null` to stop recording user attributes. Empty fields are left out.
 * @public
 */
export function setUser(user: User | null): void {
  const next: Attributes = {};
  if (user?.id) {
    next[ATTR_USER_ID] = user.id;
  }
  if (user?.email) {
    next[ATTR_USER_EMAIL] = user.email;
  }
  if (user?.name) {
    next[ATTR_USER_NAME] = user.name;
  }
  if (user?.fullName) {
    next[ATTR_USER_FULL_NAME] = user.fullName;
  }
  if (user?.roles?.length) {
    next[ATTR_USER_ROLES] = [...user.roles];
  }

  userAttributes = next;
}

/**
 * Adds the current user attributes to every span when it starts.
 *
 * @internal
 */
export const userSpanProcessor: SpanProcessor = {
  onStart: (span) => {
    span.setAttributes(userAttributes);
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/**
 * Adds the current user attributes to every log record when it is emitted.
 *
 * @internal
 */
export const userLogRecordProcessor: LogRecordProcessor = {
  onEmit: (logRecord) => {
    logRecord.setAttributes(userAttributes);
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
