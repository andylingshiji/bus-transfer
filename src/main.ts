import "./style.css";
import {
  applyTerminal,
  ctbDirections,
  fetchEtas,
  kmbDirections,
  loadRoutes,
  loadStops,
  resolveOperator,
  searchRoutes,
  type DirectionChoice,
  type EtaResult,
  type RouteHit,
  type StopRow,
} from "./api";
import { esc, hktClock, minutesLabel, opName } from "./format";
import {
  bufferMinutes,
  DEFAULT_WALK_MIN,
  displayGap,
  earliestConnection,
  sameLegPairs,
} from "./transfer";
import {
  addFavorite,
  clearFavoriteCookie,
  FAV_COOKIE,
  favoriteCookie,
  favoriteDetail,
  favoriteTitle,
  findFavorite,
  parseFavorites,
  removeFavorite,
  serializeFavorites,
  type Favorite,
} from "./favorites";

interface Leg {
  choice: DirectionChoice;
  board: StopRow;
  alight: StopRow;
  walkMinutes: number;
}

interface LegEta {
  board: EtaResult;
  alight: EtaResult;
}

type Screen = "search" | "direction" | "board" | "alight" | "journey" | "result";

const STORAGE = "bus-journey-v1";
const app = document.querySelector("#app") as HTMLElement;

const state: {
  screen: Screen;
  query: string;
  stopQuery: string;
  counts: { kmb: number; ctb: number } | null;
  notice: string;
  busy: string;
  choices: DirectionChoice[];
  choice: DirectionChoice | null;
  stops: StopRow[];
  board: StopRow | null;
  legs: Leg[];
  etas: LegEta[];
  refreshing: boolean;
  favorites: Favorite[];
  favNote: string;
  favError: boolean;
} = {
  screen: "search",
  query: "",
  stopQuery: "",
  counts: null,
  notice: "",
  busy: "",
  choices: [],
  choice: null,
  stops: [],
  board: null,
  legs: [],
  etas: [],
  refreshing: false,
  favorites: [],
  favNote: "",
  favError: false,
};

let timer = 0;
let inflight = false;
let token = 0;

function persist(): void {
  sessionStorage.setItem(STORAGE, JSON.stringify(state.legs));
}

function readCookie(name: string): string {
  const chunks = document.cookie ? document.cookie.split(/; */) : [];
  for (const chunk of chunks) {
    const cut = chunk.indexOf("=");
    if (cut < 0) continue;
    if (chunk.slice(0, cut) === name) return chunk.slice(cut + 1);
  }
  return "";
}

function loadFavorites(): void {
  state.favorites = parseFavorites(readCookie(FAV_COOKIE));
}

function writeFavorites(favs: Favorite[]): void {
  const secure = location.protocol === "https:";
  document.cookie = favs.length === 0 ? clearFavoriteCookie(secure) : favoriteCookie(serializeFavorites(favs), secure);
  state.favorites = favs;
}

function restore(): void {
  try {
    const raw = sessionStorage.getItem(STORAGE);
    if (!raw) return;
    const legs = JSON.parse(raw) as Leg[];
    if (!Array.isArray(legs)) return;
    state.legs = legs.map((leg) => ({
      ...leg,
      walkMinutes: Number.isFinite(leg.walkMinutes) ? leg.walkMinutes : DEFAULT_WALK_MIN,
    }));
    if (state.legs.length > 0) state.screen = "journey";
  } catch {
    /* a bad session value just starts a new journey */
  }
}

function render(keepScroll = false): void {
  const y = window.scrollY;
  const focus = document.activeElement;
  const focusId = focus instanceof HTMLElement ? focus.id : "";
  const caret =
    focus instanceof HTMLInputElement ? [focus.selectionStart ?? 0, focus.selectionEnd ?? 0] : null;
  app.innerHTML = shell(body());
  if (keepScroll) window.scrollTo(0, y);
  if (!focusId) return;
  const next = document.getElementById(focusId);
  if (next instanceof HTMLInputElement) {
    next.focus();
    if (caret) next.setSelectionRange(caret[0], caret[1]);
  }
}

