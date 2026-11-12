import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const shot = "/cursor/stores/bc-01a1b1fb-2119-71df-9503-8ddd24dc534e/media/journey-result.png";
const base = "http://127.0.0.1:5173/";

const legs = [
  {
    feed: "kmb",
    route: "N691",
    board: "4E279C21A109E9E3",
    alight: "633A3F4B4A5637C2",
  },
  {
    feed: "kmb",
    route: "N121",
    board: "633A3F4B4A5637C2",
    alight: "50C82DFB0AC97FC8",
  },
  {
    feed: "kmb",
    route: "1",
    board: "18492910339410B1",
    alight: "9ED7E93749ABAE67",
  },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-HK"],
});

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const errors = [];
const etaHits = [];
page.on("pageerror", (err) => errors.push(String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("response", (res) => {
  if (res.status() >= 400) errors.push(`${res.status()} ${res.url()}`);
});
page.on("request", (req) => {
  if (req.url().includes("/eta/")) etaHits.push(req.url());
});

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("條路線"), { timeout: 60000 });

  for (const leg of legs) {
    if (await page.$("[data-act='add']")) {
      await page.click("[data-act='add']");
    }
    await page.waitForSelector("#q");
    await page.$eval("#q", (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, leg.route);
    const routeSel = `[data-act="pick-route"][data-feed="${leg.feed}"][data-route="${leg.route}"]`;
    await page.waitForSelector(routeSel, { timeout: 15000 });
    await page.click(routeSel);
    await page.waitForSelector("[data-act='pick-dir']", { timeout: 90000 });
    await page.click("[data-act='pick-dir'][data-index='0']");
    await page.waitForSelector(`[data-act="pick-stop"][data-stop="${leg.board}"]`, { timeout: 90000 });
    await page.click(`[data-act="pick-stop"][data-stop="${leg.board}"]`);
    await page.waitForSelector(`[data-act="pick-stop"][data-stop="${leg.alight}"]`, { timeout: 20000 });
    await page.click(`[data-act="pick-stop"][data-stop="${leg.alight}"]`);
    await page.waitForSelector("[data-act='finish']");
  }

  const beforeFinish = etaHits.length;
  await page.click("[data-act='finish']");
  await page.waitForSelector("#result", { timeout: 20000 });
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    const loading = text.includes("正在查看到站時間");
    return !loading && document.querySelectorAll(".clock").length > 0 && document.querySelectorAll("[data-empty='1']").length > 0 && text.includes("同一車站");
  }, { timeout: 60000 });

  const report = await page.evaluate(() => {
    const text = document.body.innerText;
    const transfers = [...document.querySelectorAll("[data-transfer]")].map((node) => ({
      same: node.getAttribute("data-same"),
      kind: node.querySelector("[data-kind]")?.getAttribute("data-kind") || "",
      text: node.innerText,
    }));
    return {
      text,
      transfers,
      walks: [...document.querySelectorAll("input.walk")].map((el) => el.value),
      clocks: [...document.querySelectorAll(".clock")].map((el) => el.textContent),
      english: /Star Ferry|boarding|alight/i.test(text),
    };
  });

  if (report.english) throw new Error("English passenger copy appeared");
  if (report.transfers.length !== 2) throw new Error(`expected 2 transfers, got ${report.transfers.length}`);
  if (report.transfers[0].same !== "1") throw new Error(`first transfer should be the same stop: ${report.transfers[0].text}`);
  if (!report.transfers[0].text.includes("同一車站，預留 3 分鐘")) throw new Error(report.transfers[0].text);
  if (report.transfers[1].same !== "0") throw new Error("second transfer should be different stops");
  if (!report.transfers[1].text.includes("暫無班次，未能判斷能否轉車")) throw new Error(report.transfers[1].text);
  if (report.walks.length !== 1 || report.walks[0] !== "5") throw new Error(`walk defaults ${report.walks.join(",")}`);
  if (report.clocks.length < 1) throw new Error("expected at least one arrival time");
  if (!report.text.includes("九巴")) throw new Error("missing 九巴");
  if (!report.text.includes("上車站") || !report.text.includes("落車站")) throw new Error("missing stop labels");

  await page.$eval("input.walk", (el) => {
    el.value = "12";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const walked = await page.$eval("input.walk", (el) => el.value);
  if (walked !== "12") throw new Error(`walk edit became ${walked}`);

  const etaBeforeRefresh = etaHits.length;
  await page.click("[data-act='refresh']");
  await page.waitForFunction(
    (n) => document.body.innerText.includes("暫無班次") && document.body.innerText.includes("同一車站"),
    { timeout: 60000 },
    etaBeforeRefresh,
  );
  await page.waitForFunction(() => true);
  const grew = await page.waitForFunction((n) => window.__noop, { timeout: 1000 }).catch(() => null);
  void grew;
  const deadline = Date.now() + 20000;
  while (etaHits.length <= etaBeforeRefresh && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (etaHits.length <= etaBeforeRefresh) throw new Error("refresh did not request ETAs");
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return text.includes("同一車站") && text.includes("暫無班次") && !text.includes("更新中");
  }, { timeout: 60000 });
  const walkedAfter = await page.$eval("input.walk", (el) => el.value);
  if (walkedAfter !== "12") throw new Error(`walk reset to ${walkedAfter}`);

  await mkdir("/cursor/stores/bc-01a1b1fb-2119-71df-9503-8ddd24dc534e/media", { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });

  const opened = Date.now();
  const etaAtShot = etaHits.length;
  while (Date.now() - opened < 32000 && etaHits.length === etaAtShot) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const auto = etaHits.length > etaAtShot;

  console.log(JSON.stringify({
    transfers: report.transfers.map((t) => ({ same: t.same, kind: t.kind, text: t.text.replaceAll("\n", " | ") })),
    clocks: report.clocks,
    walks: report.walks,
    etaRequestsBeforeFinish: beforeFinish,
    etaRequests: etaHits.length,
    autoRefresh: auto,
    errors,
  }, null, 2));
  if (errors.length) throw new Error(errors.join("\n"));
  if (!auto) throw new Error("30 second refresh did not request ETAs");
} catch (err) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  console.error("PAGE TEXT:\n", text.slice(0, 2500));
  console.error("ERRORS", errors);
  throw err;
} finally {
  await browser.close();
}
