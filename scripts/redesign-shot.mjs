import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const shot = "/cursor/stores/bc-01a1b1fb-2119-71df-9503-8ddd24dc534e/media/journey-result-redesign.png";
const base = "http://127.0.0.1:5173/";
const legs = [
  { feed: "kmb", route: "N691", board: "4E279C21A109E9E3", alight: "24627F9D79F25721" },
  { feed: "kmb", route: "N271", board: "67FC11E66080F9C2", alight: "5734545592215022" },
  { feed: "kmb", route: "1", board: "18492910339410B1", alight: "9ED7E93749ABAE67" },
];

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--lang=zh-HK"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("條路線"), { timeout: 60000 });

  for (const leg of legs) {
    if (await page.$("[data-act='add']")) await page.click("[data-act='add']");
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

  await page.click("[data-act='finish']");
  await page.waitForSelector("#result");
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    return !text.includes("正在查看到站時間") && text.includes("暫無班次") && text.includes("可以轉車") && document.querySelectorAll(".clock").length > 0;
  }, { timeout: 60000 });

  const report = await page.evaluate(() => {
    const ride = document.querySelector(".ride-no");
    const mins = document.querySelector(".mins b");
    const rideSize = ride ? parseFloat(getComputedStyle(ride).fontSize) : 0;
    const minSize = mins ? parseFloat(getComputedStyle(mins).fontSize) : 0;
    return {
      text: document.body.innerText,
      width: document.documentElement.clientWidth,
      rideSize,
      minSize,
      kinds: [...document.querySelectorAll("[data-kind]")].map((node) => node.getAttribute("data-kind")),
      gaps: [...document.querySelectorAll("[data-gap]")].map((node) => node.textContent),
      walks: [...document.querySelectorAll("input.walk")].map((el) => el.value),
      empties: document.querySelectorAll("[data-empty='1']").length,
    };
  });

  if (report.width !== 390) throw new Error(`width ${report.width}`);
  if (report.rideSize < 40) throw new Error(`route size ${report.rideSize}`);
  if (report.minSize < 20) throw new Error(`minute size ${report.minSize}`);
  if (!report.kinds.includes("ok") || !report.kinds.includes("empty")) throw new Error(report.kinds.join(","));
  if (!report.gaps.some((gap) => gap.includes("相差"))) throw new Error(`gaps ${report.gaps.join("|")}`);
  if (!report.text.includes("暫無班次") || !report.text.includes("未能判斷能否轉車")) throw new Error("missing empty state");
  if (!report.text.includes("步行")) throw new Error("missing walk buffer");
  if (report.walks.length < 1 || report.walks.some((value) => value !== "5")) throw new Error(`walks ${report.walks}`);
  if (report.empties < 1) throw new Error("no empty marker");
  if (errors.length) throw new Error(errors.join("\n"));

  await page.addStyleTag({ content: ".footer{position:static !important;background:transparent !important;}" });
  await mkdir("/cursor/stores/bc-01a1b1fb-2119-71df-9503-8ddd24dc534e/media", { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  console.log(JSON.stringify({ width: report.width, rideSize: report.rideSize, minSize: report.minSize, kinds: report.kinds, gaps: report.gaps, walks: report.walks, empties: report.empties }, null, 2));
} catch (err) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => "");
  console.error("PAGE TEXT:\n", text.slice(0, 3000));
  throw err;
} finally {
  await browser.close();
}