function shell(inner: string): string {
  const back = state.screen === "search" && state.legs.length === 0 ? "" : `<button type="button" class="back" data-act="back">返回</button>`;
  return `<div class="shell">
    <header class="top">
      ${back}
      <div class="grow">
        <h1>轉車時間</h1>
        <p>${state.legs.length ? `已選 ${state.legs.length} 段` : "自選路線，看看轉車趕不趕得及"}</p>
      </div>
    </header>
    ${inner}
  </div>`;
}

function body(): string {
  if (!state.counts && !state.notice) {
    return `<main class="main"><p class="status">正在載入路線…</p></main>`;
  }
  switch (state.screen) {
    case "search":
      return searchView();
    case "direction":
      return directionView();
    case "board":
      return stopView("board");
    case "alight":
      return stopView("alight");
    case "journey":
      return journeyView();
    case "result":
      return resultView();
  }
}

function searchView(): string {
  const hits = state.counts ? searchRoutes(state.query) : [];
  const list = hits
    .map(
      (hit) => `<li><button type="button" class="choice" data-act="pick-route" data-feed="${hit.feed}" data-route="${esc(hit.route)}">
        <span class="op">${hit.feed === "ctb" ? "城巴" : "九巴／龍運"}</span>
        <span class="num">${esc(hit.route)}</span>
        <span class="hint">${esc(hit.hint)}</span>
      </button></li>`,
    )
    .join("");
  const counts = state.counts
    ? `<p class="note">九巴／龍運 ${state.counts.kmb} 條路線，城巴 ${state.counts.ctb} 條路線。</p>`
    : "";
  return `<main class="main">
    ${state.query.trim() ? "" : favoriteList()}
    <p class="lead">輸入路線號碼，再選擇方向和上落車站。</p>
    ${favStatus()}
    ${counts}
    <label class="field">路線號碼
      <input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="例如 1、N121、A11" value="${esc(state.query)}" ${state.counts ? "" : "disabled"} />
    </label>
    ${state.notice ? `<p class="status error">${esc(state.notice)}</p>` : ""}
    ${state.query && hits.length === 0 ? `<p class="status">找不到這條路線。</p>` : ""}
    <ul class="list" id="results">${list}</ul>
  </main>`;
}

function directionView(): string {
  const route = state.choices[0]?.route ?? "";
  const op = state.choices[0] ? opName(state.choices[0].operator) : "";
  const list = state.choices
    .map(
      (choice, index) => `<li><button type="button" class="choice" data-act="pick-dir" data-index="${index}">
        <span class="name">${esc(choice.label)}</span>
        <span class="hint">${esc(opName(choice.operator))} ${esc(choice.route)}</span>
      </button></li>`,
    )
    .join("");
  return `<main class="main">
    <p class="lead">${esc(op)} ${esc(route)}，選擇方向。方向以終點站表示。</p>
    ${state.busy ? `<p class="status">${esc(state.busy)}</p>` : ""}
    ${state.notice ? `<p class="status error">${esc(state.notice)}</p>` : ""}
    ${!state.busy && state.choices.length === 0 ? `<p class="status">這條路線暫時沒有方向資料。</p>` : ""}
    <ul class="list">${list}</ul>
  </main>`;
}

