import type { Direction, DirectionChoice, Feed, Operator, StopRow } from "./api";

export const FAV_COOKIE = "bus-fav";
export const MAX_FAVORITES = 5;
const MAX_COOKIE_CHARS = 4000;

export interface FavoriteLeg {
  choice: DirectionChoice;
  board: StopRow;
  alight: StopRow;
  walkMinutes: number;
}

export interface Favorite {
  id: string;
  legs: FavoriteLeg[];
}

type PackedLeg = {
  f: Feed;
  o: Operator;
  r: string;
  d: Direction;
  s: string;
  lb: string;
  bi: string;
  bs: number;
  bn: string;
  ai: string;
  as: number;
  an: string;
  w: number;
};

type Packed = { id: string; legs: PackedLeg[] };

export type SaveStatus = "added" | "updated" | "full" | "too-big";

const FEEDS = new Set<Feed>(["kmb", "ctb"]);
const OPERATORS = new Set<Operator>(["KMB", "LWB", "CTB", "KMBLWB"]);
const DIRECTIONS = new Set<Direction>(["O", "I"]);

export function favoriteTitle(fav: Favorite): string {
  return fav.legs.map((leg) => leg.choice.route).join(" → ");
}

export function favoriteDetail(fav: Favorite): string {
  return fav.legs.map((leg) => `${leg.board.nameTc} → ${leg.alight.nameTc}`).join("，");
}

export function sameJourney(a: FavoriteLeg[], b: FavoriteLeg[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((leg, index) => legKey(leg) === legKey(b[index]));
}

export function findFavorite(favs: Favorite[], legs: FavoriteLeg[]): Favorite | undefined {
  return favs.find((fav) => sameJourney(fav.legs, legs));
}

export function addFavorite(favs: Favorite[], legs: FavoriteLeg[], id: string): { status: SaveStatus; favorites: Favorite[] } {
  if (legs.length === 0) return { status: "too-big", favorites: favs };
  const existing = findFavorite(favs, legs);
  const nextLegs = legs.map(cloneLeg);
  let next: Favorite[];
  let status: SaveStatus;
  if (existing) {
    status = "updated";
    next = [{ id: existing.id, legs: nextLegs }, ...favs.filter((fav) => fav.id !== existing.id)];
  } else if (favs.length >= MAX_FAVORITES) {
    return { status: "full", favorites: favs };
  } else {
    status = "added";
    next = [{ id, legs: nextLegs }, ...favs];
  }
  if (cookieLength(serializeFavorites(next)) > MAX_COOKIE_CHARS) {
    return { status: "too-big", favorites: favs };
  }
  return { status, favorites: next };
}

export function removeFavorite(favs: Favorite[], id: string): Favorite[] {
  return favs.filter((fav) => fav.id !== id);
}

export function serializeFavorites(favs: Favorite[]): string {
  const packed: Packed[] = favs.map((fav) => ({
    id: fav.id,
    legs: fav.legs.map((leg) => ({
      f: leg.choice.feed,
      o: leg.choice.operator,
      r: leg.choice.route,
      d: leg.choice.direction,
      s: leg.choice.serviceType,
      lb: leg.choice.label,
      bi: leg.board.stopId,
      bs: leg.board.seq,
      bn: leg.board.nameTc,
      ai: leg.alight.stopId,
      as: leg.alight.seq,
      an: leg.alight.nameTc,
      w: leg.walkMinutes,
    })),
  }));
  return encodePayload(JSON.stringify(packed));
}

export function parseFavorites(raw: string): Favorite[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(decodePayload(raw)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const favs: Favorite[] = [];
    for (const item of parsed) {
      const fav = unpack(item);
      if (fav) favs.push(fav);
      if (favs.length === MAX_FAVORITES) break;
    }
    return favs;
  } catch {
    return [];
  }
}

export function favoriteCookie(serialized: string, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${FAV_COOKIE}=${serialized}; Path=/; Max-Age=31536000; SameSite=Lax${securePart}`;
}

export function clearFavoriteCookie(secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${FAV_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${securePart}`;
}

function cookieLength(serialized: string): number {
  return `${FAV_COOKIE}=${serialized}`.length;
}

function legKey(leg: FavoriteLeg): string {
  return [
    leg.choice.feed,
    leg.choice.route,
    leg.choice.direction,
    leg.choice.serviceType,
    leg.board.stopId,
    leg.board.seq,
    leg.alight.stopId,
    leg.alight.seq,
  ].join("|");
}

function cloneLeg(leg: FavoriteLeg): FavoriteLeg {
  return {
    choice: { ...leg.choice },
    board: { ...leg.board },
    alight: { ...leg.alight },
    walkMinutes: normalizeWalk(leg.walkMinutes),
  };
}

function unpack(item: unknown): Favorite | null {
  if (!item || typeof item !== "object") return null;
  const row = item as { id?: unknown; legs?: unknown };
  if (typeof row.id !== "string" || !row.id || !Array.isArray(row.legs) || row.legs.length === 0) return null;
  const legs: FavoriteLeg[] = [];
  for (const packed of row.legs) {
    const leg = unpackLeg(packed);
    if (!leg) return null;
    legs.push(leg);
  }
  return { id: row.id, legs };
}

function unpackLeg(item: unknown): FavoriteLeg | null {
  if (!item || typeof item !== "object") return null;
  const row = item as Partial<PackedLeg>;
  if (!FEEDS.has(row.f as Feed)) return null;
  if (!OPERATORS.has(row.o as Operator)) return null;
  if (!DIRECTIONS.has(row.d as Direction)) return null;
  if (typeof row.r !== "string" || !row.r) return null;
  if (typeof row.s !== "string" || !row.s) return null;
  if (typeof row.lb !== "string") return null;
  if (typeof row.bi !== "string" || !row.bi || typeof row.ai !== "string" || !row.ai) return null;
  if (typeof row.bn !== "string" || typeof row.an !== "string") return null;
  if (!Number.isFinite(row.bs) || !Number.isFinite(row.as)) return null;
  if (Number(row.as) <= Number(row.bs)) return null;
  return {
    choice: {
      feed: row.f as Feed,
      operator: row.o as Operator,
      route: row.r,
      direction: row.d as Direction,
      serviceType: row.s,
      origTc: "",
      destTc: "",
      label: row.lb,
    },
    board: { stopId: row.bi, seq: Number(row.bs), nameTc: row.bn },
    alight: { stopId: row.ai, seq: Number(row.as), nameTc: row.an },
    walkMinutes: normalizeWalk(row.w),
  };
}

function normalizeWalk(value: unknown): number {
  const walk = Number(value);
  if (!Number.isFinite(walk) || walk < 0) return 5;
  return walk;
}

function encodePayload(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodePayload(raw: string): string {
  const b64 = raw.replaceAll("-", "+").replaceAll("_", "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
