export type Feed = "kmb" | "ctb";
export type Direction = "O" | "I";
export type Operator = "KMB" | "LWB" | "CTB" | "KMBLWB";

export interface RouteHit {
  feed: Feed;
  route: string;
  hint: string;
}

export interface DirectionChoice {
  feed: Feed;
  operator: Operator;
  route: string;
  direction: Direction;
  serviceType: string;
  origTc: string;
  destTc: string;
  label: string;
}

export interface StopRow {
  stopId: string;
  seq: number;
  nameTc: string;
}

export interface EtaItem {
  eta: string;
  remarkTc: string;
  dataTimestamp: string;
}

export interface EtaResult {
  items: EtaItem[];
  dataTimestamp: string;
  error: string;
}

interface KmbRoute {
  route: string;
  bound: Direction;
  service_type: string;
  orig_tc: string;
  dest_tc: string;
}

interface CtbRoute {
  route: string;
  orig_tc: string;
  dest_tc: string;
}

interface EtaRow {
  co?: string;
  dir?: Direction;
  service_type?: string | number;
  seq?: string | number;
  eta?: string | null;
  eta_seq?: number;
  rmk_tc?: string;
  data_timestamp?: string;
}

const KMB = "https://data.etabus.gov.hk/v1/transport/kmb";
const CTB = "https://rt.data.gov.hk/v2/transport/citybus";

let kmbRoutes: KmbRoute[] = [];
let ctbRoutes: CtbRoute[] = [];
const stopNames = new Map<string, string>();
const stopLists = new Map<string, StopRow[]>();

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function loadRoutes(): Promise<{ kmb: number; ctb: number }> {
  const [kmb, ctb] = await Promise.all([
    getJson<{ data: KmbRoute[] }>(`${KMB}/route/`),
    getJson<{ data: CtbRoute[] }>(`${CTB}/route/CTB`),
  ]);
  kmbRoutes = kmb.data ?? [];
  ctbRoutes = ctb.data ?? [];
  return {
    kmb: new Set(kmbRoutes.map((r) => r.route)).size,
    ctb: new Set(ctbRoutes.map((r) => r.route)).size,
  };
}

export function searchRoutes(raw: string): RouteHit[] {
  const q = raw.trim().toUpperCase();
  if (!q) return [];
  const hits: { hit: RouteHit; score: number }[] = [];

  const kmbByRoute = new Map<string, KmbRoute[]>();
  for (const row of kmbRoutes) {
    const list = kmbByRoute.get(row.route);
    if (list) list.push(row);
    else kmbByRoute.set(row.route, [row]);
  }
  for (const [route, rows] of kmbByRoute) {
    const score = rank(route, q);
    if (score === 99) continue;
    const dests = unique(rows.map((r) => r.dest_tc)).slice(0, 3);
    hits.push({
      score,
      hit: { feed: "kmb", route, hint: dests.map((d) => `往${d}`).join("、") },
    });
  }
  for (const row of ctbRoutes) {
    const score = rank(row.route, q);
    if (score === 99) continue;
    hits.push({
      score,
      hit: { feed: "ctb", route: row.route, hint: `往${row.dest_tc}` },
    });
  }
  hits.sort((a, b) => a.score - b.score || a.hit.route.length - b.hit.route.length || a.hit.route.localeCompare(b.hit.route) || a.hit.feed.localeCompare(b.hit.feed));
  return hits.slice(0, 40).map((h) => h.hit);
}