function stopView(which: "board" | "alight"): string {
  const choice = state.choice;
  const stops = filteredStops(which);
  const list = stops
    .map(
      (stop) => `<li><button type="button" class="choice row-stop" data-act="pick-stop" data-stop="${esc(stop.stopId)}" data-seq="${stop.seq}">
        <span class="seq">${stop.seq}</span>
        <span class="name">${esc(stop.nameTc)}</span>
      </button></li>`,
    )
    .join("");
  const title = which === "board" ? "選擇上車站" : "選擇落車站";
  const lead =
    which === "board"
      ? "落車站必須在上車站之後，所以這裡不列出尾站。"
      : `由「${state.board?.nameTc ?? ""}」開出之後的車站。`;
  return `<main class="main">
    <p class="lead">${choice ? `${esc(opName(choice.operator))} ${esc(choice.route)} ${esc(choice.label)}` : ""}</p>
    <h2 class="dir">${title}</h2>
    <p class="note">${esc(lead)}</p>
    ${state.busy ? `<p class="status">${esc(state.busy)}</p>` : ""}
    ${state.notice ? `<p class="status error">${esc(state.notice)}</p>` : ""}
    ${!state.busy && state.stops.length < 2 ? `<p class="status">這條路線沒有足夠車站。</p>` : ""}
    ${state.stops.length >= 2 ? `<label class="field">篩選車站<input id="stop-q" type="search" autocomplete="off" value="${esc(state.stopQuery)}" placeholder="輸入站名" /></label>` : ""}
    ${state.stops.length >= 2 && stops.length === 0 ? `<p class="status">沒有符合的車站。</p>` : ""}
    <ul class="list">${list}</ul>
  </main>`;
}

function filteredStops(which: "board" | "alight"): StopRow[] {
  if (state.stops.length === 0) return [];
  const lastSeq = state.stops[state.stops.length - 1].seq;
  const q = state.stopQuery.trim();
  return state.stops.filter((stop) => {
    if (which === "board" && stop.seq >= lastSeq) return false;
    if (which === "alight" && state.board && stop.seq <= state.board.seq) return false;
    if (!q) return true;
    return stop.nameTc.includes(q);
  });
}

function journeyView(): string {
  const cards = state.legs.map((leg, index) => {
    return `<article class="leg">
      <div class="leg-head">
        <span class="meta">第 ${index + 1} 段</span>
        <span class="meta">${esc(opName(leg.choice.operator))}</span>
      </div>
      <div class="route-no">${esc(leg.choice.route)}</div>
      <p class="dir">${esc(leg.choice.label)}</p>
      <p class="stops">${esc(leg.board.nameTc)} → ${esc(leg.alight.nameTc)}</p>
      <div class="actions">
        <button type="button" data-act="up" data-index="${index}" ${index === 0 ? "disabled" : ""}>上移</button>
        <button type="button" data-act="down" data-index="${index}" ${index === state.legs.length - 1 ? "disabled" : ""}>下移</button>
        <button type="button" class="danger" data-act="remove" data-index="${index}">刪除</button>
      </div>
    </article>`;
  }).join("");
  const empty = state.legs.length === 0 ? `<p class="status">還沒有車程。</p>` : "";
  return `<main class="main">${favoriteList()}${favStatus()}${empty}${cards}</main>
    <div class="footer">
      ${saveFavButton()}
      <button type="button" class="secondary" data-act="add">加一段車程</button>
      <button type="button" class="primary" data-act="finish" ${state.legs.length === 0 ? "disabled" : ""}>查看轉車時間</button>
    </div>`;
}

function resultView(): string {
  const refreshing = state.refreshing ? `<p class="status">更新中…</p>` : "";
  const parts = state.legs.map((leg, index) => {
    const transfer =
      index === 0
        ? ""
        : transferCard(state.legs[index - 1], leg, state.etas[index - 1], state.etas[index], index);
    return `${transfer}${legCard(leg, state.etas[index], index)}`;
  });
  return `<main class="main" id="result">
    ${refreshing}
    ${state.notice ? `<p class="status error">${esc(state.notice)}</p>` : ""}
    <p class="result-note">每 30 秒更新</p>
    ${parts.join("")}
    <p class="result-note">資料來自運輸署公開到站時間</p>
    ${favStatus()}
  </main>
  <div class="footer">
    ${saveFavButton()}
    <button type="button" class="secondary" data-act="refresh">重新整理</button>
    <button type="button" class="primary" data-act="back">返回修改</button>
  </div>`;
}

