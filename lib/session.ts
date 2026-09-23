import { cookies } from "next/headers";
import { randomUUID } from "crypto";
import type { Store } from "./stores";

/**
 * Tracks each visitor's saved store list in memory, keyed by an anonymous
 * session id stored in a cookie. No database — this resets on server
 * restart, which is fine for a demo/single-instance deployment.
 */

const SESSION_COOKIE = "pwa_session";
const sessionStores = new Map<string, Store[]>();

/** Reads (or creates) the caller's session id and returns their saved stores. */
export async function getSession(): Promise<{ id: string; stores: Store[] }> {
  const cookieStore = await cookies();
  let id = cookieStore.get(SESSION_COOKIE)?.value;

  if (!id) {
    id = randomUUID();
    cookieStore.set(SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24, // 1 day
    });
  }

  return { id, stores: sessionStores.get(id) ?? [] };
}

export function setSessionStores(id: string, stores: Store[]): void {
  sessionStores.set(id, stores);
}