function rank(route: string, q: string): number {
  const value = route.toUpperCase();
  if (value === q) return 0;
  if (value.startsWith(q)) return 1;
  if (value.includes(q)) return 2;
  return 99;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function kmbDirections(route: string): DirectionChoice[] {
  const rows = kmbRoutes.filter((r) => r.route === route);
  const choices: DirectionChoice[] = rows.map((r) => ({
    feed: "kmb",
    operator: "KMBLWB",
    route,
    direction: r.bound,
    serviceType: String(r.service_type),
    origTc: r.orig_tc,
    destTc: r.dest_tc,
    label: "",
  }));
  choices.sort((a, b) => dirOrder(a.direction) - dirOrder(b.direction) || Number(a.serviceType) - Number(b.serviceType));
  return labelChoices(choices);
}

export async function ctbDirections(route: string): Promise<DirectionChoice[]> {
  const record = ctbRoutes.find((r) => r.route === route);
  const loaded = await Promise.all(
    (["O", "I"] as Direction[]).map(async (direction) => {
      const choice: DirectionChoice = {
        feed: "ctb",
        operator: "CTB",
        route,
        direction,
        serviceType: "1",
        origTc: record?.orig_tc ?? "",
        destTc: record?.dest_tc ?? "",
        label: "",
      };
      const stops = await loadStops(choice);
      return { direction, stops };
    }),
  );
  const choices: DirectionChoice[] = [];
  for (const { direction, stops } of loaded) {
    if (stops.length < 2) continue;
    const last = stops[stops.length - 1].nameTc;
    const first = stops[0].nameTc;
    choices.push({
      feed: "ctb",
      operator: "CTB",
      route,
      direction,
      serviceType: "1",
      origTc: first || record?.orig_tc || "",
      destTc: last || (direction === "O" ? record?.dest_tc ?? "" : record?.orig_tc ?? ""),
      label: "",
    });
  }
  return labelChoices(choices);
}

function dirOrder(direction: Direction): number {
  return direction === "O" ? 0 : 1;
}

function labelChoices(rows: DirectionChoice[]): DirectionChoice[] {
  const destCount = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.direction}|${row.destTc}`;
    destCount.set(key, (destCount.get(key) ?? 0) + 1);
  }
  const labeled = rows.map((row) => {
    const crowded = (destCount.get(`${row.direction}|${row.destTc}`) ?? 0) > 1;
    const label = crowded ? `由${row.origTc} 往${row.destTc}` : `往${row.destTc}`;
    return { ...row, label };
  });
  const labelCount = new Map<string, number>();
  for (const row of labeled) labelCount.set(row.label, (labelCount.get(row.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return labeled.map((row) => {
    if ((labelCount.get(row.label) ?? 0) < 2) return row;
    const n = (seen.get(row.label) ?? 0) + 1;
    seen.set(row.label, n);
    if (n === 1) return row;
    return { ...row, label: `${row.label}（另一走線）` };
  });
}

export async function resolveOperator(choice: DirectionChoice): Promise<Operator> {
  if (choice.feed === "ctb") return "CTB";
  try {
    const body = await getJson<{ data: EtaRow[] }>(
      `${KMB}/route-eta/${encodeURIComponent(choice.route)}/${encodeURIComponent(choice.serviceType)}`,
    );
    const cos = new Set(
      (body.data ?? [])
        .filter((row) => row.dir === choice.direction && String(row.service_type) === choice.serviceType)
        .map((row) => row.co)
        .filter(Boolean),
    );
    if (cos.size === 1 && cos.has("LWB")) return "LWB";
    if (cos.size === 1 && cos.has("KMB")) return "KMB";
    if (cos.has("LWB") && !cos.has("KMB")) return "LWB";
    if (cos.has("KMB") && !cos.has("LWB")) return "KMB";
  } catch {
    /* keep the joint label */
  }
  return "KMBLWB";
}

export async function loadStops(choice: DirectionChoice): Promise<StopRow[]> {
  const key = `${choice.feed}|${choice.route}|${choice.direction}|${choice.serviceType}`;
  const cached = stopLists.get(key);
  if (cached) return cached;
  const word = choice.direction === "O" ? "outbound" : "inbound";
  const url =
    choice.feed === "kmb"
      ? `${KMB}/route-stop/${encodeURIComponent(choice.route)}/${word}/${encodeURIComponent(choice.serviceType)}`
      : `${CTB}/route-stop/CTB/${encodeURIComponent(choice.route)}/${word}`;
  const body = await getJson<{ data: { stop: string; seq: string | number }[] }>(url);
  const raw = (body.data ?? []).map((row) => ({ stopId: row.stop, seq: Number(row.seq) }));
  raw.sort((a, b) => a.seq - b.seq);
  const names = await pool(raw, 8, async (row) => stopName(choice.feed, row.stopId));
  const stops = raw.map((row, i) => ({ ...row, nameTc: names[i] || row.stopId }));
  stopLists.set(key, stops);
  return stops;
}

async function stopName(feed: Feed, stopId: string): Promise<string> {
  const key = `${feed}|${stopId}`;
  const cached = stopNames.get(key);
  if (cached) return cached;
  const url = feed === "kmb" ? `${KMB}/stop/${stopId}` : `${CTB}/stop/${stopId}`;
  try {
    const body = await getJson<{ data: { name_tc?: string } }>(url);
    const name = body.data?.name_tc?.trim() || stopId;
    stopNames.set(key, name);
    return name;
  } catch {
    return stopId;
  }
}

export function applyTerminal(choice: DirectionChoice, stops: StopRow[]): DirectionChoice {
  if (stops.length === 0) return choice;
  const last = stops[stops.length - 1].nameTc;
  const first = stops[0].nameTc;
  if (!last || last === choice.destTc) return { ...choice, origTc: first || choice.origTc };
  const next = { ...choice, destTc: last, origTc: first || choice.origTc, label: "" };
  return labelChoices([next])[0];
}

export async function fetchEtas(choice: DirectionChoice, stopId: string, stopSeq: number): Promise<EtaResult> {
  const url =
    choice.feed === "kmb"
      ? `${KMB}/eta/${stopId}/${encodeURIComponent(choice.route)}/${encodeURIComponent(choice.serviceType)}`
      : `${CTB}/eta/CTB/${stopId}/${encodeURIComponent(choice.route)}`;
  try {
    const body = await getJson<{ data: EtaRow[]; generated_timestamp?: string }>(url);
    const rows = (body.data ?? []).filter((row) => {
      if (row.dir !== choice.direction) return false;
      if (choice.feed === "kmb" && String(row.service_type) !== choice.serviceType) return false;
      if (row.seq != null && row.seq !== "" && Number(row.seq) !== stopSeq) return false;
      return true;
    });
    const dataTimestamp = rows.find((row) => row.data_timestamp)?.data_timestamp || body.generated_timestamp || "";
    const items = rows
      .filter((row): row is EtaRow & { eta: string } => typeof row.eta === "string" && row.eta.length > 0)
      .map((row) => ({
        eta: row.eta,
        remarkTc: row.rmk_tc ?? "",
        dataTimestamp: row.data_timestamp || dataTimestamp,
      }))
      .sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta))
      .slice(0, 3);
    return { items, dataTimestamp, error: "" };
  } catch {
    return { items: [], dataTimestamp: "", error: "無法取得這個站的到站時間" };
  }
}