function legCard(leg: Leg, eta: LegEta | undefined, index: number): string {
  const board = eta ? etaBlock("上車", leg.board.nameTc, eta.board) : `<p class="status">正在查看到站時間…</p>`;
  const alight = eta ? etaBlock("落車", leg.alight.nameTc, eta.alight) : "";
  const pairs = eta ? sameLegPairs(eta.board.items, eta.alight.items) : [];
  const pairHtml =
    eta && eta.board.items.length > 0 && eta.alight.items.length > 0
      ? `<p class="estimate">${
          pairs.length
            ? pairs
                .map((pair) => `估計 ${esc(hktClock(pair.board))} 上車，${esc(hktClock(pair.alight))} 落車`)
                .join("<br />")
            : "這兩組到站時間未能按次序配對"
        }<br />未必是同一輛巴士</p>`
      : "";
  return `<article class="ride" data-leg="${index}">
    <div class="ride-top"><span>第 ${index + 1} 段</span><span>${esc(opName(leg.choice.operator))}</span></div>
    <p class="ride-no">${esc(leg.choice.route)}</p>
    <p class="ride-dest">${esc(leg.choice.label)}</p>
    <div class="fromto">
      <div class="ft">${board}</div>
      <div class="ft ft-end">${alight}</div>
    </div>
    ${pairHtml}
  </article>`;
}

function favoriteList(): string {
  if (state.favorites.length === 0) return "";
  const rows = state.favorites
    .map(
      (fav) => `<li class="fav-row">
        <button type="button" class="choice" data-act="use-fav" data-id="${esc(fav.id)}">
          <span class="num">${esc(favoriteTitle(fav))}</span>
          <span class="hint">${esc(favoriteDetail(fav))}</span>
        </button>
        <button type="button" class="fav-drop" data-act="drop-fav" data-id="${esc(fav.id)}">刪除</button>
      </li>`,
    )
    .join("");
  return `<section class="favs">
    <h2>常用</h2>
    <ul class="list">${rows}</ul>
  </section>`;
}

function saveFavButton(): string {
  if (state.legs.length === 0) return "";
  const saved = findFavorite(state.favorites, state.legs);
  return `<button type="button" class="fav-save" data-act="save-fav">${saved ? "已在常用" : "加入常用"}</button>`;
}

function favStatus(): string {
  if (!state.favNote) return "";
  return `<p class="status${state.favError ? " error" : ""}">${esc(state.favNote)}</p>`;
}

function minuteParts(iso: string, now: number): { num: string; unit: string } {
  const label = minutesLabel(iso, now);
  const matched = /^(\d+) 分鐘$/.exec(label);
  if (matched) return { num: matched[1], unit: "分鐘" };
  return { num: label, unit: "" };
}

function etaBlock(title: string, name: string, result: EtaResult): string {
  const now = Date.now();
  const rows = result.items
    .map((item) => {
      const face = minuteParts(item.eta, now);
      const unit = face.unit ? `<span>${esc(face.unit)}</span>` : "";
      const remark = item.remarkTc ? `<span class="remark">${esc(item.remarkTc)}</span>` : "";
      return `<div class="eta">
        <span class="mins"><b>${esc(face.num)}</b>${unit}</span>
        <span class="clock">${esc(hktClock(item.eta))}</span>
        ${remark}
      </div>`;
    })
    .join("");
  const body = result.error
    ? `<p class="empty" data-empty="1">${esc(result.error)}</p>`
    : result.items.length === 0
      ? `<p class="empty" data-empty="1">暫無班次</p>`
      : `<div class="eta-list">${rows}</div>`;
  const stamp = result.dataTimestamp ? `<p class="stamp">資料時間 ${esc(result.dataTimestamp)}</p>` : "";
  return `<div class="ft-body">
    <p class="ft-k">${title}</p>
    <p class="ft-name">${esc(name)}</p>
    ${body}
    ${stamp}
  </div>`;
}

function transferCard(prev: Leg, next: Leg, prevEta: LegEta | undefined, nextEta: LegEta | undefined, nextIndex: number): string {
  const index = nextIndex - 1;
  const same = prev.alight.stopId === next.board.stopId;
  const buffer = bufferMinutes(same, next.walkMinutes);
  const judged = judgeTransfer(prevEta, nextEta, prevEta?.alight.items ?? [], nextEta?.board.items ?? [], buffer);
  const bufferLine = same
    ? `<p class="xfer-buffer">同一車站 3 分鐘</p>`
    : `<label class="walk">步行
         <input class="walk" id="walk-${index}" data-walk="${index}" type="number" min="0" step="1" inputmode="numeric" value="${esc(String(next.walkMinutes))}" />
         <span>分鐘</span>
       </label>`;
  const gap = judged.gap ? `<p class="xfer-gap" data-gap="${index}">${esc(judged.gap)}</p>` : `<p class="xfer-gap" data-gap="${index}"></p>`;
  return `<section class="xfer ${judged.kind === "ok" ? "xfer-ok" : ""}" data-transfer="${index}" data-same="${same ? "1" : "0"}">
    <p class="xfer-status ${judged.kind}" data-verdict="${index}" data-kind="${judged.kind}">${esc(judged.status)}</p>
    ${bufferLine}
    ${gap}
  </section>`;
}

function patchVerdict(index: number): void {
  const next = state.legs[index + 1];
  const prev = state.legs[index];
  if (!next || !prev) return;
  const node = app.querySelector(`[data-verdict="${index}"]`);
  if (!(node instanceof HTMLElement)) return;
  const same = prev.alight.stopId === next.board.stopId;
  const buffer = bufferMinutes(same, next.walkMinutes);
  const judged = judgeTransfer(state.etas[index], state.etas[index + 1], state.etas[index]?.alight.items ?? [], state.etas[index + 1]?.board.items ?? [], buffer);
  node.className = `xfer-status ${judged.kind}`;
  node.dataset.kind = judged.kind;
  node.textContent = judged.status;
  const gap = app.querySelector(`[data-gap="${index}"]`);
  if (gap) gap.textContent = judged.gap;
  const section = app.querySelector(`[data-transfer="${index}"]`);
  if (section) section.classList.toggle("xfer-ok", judged.kind === "ok");
}

function judgeTransfer(
  prevEta: LegEta | undefined,
  nextEta: LegEta | undefined,
  alight: LegEta["alight"]["items"],
  board: LegEta["board"]["items"],
  buffer: number,
): { kind: "ok" | "no" | "empty"; status: string; gap: string } {
  if (!prevEta || !nextEta) return { kind: "empty", status: "正在查看到站時間…", gap: "" };
  if (prevEta.alight.error || nextEta.board.error) return { kind: "empty", status: "未能判斷能否轉車", gap: "" };
  if (alight.length === 0 || board.length === 0) return { kind: "empty", status: "未能判斷能否轉車", gap: "" };
  const hit = earliestConnection(alight, board, buffer);
  if (!hit) return { kind: "no", status: "未能接上", gap: "" };
  return {
    kind: "ok",
    status: "可以轉車",
    gap: `相差 ${displayGap(hit.gapMin, buffer)} 分鐘`,
  };
}

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
  if (!target) return;
  const act = target.dataset.act ?? "";
  if (state.busy && !["back", "save-fav", "drop-fav", "use-fav"].includes(act)) return;
  if (act === "back") return goBack();
  if (act === "retry") return void boot();
  if (act === "pick-route") return void pickRoute(target.dataset.feed === "ctb" ? "ctb" : "kmb", target.dataset.route ?? "");
  if (act === "pick-dir") return void pickDirection(Number(target.dataset.index));
  if (act === "pick-stop") return pickStop(target.dataset.stop ?? "", Number(target.dataset.seq));
  if (act === "add") return addLeg();
  if (act === "finish") return void finish();
  if (act === "remove") return removeLeg(Number(target.dataset.index));
  if (act === "up") return moveLeg(Number(target.dataset.index), -1);
  if (act === "down") return moveLeg(Number(target.dataset.index), 1);
  if (act === "refresh") return void loadResult();
  if (act === "save-fav") return saveFav();
  if (act === "use-fav") return useFav(target.dataset.id ?? "");
  if (act === "drop-fav") return dropFav(target.dataset.id ?? "");
});

app.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === "q") {
    state.query = target.value;
    render();
    return;
  }
  if (target.id === "stop-q") {
    state.stopQuery = target.value;
    render();
    return;
  }
  if (target.dataset.walk !== undefined) {
    const index = Number(target.dataset.walk);
    const value = Number(target.value);
    state.legs[index + 1].walkMinutes = Number.isFinite(value) && value >= 0 ? value : DEFAULT_WALK_MIN;
    persist();
    patchVerdict(index);
  }
});

function goBack(): void {
  token += 1;
  state.notice = "";
  state.favNote = "";
  state.favError = false;
  state.busy = "";
  disarm();
  if (state.screen === "result") {
    state.screen = "journey";
    render();
    return;
  }
  if (state.screen === "alight") {
    state.screen = "board";
    state.stopQuery = "";
    render();
    return;
  }
  if (state.screen === "board") {
    state.screen = "direction";
    state.stopQuery = "";
    render();
    return;
  }
  if (state.screen === "direction") {
    state.screen = "search";
    render();
    return;
  }
  if (state.screen === "journey" || (state.screen === "search" && state.legs.length > 0)) {
    if (state.screen === "search") {
      state.screen = "journey";
      render();
      return;
    }
  }
  state.screen = state.legs.length ? "journey" : "search";
  render();
}

function addLeg(): void {
  state.screen = "search";
  state.query = "";
  state.notice = "";
  state.favNote = "";
  state.favError = false;
  render();
}

function saveFav(): void {
  if (state.legs.length === 0) return;
  const result = addFavorite(state.favorites, state.legs, Date.now().toString(36));
  if (result.status === "full") {
    state.favNote = "常用最多 5 個，請先刪除一個";
    state.favError = true;
    render();
    return;
  }
  if (result.status === "too-big") {
    state.favNote = "這組路線太長，無法存入 cookie";
    state.favError = true;
    render();
    return;
  }
  writeFavorites(result.favorites);
  state.favNote = result.status === "added" ? "已加入常用" : "已更新常用";
  state.favError = false;
  render();
}

function useFav(id: string): void {
  const fav = state.favorites.find((item) => item.id === id);
  if (!fav) return;
  state.legs = fav.legs.map((leg) => ({
    choice: { ...leg.choice },
    board: { ...leg.board },
    alight: { ...leg.alight },
    walkMinutes: leg.walkMinutes,
  }));
  state.query = "";
  state.favNote = "";
  state.favError = false;
  state.notice = "";
  persist();
  void finish();
}

function dropFav(id: string): void {
  writeFavorites(removeFavorite(state.favorites, id));
  state.favNote = "";
  state.favError = false;
  render();
}

async function pickRoute(feed: RouteHit["feed"], route: string): Promise<void> {
  if (!route) return;
  const mine = ++token;
  state.notice = "";
  state.choices = [];
  state.busy = "正在讀取方向…";
  state.screen = "direction";
  render();
  try {
    const choices = feed === "kmb" ? kmbDirections(route) : await ctbDirections(route);
    if (mine !== token) return;
    state.choices = choices;
    state.busy = "";
    render();
    if (feed === "kmb" && choices.length > 0) {
      const operator = await resolveOperator(choices[0]);
      if (mine !== token || state.screen !== "direction") return;
      state.choices = state.choices.map((choice) => ({ ...choice, operator }));
      render();
    }
  } catch {
    if (mine !== token) return;
    state.busy = "";
    state.notice = "無法讀取方向，請再試一次";
    render();
  }
}

async function pickDirection(index: number): Promise<void> {
  const choice = state.choices[index];
  if (!choice) return;
  const mine = ++token;
  state.notice = "";
  state.busy = "正在讀取車站…";
  state.choice = choice;
  state.stops = [];
  state.board = null;
  state.stopQuery = "";
  state.screen = "board";
  render();
  try {
    const [stops, operator] = await Promise.all([loadStops(choice), resolveOperator(choice)]);
    if (mine !== token) return;
    let next = applyTerminal({ ...choice, operator }, stops);
    if (choice.label.includes("由") && !next.label.includes("由")) {
      next = { ...next, label: `由${next.origTc} ${next.label}` };
    }
    state.choice = next;
    state.stops = stops;
    state.busy = "";
    render();
  } catch {
    if (mine !== token) return;
    state.busy = "";
    state.notice = "無法讀取車站，請再試一次";
    render();
  }
}

function pickStop(stopId: string, seq: number): void {
  const stop = state.stops.find((row) => row.stopId === stopId && row.seq === seq);
  const choice = state.choice;
  if (!stop || !choice) return;
  if (state.screen === "board") {
    state.board = stop;
    state.stopQuery = "";
    state.screen = "alight";
    render();
    return;
  }
  if (!state.board || stop.seq <= state.board.seq) return;
  state.legs.push({
    choice,
    board: state.board,
    alight: stop,
    walkMinutes: DEFAULT_WALK_MIN,
  });
  state.board = null;
  state.choice = null;
  state.stops = [];
  state.stopQuery = "";
  state.screen = "journey";
  persist();
  render();
}

function removeLeg(index: number): void {
  state.legs.splice(index, 1);
  persist();
  render();
}

function moveLeg(index: number, delta: number): void {
  const next = index + delta;
  if (next < 0 || next >= state.legs.length) return;
  const [leg] = state.legs.splice(index, 1);
  state.legs.splice(next, 0, leg);
  persist();
  render();
}

async function finish(): Promise<void> {
  if (state.legs.length === 0) return;
  state.screen = "result";
  state.etas = [];
  state.notice = "";
  render();
  arm();
  await loadResult();
}

async function loadResult(): Promise<void> {
  if (inflight || state.screen !== "result") return;
  inflight = true;
  const keep = state.etas.length > 0;
  state.refreshing = keep;
  if (!keep) state.busy = "正在查看到站時間…";
  render(keep);
  const mine = ++token;
  try {
    const etas = await Promise.all(
      state.legs.map(async (leg) => ({
        board: await fetchEtas(leg.choice, leg.board.stopId, leg.board.seq),
        alight: await fetchEtas(leg.choice, leg.alight.stopId, leg.alight.seq),
      })),
    );
    if (mine !== token || state.screen !== "result") return;
    state.etas = etas;
    state.notice = "";
  } catch {
    if (mine === token) state.notice = "無法更新到站時間";
  } finally {
    inflight = false;
    state.refreshing = false;
    state.busy = "";
    if (state.screen === "result") render(keep);
  }
}

function arm(): void {
  disarm();
  timer = window.setInterval(() => {
    if (state.screen === "result") void loadResult();
  }, 30000);
}

function disarm(): void {
  window.clearInterval(timer);
  timer = 0;
}

async function boot(): Promise<void> {
  state.notice = "";
  state.busy = "";
  render();
  try {
    state.counts = await loadRoutes();
    state.notice = "";
  } catch {
    state.notice = "無法載入路線，請再試一次";
    app.innerHTML = `<div class="shell"><header class="top"><div><h1>轉車時間</h1></div></header><main class="main"><p class="status error">無法載入路線，請再試一次</p><button type="button" class="primary" data-act="retry">重試</button></main></div>`;
    return;
  }
  render();
}

loadFavorites();
restore();
void boot();
